import { LitElement, html, nothing, type PropertyValues, type TemplateResult } from 'lit';
import type { SectionElement } from '../shared/dom-helpers';
import { styles } from './kw-transformation-section.styles.js';
import { sectionGlowStyles } from '../shared/section-glow.styles.js';
import { sashSheet } from '../shared/sash-styles.js';
import { customElement, property, state } from 'lit/decorators.js';
import type { DataTableColumn, DataTableOptions } from '../components/kw-data-table.js';
import { getScrollY, maybeAutoScrollWhileDragging } from '../core/utils.js';
import { setResultsState } from '../core/results-state.js';
import { schedulePersist } from '../core/persistence.js';
import { __kustoGetChartDatasetsInDomOrder, __kustoCleanupSectionModeResizeObserver, __kustoRefreshAllDataSourceDropdowns } from '../core/section-factory.js';
import { renderChart as __kustoRenderChart } from '../shared/chart-renderer.js';
import {
	tokenizeExpr,
	parseExprToRpn,
	evalRpn,
	getRawCellValue,
	type ExprToken,
} from '../shared/transform-expr.js';
import { normalizeResultsColumnName } from '../shared/data-utils.js';
import '../components/kw-section-shell.js';


// ─── Types ────────────────────────────────────────────────────────────────────

export type TransformationType = 'derive' | 'summarize' | 'distinct' | 'pivot' | 'join';
export type JoinKind = 'inner' | 'leftouter' | 'rightouter' | 'fullouter' | 'leftanti' | 'rightanti' | 'leftsemi' | 'rightsemi';

export interface JoinKey {
	left: string;
	right: string;
}
export type TransformationMode = 'edit' | 'preview';

export interface DeriveColumn {
	name: string;
	expression: string;
}

export interface Aggregation {
	name: string;
	function: string;
	column: string;
}

/** Serialized shape for .kqlx persistence — must match KqlxSectionV1 transformation variant. */
export interface TransformationSectionData {
	id: string;
	type: 'transformation';
	name: string;
	mode: TransformationMode;
	expanded: boolean;
	dataSourceId?: string;
	transformationType?: string;
	distinctColumn?: string;
	deriveColumns?: DeriveColumn[];
	groupByColumns?: string[];
	aggregations?: Aggregation[];
	pivotRowKeyColumn?: string;
	pivotColumnKeyColumn?: string;
	pivotValueColumn?: string;
	pivotAggregation?: string;
	pivotMaxColumns?: number;
	joinRightDataSourceId?: string;
	joinKind?: string;
	joinKeys?: JoinKey[];
	joinOmitDuplicateColumns?: boolean;
	editorHeightPx?: number;
}

/** Data source entry from queries-container. */
interface DatasetEntry {
	id: string;
	label: string;
	columns: string[];
	rows: unknown[][];
}

// ─── SVG icon constants ───────────────────────────────────────────────────────


const SVG_PLUS = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><path d="M8 3.2v9.6"/><path d="M3.2 8h9.6"/></svg>';
const SVG_TRASH = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><path d="M3 5h10"/><path d="M6 5V3.8c0-.4.3-.8.8-.8h2.4c.4 0 .8.3.8.8V5"/><path d="M5.2 5l.6 8.2c0 .5.4.8.8.8h3c.5 0 .8-.4.8-.8l.6-8.2"/><path d="M7 7.4v4.6"/><path d="M9 7.4v4.6"/></svg>';

const TRANSFORM_TYPE_ICONS: Record<string, string> = {
	derive: '<svg viewBox="0 0 32 32" width="32" height="32" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 24h20"/><path d="M10 24V8h12v16"/><path d="M12 12h8"/><path d="M12 16h8"/><path d="M12 20h8"/></svg>',
	summarize: '<svg viewBox="0 0 32 32" width="32" height="32" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 10h20"/><path d="M6 16h14"/><path d="M6 22h10"/><path d="M24 22v-8"/><path d="M21 17l3-3 3 3"/></svg>',
	distinct: '<svg viewBox="0 0 32 32" width="32" height="32" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 10h12"/><path d="M10 16h12"/><path d="M10 22h12"/><circle cx="8" cy="10" r="1.8"/><circle cx="8" cy="16" r="1.8"/><circle cx="8" cy="22" r="1.8"/></svg>',
	pivot: '<svg viewBox="0 0 32 32" width="32" height="32" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="6" width="20" height="20" rx="2"/><path d="M6 14h20"/><path d="M14 6v20"/><path d="M18 10h6"/><path d="M18 18h6"/></svg>',
	join: '<svg viewBox="0 0 32 32" width="32" height="32" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="16" r="7"/><circle cx="20" cy="16" r="7"/></svg>',
};

const TRANSFORM_TYPE_LABELS: Record<string, string> = {
	derive: 'Calculate',
	summarize: 'Summarize',
	distinct: 'Distinct',
	pivot: 'Pivot',
	join: 'Join',
};

const TRANSFORM_TYPES_ORDERED: TransformationType[] = ['derive', 'summarize', 'distinct', 'pivot', 'join'];

const AGG_FUNCTIONS = ['count', 'sum', 'avg', 'min', 'max', 'distinct'];

const PIVOT_AGG_FUNCTIONS = ['sum', 'avg', 'count', 'first'];

const JOIN_KINDS: JoinKind[] = ['inner', 'leftouter', 'rightouter', 'fullouter', 'leftanti', 'rightanti', 'leftsemi', 'rightsemi'];
const JOIN_KIND_LABELS: Record<JoinKind, string> = {
	inner: 'inner',
	leftouter: 'leftouter',
	rightouter: 'rightouter',
	fullouter: 'fullouter',
	leftanti: 'leftanti',
	rightanti: 'rightanti',
	leftsemi: 'leftsemi',
	rightsemi: 'rightsemi',
};
const JOIN_ROW_WARNING_THRESHOLD = 100_000;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function esc(s: unknown): string {
	return String(s ?? '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

window.transformationStateByBoxId = window.transformationStateByBoxId || {};
window.__kustoTransformationBoxes = window.__kustoTransformationBoxes || [];
const transformationStateByBoxId = window.transformationStateByBoxId;
export const transformationBoxes: string[] = window.__kustoTransformationBoxes;

export function __kustoGetTransformationState(boxId: unknown): Record<string, unknown> {
	try {
		const id = String(boxId || '');
		if (!id) return { mode: 'edit', expanded: true };
		if (!transformationStateByBoxId[id] || typeof transformationStateByBoxId[id] !== 'object') {
			transformationStateByBoxId[id] = {
				mode: 'edit',
				expanded: true,
				dataSourceId: '',
				transformationType: 'derive',
				deriveColumns: [{ name: '', expression: '' }],
				deriveColumnName: '',
				deriveExpression: '',
				distinctColumn: '',
				groupByColumns: [],
				aggregations: [{ function: 'count', column: '' }],
				pivotRowKeyColumn: '',
				pivotColumnKeyColumn: '',
				pivotValueColumn: '',
				pivotAggregation: 'sum',
				pivotMaxColumns: 100,
				joinRightDataSourceId: '',
				joinKind: 'inner',
				joinKeys: [{ left: '', right: '' }],
				joinOmitDuplicateColumns: true,
			};
		}
		const st = transformationStateByBoxId[id] as any;
		if (!Array.isArray(st.deriveColumns) || st.deriveColumns.length === 0) {
			const n = typeof st.deriveColumnName === 'string' ? st.deriveColumnName : '';
			const e = typeof st.deriveExpression === 'string' ? st.deriveExpression : '';
			st.deriveColumns = [{ name: n || '', expression: e || '' }];
		}
		return st;
	} catch {
		return { mode: 'edit', expanded: true };
	}
}

export function __kustoUpdateTransformationBuilderUI(boxId: unknown): void {
	const id = String(boxId || '');
	if (!id) return;
	try {
		const el = document.getElementById(id) as any;
		if (el && typeof el.refreshDataSources === 'function') {
			el.refreshDataSources();
		} else if (el && typeof el.refresh === 'function') {
			// Backward-compat fallback for older component instances.
			el.refresh();
		}
	} catch (e) { console.error('[kusto]', e); }
}

export function __kustoRenderTransformation(boxId: unknown): void {
	const id = String(boxId || '');
	if (!id) return;
	try {
		const el = document.getElementById(id) as any;
		if (el && typeof el.refresh === 'function') {
			el.refresh();
		}
	} catch (e) { console.error('[kusto]', e); }
}

// ─── Component ────────────────────────────────────────────────────────────────

@customElement('kw-transformation-section')
export class KwTransformationSection extends LitElement implements SectionElement {
	public static addTransformationBox(options: Record<string, unknown> = {}): string {
		const id = (typeof options.id === 'string' && options.id) ? String(options.id) : ('transformation_' + Date.now());
		transformationBoxes.push(id);
		const st = __kustoGetTransformationState(id) as any;

		st.mode = (typeof options.mode === 'string' && String(options.mode).toLowerCase() === 'preview') ? 'preview' : 'edit';
		st.expanded = typeof options.expanded === 'boolean' ? !!options.expanded : true;
		st.dataSourceId = typeof options.dataSourceId === 'string' ? String(options.dataSourceId) : (st.dataSourceId || '');
		st.transformationType = typeof options.transformationType === 'string' ? String(options.transformationType) : (st.transformationType || 'derive');
		st.distinctColumn = typeof options.distinctColumn === 'string' ? String(options.distinctColumn) : (st.distinctColumn || '');
		st.deriveColumns = Array.isArray(options.deriveColumns)
			? options.deriveColumns
			: (Array.isArray(st.deriveColumns) ? st.deriveColumns : [{ name: '', expression: '' }]);
		if (!Array.isArray(options.deriveColumns) && (typeof options.deriveColumnName === 'string' || typeof options.deriveExpression === 'string')) {
			const n = typeof options.deriveColumnName === 'string' ? String(options.deriveColumnName) : '';
			const e = typeof options.deriveExpression === 'string' ? String(options.deriveExpression) : '';
			st.deriveColumns = [{ name: n, expression: e }];
		}
		const first = Array.isArray(st.deriveColumns) && st.deriveColumns.length ? st.deriveColumns[0] : { name: '', expression: '' };
		st.deriveColumnName = String((first && first.name) || '');
		st.deriveExpression = String((first && first.expression) || '');
		st.groupByColumns = Array.isArray(options.groupByColumns)
			? options.groupByColumns.filter((c: unknown) => c)
			: (Array.isArray(st.groupByColumns) ? st.groupByColumns : []);
		st.aggregations = Array.isArray(options.aggregations)
			? options.aggregations
			: (Array.isArray(st.aggregations) ? st.aggregations : [{ function: 'count', column: '' }]);
		st.pivotRowKeyColumn = typeof options.pivotRowKeyColumn === 'string' ? String(options.pivotRowKeyColumn) : (st.pivotRowKeyColumn || '');
		st.pivotColumnKeyColumn = typeof options.pivotColumnKeyColumn === 'string' ? String(options.pivotColumnKeyColumn) : (st.pivotColumnKeyColumn || '');
		st.pivotValueColumn = typeof options.pivotValueColumn === 'string' ? String(options.pivotValueColumn) : (st.pivotValueColumn || '');
		st.pivotAggregation = typeof options.pivotAggregation === 'string' ? String(options.pivotAggregation) : (st.pivotAggregation || 'sum');
		st.pivotMaxColumns = (typeof options.pivotMaxColumns === 'number' && Number.isFinite(options.pivotMaxColumns))
			? options.pivotMaxColumns
			: (typeof st.pivotMaxColumns === 'number' ? st.pivotMaxColumns : 100);
		st.joinRightDataSourceId = typeof options.joinRightDataSourceId === 'string' ? String(options.joinRightDataSourceId) : (st.joinRightDataSourceId || '');
		st.joinKind = typeof options.joinKind === 'string' ? String(options.joinKind) : (st.joinKind || 'inner');
		st.joinKeys = Array.isArray(options.joinKeys)
			? options.joinKeys
			: (Array.isArray(st.joinKeys) ? st.joinKeys : [{ left: '', right: '' }]);
		st.joinOmitDuplicateColumns = typeof options.joinOmitDuplicateColumns === 'boolean'
			? options.joinOmitDuplicateColumns
			: (typeof st.joinOmitDuplicateColumns === 'boolean' ? st.joinOmitDuplicateColumns : true);

		const container = document.getElementById('queries-container');
		if (!container) return id;

		const litEl = document.createElement('kw-transformation-section') as KwTransformationSection;
		litEl.id = id;
		litEl.setAttribute('box-id', id);
		litEl.applyOptions(options);

		litEl.addEventListener('section-remove', (e: any) => {
			try {
				const detail = e && e.detail ? e.detail : {};
				const removeId = detail.boxId || id;
				removeTransformationBox(removeId);
			} catch (err) { console.error('[kusto]', err); }
		});

		const afterBoxId = typeof options.afterBoxId === 'string' ? String(options.afterBoxId) : '';
		const afterEl = afterBoxId ? document.getElementById(afterBoxId) : null;
		if (afterEl) {
			afterEl.insertAdjacentElement('afterend', litEl);
		} else {
			container.insertAdjacentElement('beforeend', litEl);
		}
		try { schedulePersist(); } catch (e) { console.error('[kusto]', e); }
		if (afterBoxId) {
			try {
				const newEl = document.getElementById(id);
				if (newEl && typeof newEl.scrollIntoView === 'function') {
					newEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
				}
			} catch (e) { console.error('[kusto]', e); }
		}
		return id;
	}

	// ── Public properties ─────────────────────────────────────────────────────

	@property({ type: String, reflect: true, attribute: 'box-id' })
	boxId = '';

	// ── Internal state ────────────────────────────────────────────────────────

	@state() private _name = '';
	@state() private _mode: TransformationMode = 'edit';
	@state() private _expanded = true;
	@state() private _transformationType: TransformationType = 'derive';
	@state() private _dataSourceId = '';

	// Derive
	@state() private _deriveColumns: DeriveColumn[] = [{ name: '', expression: '' }];

	// Distinct
	@state() private _distinctColumn = '';

	// Summarize
	@state() private _groupByColumns: string[] = [''];
	@state() private _aggregations: Aggregation[] = [{ name: '', function: 'count', column: '' }];

	// Pivot
	@state() private _pivotRowKeyColumn = '';
	@state() private _pivotColumnKeyColumn = '';
	@state() private _pivotValueColumn = '';
	@state() private _pivotAggregation = 'sum';
	@state() private _pivotMaxColumns = 100;

	// Join
	@state() private _joinRightDataSourceId = '';
	@state() private _joinKind: JoinKind = 'inner';
	@state() private _joinKeys: JoinKey[] = [{ left: '', right: '' }];
	@state() private _joinOmitDuplicateColumns = true;

	// Datasets
	@state() private _datasets: DatasetEntry[] = [];

	// Results
	@state() private _resultColumns: DataTableColumn[] = [];
	@state() private _resultRows: unknown[][] = [];
	@state() private _resultError = '';

	// Wrapper height (tracked as state so data-table gets explicit pixel height)
	@state() private _wrapperHeight = 300;

	// UI sub-state
	@state() private _openDropdownId = '';

	// Drag state
	private _deriveDragState: { fromIndex: number; overIndex: number | null; insertAfter: boolean } | null = null;
	private _aggDragState: { fromIndex: number; overIndex: number | null; insertAfter: boolean } | null = null;
	private _groupByDragState: { fromIndex: number; overIndex: number | null; insertAfter: boolean } | null = null;
	private _joinKeyDragState: { fromIndex: number; overIndex: number | null; insertAfter: boolean } | null = null;

	private _closeDropdownBound = this._closeDropdownOnClickOutside.bind(this);
	private _closeAllPopupsOnScrollBound = this._closeAllPopupsOnScroll.bind(this);
	private _scrollAtPopupOpen = 0;

	// ── Lifecycle ─────────────────────────────────────────────────────────────

	override connectedCallback(): void {
		super.connectedCallback();
		this._syncGlobalState();
		window.addEventListener('scroll', this._closeAllPopupsOnScrollBound, { capture: true, passive: true });
	}

	override disconnectedCallback(): void {
		super.disconnectedCallback();
		document.removeEventListener('mousedown', this._closeDropdownBound);
		window.removeEventListener('scroll', this._closeAllPopupsOnScrollBound, { capture: true });
	}

	override firstUpdated(_changedProperties: PropertyValues): void {
		super.firstUpdated(_changedProperties);

		this._refreshDatasets();
		this._updateHostClasses();
		this._writeToGlobalState();
		// Always compute + sync on initial render even when collapsed, so this
		// section's results are registered globally and appear in other sections'
		// Data dropdowns.  The normal _computeTransformation() skips collapsed
		// sections as a perf optimisation, but on first load we must seed the
		// global results map.
		this._computeTransformationImpl();
		this._syncResultsToGlobal();
		this._autoFitAfterLayout();
	}

	override updated(changed: PropertyValues): void {
		super.updated(changed);

		if (changed.has('_expanded')) {
			this._updateHostClasses();
			if (this._expanded) {
				this._computeTransformation();
			}
		}

		const triggers = [
			'_transformationType', '_dataSourceId', '_deriveColumns',
			'_distinctColumn', '_groupByColumns', '_aggregations',
			'_pivotRowKeyColumn', '_pivotColumnKeyColumn', '_pivotValueColumn',
			'_pivotAggregation',
			'_joinRightDataSourceId', '_joinKind', '_joinKeys', '_joinOmitDuplicateColumns',
		];
		if (triggers.some(k => changed.has(k))) {
			this._writeToGlobalState();
			this._computeTransformation();
		}
	}

	// ── Styles ────────────────────────────────────────────────────────────────

	static override styles = [sashSheet, styles, sectionGlowStyles];

	// ── Render ─────────────────────────────────────────────────────────────────

	override render(): TemplateResult {
		return html`
			<div class="section-root">
				<kw-section-shell
					.name=${this._name}
					.expanded=${this._expanded}
					box-id=${this.boxId}
					section-type="transformation"
					name-placeholder="Transformation name (optional)"
					@name-change=${this._onShellNameChange}
					@toggle-visibility=${this._toggleExpanded}
					@fit-to-contents=${this._onFitToContents}>
					<div slot="header-buttons" class="tf-mode-buttons">
						<button class="unified-btn-secondary md-tab md-mode-btn ${this._mode === 'edit' ? 'is-active' : ''}"
							type="button" role="tab"
							aria-selected="${this._mode === 'edit' ? 'true' : 'false'}"
							@click=${() => this._setMode('edit')}
							title="Edit" aria-label="Edit">Edit</button>
						<button class="unified-btn-secondary md-tab md-mode-btn ${this._mode === 'preview' ? 'is-active' : ''}"
							type="button" role="tab"
							aria-selected="${this._mode === 'preview' ? 'true' : 'false'}"
							@click=${() => this._setMode('preview')}
							title="Preview" aria-label="Preview">Preview</button>
					</div>
					<div class="tf-wrapper-host ${this._expanded ? '' : 'is-hidden'}" id="tf-wrapper"
						style="height:${this._wrapperHeight}px">
						${this._mode === 'edit' ? this._renderControls() : nothing}
						${this._renderResults()}
						${this._resultColumns.length ? html`<div class="resizer"
							title="Drag to resize"
							@mousedown=${this._onResizerMouseDown}
							@dblclick=${this._onFitToContents}></div>` : nothing}
					</div>
				</kw-section-shell>
			</div>
		`;
	}

	private _renderResults(): TemplateResult {
		if (this._resultError) {
			return html`<div class="results-area"><div class="error-message">${this._resultError}</div></div>`;
		}
		if (!this._resultColumns.length) {
			return nothing as unknown as TemplateResult;
		}
		return html`
			<div class="results-area">
				<kw-data-table
					.columns=${this._resultColumns}
					.rows=${this._resultRows}
					.options=${{ label: 'Transformations', showExecutionTime: false, hideTopBorder: true } as DataTableOptions}
					@save=${(e: CustomEvent) => {
						const vscode = window.vscode;
						if (vscode && typeof vscode.postMessage === 'function') {
							vscode.postMessage({
								type: 'saveResultsCsv',
								csv: e.detail.csv,
								suggestedFileName: e.detail.suggestedFileName,
							});
						}
					}}
				></kw-data-table>
			</div>
		`;
	}

	private _renderControls(): TemplateResult {
		const colNames = this._getColumnNames();

		return html`
			<div class="tf-controls">
				<div class="tf-controls-scroll">
					<div class="tf-controls-scroll-content">
						${this._renderTypePicker()}
						${this._renderDataSource()}
						${this._transformationType === 'derive' ? this._renderDerive(colNames) : nothing}
						${this._transformationType === 'summarize' ? this._renderSummarize(colNames) : nothing}
						${this._transformationType === 'distinct' ? this._renderDistinct(colNames) : nothing}
						${this._transformationType === 'pivot' ? this._renderPivot(colNames) : nothing}
						${this._transformationType === 'join' ? this._renderJoin(colNames) : nothing}
					</div>
				</div>
			</div>
		`;
	}

	private _renderTypePicker(): TemplateResult {
		return html`
			<div class="tf-row">
				<label>Type</label>
				<div class="tf-type-picker">
					${TRANSFORM_TYPES_ORDERED.map(t => html`
						<button type="button"
							class="unified-btn-secondary tf-type-btn ${this._transformationType === t ? 'is-active' : ''}"
							@click=${() => this._setTransformationType(t)}
							title="${TRANSFORM_TYPE_LABELS[t]}"
							aria-label="${TRANSFORM_TYPE_LABELS[t]}">
							<span .innerHTML=${TRANSFORM_TYPE_ICONS[t]}></span>
							<span>${TRANSFORM_TYPE_LABELS[t]}</span>
						</button>
					`)}
				</div>
			</div>
		`;
	}

	private _renderDataSource(): TemplateResult {
		const selected = this._datasets.find(d => d.id === this._dataSourceId);
		const label = selected?.label || '(select)';
		const rowLabel = this._transformationType === 'join' ? 'Left' : 'Data';

		return html`
			<div class="tf-row">
				<label>${rowLabel}</label>
				<div class="dropdown-wrapper">
					<button type="button" class="dropdown-btn"
						@click=${(e: Event) => this._toggleDropdown('datasource', e)}
						aria-haspopup="listbox"
						aria-expanded="${this._openDropdownId === 'datasource' ? 'true' : 'false'}">
						${label}
					</button>
					${this._openDropdownId === 'datasource' ? html`
						<div class="dropdown-menu"
							@mousedown=${(e: Event) => e.stopPropagation()}
							@click=${(e: Event) => e.stopPropagation()}>
							${this._datasets.map(d => html`
								<div class="dropdown-item ${d.id === this._dataSourceId ? 'is-selected' : ''}"
									@click=${() => this._selectDataSource(d.id)}>
									${d.label}
								</div>
							`)}
							${!this._datasets.length ? html`
								<div class="dropdown-item" style="opacity:0.7">(no data sources)</div>
							` : nothing}
						</div>
					` : nothing}
				</div>
			</div>
		`;
	}

	private _renderDerive(_colNames: string[]): TemplateResult {
		return html`
			<div class="derive-stack">
				<label>Calc.</label>
				<div class="derive-body">
					<div class="derive-rows ${this._deriveDragState ? 'is-dragging' : ''}">
						${this._deriveColumns.map((col, i) => this._renderDeriveRow(col, i))}
					</div>
				</div>
			</div>
		`;
	}

	private _renderDeriveRow(col: DeriveColumn, index: number): TemplateResult {
		const ds = this._deriveDragState;
		const isDropTarget = ds && ds.overIndex === index;
		const isDropBefore = ds && ds.overIndex === index && !ds.insertAfter;
		const isDropAfter = ds && ds.overIndex === index && ds.insertAfter;

		return html`
			<div class="derive-row ${isDropTarget ? 'is-drop-target' : ''} ${isDropBefore ? 'is-drop-before' : ''} ${isDropAfter ? 'is-drop-after' : ''}"
				@dragover=${(e: DragEvent) => this._onDeriveDragOver(index, e)}
				@drop=${(e: DragEvent) => this._onDeriveDrop(index, e)}>
				<input type="text" class="tf-input derive-name"
					.value=${col.name}
					placeholder="Column name"
					aria-label="New column name"
					@input=${(e: Event) => this._onDeriveColumnChanged(index, 'name', (e.target as HTMLInputElement).value)}
				/>
				<span class="derive-eq" aria-hidden="true">=</span>
				<textarea class="tf-textarea derive-expr" rows="1"
					placeholder="Expression (e.g. [Amount] * 1.2)"
					aria-label="Expression"
					.value=${col.expression}
					@input=${(e: Event) => this._onDeriveColumnChanged(index, 'expression', (e.target as HTMLTextAreaElement).value)}
				></textarea>
				<div class="derive-row-actions">
					<button type="button" class="unified-btn-secondary unified-btn-icon-only mini-btn"
						@click=${() => this._addDeriveColumn(index)}
						title="Add column" aria-label="Add column">
						<span .innerHTML=${SVG_PLUS}></span>
					</button>
					<button type="button" class="unified-btn-secondary unified-btn-icon-only mini-btn"
						@click=${() => this._removeDeriveColumn(index)}
						?disabled=${this._deriveColumns.length <= 1}
						title="Remove column" aria-label="Remove column">
						<span .innerHTML=${SVG_TRASH}></span>
					</button>
					<button type="button" class="drag-handle" draggable="true"
						title="Drag to reorder" aria-label="Reorder column"
						@dragstart=${(e: DragEvent) => this._onDeriveDragStart(index, e)}
						@dragend=${() => this._onDeriveDragEnd()}>
						<span class="drag-handle-glyph" aria-hidden="true">⋮</span>
					</button>
				</div>
			</div>
		`;
	}

	private _renderSummarize(colNames: string[]): TemplateResult {
		return html`
			<div class="summarize-stack">
				<div class="summarize-row summarize-row-calc">
					<label>Calc.</label>
					<div class="summarize-aggs">
						<div class="agg-rows ${this._aggDragState ? 'is-dragging' : ''}">
							${this._aggregations.map((agg, i) => this._renderAggRow(agg, i, colNames))}
						</div>
					</div>
				</div>
				<div class="summarize-row summarize-row-by">
					<label>By</label>
					<div class="groupby-body">
						<div class="groupby-rows ${this._groupByDragState ? 'is-dragging' : ''}">
							${this._groupByColumns.map((col, i) => this._renderGroupByRow(col, i, colNames))}
						</div>
					</div>
				</div>
			</div>
		`;
	}

	private _renderAggRow(agg: Aggregation, index: number, colNames: string[]): TemplateResult {
		const ds = this._aggDragState;
		const isDropTarget = ds && ds.overIndex === index;
		const isDropBefore = ds && ds.overIndex === index && !ds.insertAfter;
		const isDropAfter = ds && ds.overIndex === index && ds.insertAfter;

		return html`
			<div class="agg-row ${isDropTarget ? 'is-drop-target' : ''} ${isDropBefore ? 'is-drop-before' : ''} ${isDropAfter ? 'is-drop-after' : ''}"
				@dragover=${(e: DragEvent) => this._onAggDragOver(index, e)}
				@drop=${(e: DragEvent) => this._onAggDrop(index, e)}>
				<input type="text" class="tf-input"
					.value=${agg.name}
					placeholder="Column name"
					aria-label="Output column name"
					@input=${(e: Event) => this._onAggChanged(index, null, null, (e.target as HTMLInputElement).value)}
				/>
				<span class="agg-eq" aria-hidden="true">=</span>
				<select class="tf-select"
					@change=${(e: Event) => this._onAggChanged(index, (e.target as HTMLSelectElement).value, null, undefined)}>
					${AGG_FUNCTIONS.map(f => html`
						<option value="${f}" ?selected=${agg.function === f}>${f}</option>
					`)}
				</select>
				<select class="tf-select"
					@change=${(e: Event) => this._onAggChanged(index, null, (e.target as HTMLSelectElement).value, undefined)}
					?disabled=${agg.function === 'count'}>
					<option value="" ?selected=${!agg.column}>(select)</option>
					${colNames.map(c => html`
						<option value="${esc(c)}" ?selected=${c === agg.column}>${esc(c)}</option>
					`)}
				</select>
				<div class="agg-row-actions">
					<button type="button" class="unified-btn-secondary unified-btn-icon-only mini-btn"
						@click=${() => this._addAgg(index)}
						title="Add aggregation" aria-label="Add aggregation">
						<span .innerHTML=${SVG_PLUS}></span>
					</button>
					<button type="button" class="unified-btn-secondary unified-btn-icon-only mini-btn"
						@click=${() => this._removeAgg(index)}
						?disabled=${this._aggregations.length <= 1}
						title="Remove aggregation" aria-label="Remove aggregation">
						<span .innerHTML=${SVG_TRASH}></span>
					</button>
					<button type="button" class="drag-handle" draggable="true"
						title="Drag to reorder" aria-label="Reorder aggregation"
						@dragstart=${(e: DragEvent) => this._onAggDragStart(index, e)}
						@dragend=${() => this._onAggDragEnd()}>
						<span class="drag-handle-glyph" aria-hidden="true">⋮</span>
					</button>
				</div>
			</div>
		`;
	}

	private _renderGroupByRow(col: string, index: number, colNames: string[]): TemplateResult {
		const ds = this._groupByDragState;
		const isDropTarget = ds && ds.overIndex === index;
		const isDropBefore = ds && ds.overIndex === index && !ds.insertAfter;
		const isDropAfter = ds && ds.overIndex === index && ds.insertAfter;

		return html`
			<div class="groupby-row ${isDropTarget ? 'is-drop-target' : ''} ${isDropBefore ? 'is-drop-before' : ''} ${isDropAfter ? 'is-drop-after' : ''}"
				@dragover=${(e: DragEvent) => this._onGroupByDragOver(index, e)}
				@drop=${(e: DragEvent) => this._onGroupByDrop(index, e)}>
				<select class="tf-select groupby-select"
					@change=${(e: Event) => this._onGroupByColumnChanged(index, (e.target as HTMLSelectElement).value)}>
					<option value="" ?selected=${!col}>(select column)</option>
					${colNames.map(c => html`
						<option value="${esc(c)}" ?selected=${c === col}>${esc(c)}</option>
					`)}
				</select>
				<div class="groupby-row-actions">
					<button type="button" class="unified-btn-secondary unified-btn-icon-only mini-btn"
						@click=${() => this._addGroupByColumn(index)}
						title="Add group-by column" aria-label="Add group-by column">
						<span .innerHTML=${SVG_PLUS}></span>
					</button>
					<button type="button" class="unified-btn-secondary unified-btn-icon-only mini-btn"
						@click=${() => this._removeGroupByColumn(index)}
						?disabled=${this._groupByColumns.length <= 1}
						title="Remove group-by column" aria-label="Remove group-by column">
						<span .innerHTML=${SVG_TRASH}></span>
					</button>
					<button type="button" class="drag-handle" draggable="true"
						title="Drag to reorder" aria-label="Reorder group-by column"
						@dragstart=${(e: DragEvent) => this._onGroupByDragStart(index, e)}
						@dragend=${() => this._onGroupByDragEnd()}>
						<span class="drag-handle-glyph" aria-hidden="true">⋮</span>
					</button>
				</div>
			</div>
		`;
	}

	private _renderDistinct(colNames: string[]): TemplateResult {
		return html`
			<div class="tf-row" style="gap:10px;">
				<label>Column</label>
				<div class="dropdown-wrapper">
					<button type="button" class="dropdown-btn"
						@click=${(e: Event) => this._toggleDropdown('distinct', e)}
						aria-haspopup="listbox"
						aria-expanded="${this._openDropdownId === 'distinct' ? 'true' : 'false'}">
						${this._distinctColumn || '(select)'}
					</button>
					${this._openDropdownId === 'distinct' ? html`
						<div class="dropdown-menu"
							@mousedown=${(e: Event) => e.stopPropagation()}
							@click=${(e: Event) => e.stopPropagation()}>
							${colNames.map(c => html`
								<div class="dropdown-item ${c === this._distinctColumn ? 'is-selected' : ''}"
									@click=${() => this._selectDistinctColumn(c)}>
									${esc(c)}
								</div>
							`)}
							${!colNames.length ? html`
								<div class="dropdown-item" style="opacity:0.7">(no columns)</div>
							` : nothing}
						</div>
					` : nothing}
				</div>
			</div>
		`;
	}

	private _renderPivot(colNames: string[]): TemplateResult {
		return html`
			<div class="tf-row pivot-row">
				<label>Rows</label>
				${this._renderPivotDropdown('pivotRow', this._pivotRowKeyColumn, colNames)}
				<label class="pivot-label-spaced">Columns</label>
				${this._renderPivotDropdown('pivotCol', this._pivotColumnKeyColumn, colNames)}
			</div>
			<div class="tf-row pivot-row">
				<label>Value</label>
				${this._renderPivotDropdown('pivotVal', this._pivotValueColumn, colNames)}
				<label class="pivot-label-spaced">Agg.</label>
				${this._renderPivotAggDropdown()}
			</div>
		`;
	}

	private _renderPivotDropdown(dropdownId: string, selected: string, colNames: string[]): TemplateResult {
		return html`
			<div class="dropdown-wrapper">
				<button type="button" class="dropdown-btn"
					@click=${(e: Event) => this._toggleDropdown(dropdownId, e)}
					aria-haspopup="listbox"
					aria-expanded="${this._openDropdownId === dropdownId ? 'true' : 'false'}">
					${selected || '(select)'}
				</button>
				${this._openDropdownId === dropdownId ? html`
					<div class="dropdown-menu"
						@mousedown=${(e: Event) => e.stopPropagation()}
						@click=${(e: Event) => e.stopPropagation()}>
						${colNames.map(c => html`
							<div class="dropdown-item ${c === selected ? 'is-selected' : ''}"
								@click=${() => this._selectPivotColumn(dropdownId, c)}>
								${esc(c)}
							</div>
						`)}
						${!colNames.length ? html`
							<div class="dropdown-item" style="opacity:0.7">(no columns)</div>
						` : nothing}
					</div>
				` : nothing}
			</div>
		`;
	}

	private _renderPivotAggDropdown(): TemplateResult {
		return html`
			<div class="dropdown-wrapper">
				<button type="button" class="dropdown-btn"
					@click=${(e: Event) => this._toggleDropdown('pivotAgg', e)}
					aria-haspopup="listbox"
					aria-expanded="${this._openDropdownId === 'pivotAgg' ? 'true' : 'false'}">
					${this._pivotAggregation || 'sum'}
				</button>
				${this._openDropdownId === 'pivotAgg' ? html`
					<div class="dropdown-menu"
						@mousedown=${(e: Event) => e.stopPropagation()}
						@click=${(e: Event) => e.stopPropagation()}>
						${PIVOT_AGG_FUNCTIONS.map(f => html`
							<div class="dropdown-item ${f === this._pivotAggregation ? 'is-selected' : ''}"
								@click=${() => this._selectPivotAgg(f)}>
								${f}
							</div>
						`)}
					</div>
				` : nothing}
			</div>
		`;
	}

	// ── Join rendering ────────────────────────────────────────────────────────

	private _renderJoin(leftColNames: string[]): TemplateResult {
		const rightDs = this._datasets.find(d => d.id === this._joinRightDataSourceId);
		const rightLabel = rightDs?.label || '(select)';
		const rightColNames = rightDs
			? (rightDs.columns || []).map((c: string) => normalizeResultsColumnName(c)).filter((c: string) => c)
			: [];
		const isSemiAnti = this._joinKind === 'leftanti' || this._joinKind === 'rightanti'
			|| this._joinKind === 'leftsemi' || this._joinKind === 'rightsemi';

		return html`
			<div class="tf-row">
				<label>Right</label>
				<div class="dropdown-wrapper">
					<button type="button" class="dropdown-btn"
						@click=${(e: Event) => this._toggleDropdown('joinRight', e)}
						aria-haspopup="listbox"
						aria-expanded="${this._openDropdownId === 'joinRight' ? 'true' : 'false'}">
						${rightLabel}
					</button>
					${this._openDropdownId === 'joinRight' ? html`
						<div class="dropdown-menu"
							@mousedown=${(e: Event) => e.stopPropagation()}
							@click=${(e: Event) => e.stopPropagation()}>
							${this._datasets.map(d => html`
								<div class="dropdown-item ${d.id === this._joinRightDataSourceId ? 'is-selected' : ''}"
									@click=${() => this._selectJoinRightDataSource(d.id)}>
									${d.label}
								</div>
							`)}
							${!this._datasets.length ? html`
								<div class="dropdown-item" style="opacity:0.7">(no data sources)</div>
							` : nothing}
						</div>
					` : nothing}
				</div>
			</div>
			<div class="tf-row">
				<label>Kind</label>
				<div class="dropdown-wrapper">
					<button type="button" class="dropdown-btn"
						@click=${(e: Event) => this._toggleDropdown('joinKind', e)}
						aria-haspopup="listbox"
						aria-expanded="${this._openDropdownId === 'joinKind' ? 'true' : 'false'}">
						${JOIN_KIND_LABELS[this._joinKind] || 'inner'}
					</button>
					${this._openDropdownId === 'joinKind' ? html`
						<div class="dropdown-menu"
							@mousedown=${(e: Event) => e.stopPropagation()}
							@click=${(e: Event) => e.stopPropagation()}>
							${JOIN_KINDS.map(k => html`
								<div class="dropdown-item ${k === this._joinKind ? 'is-selected' : ''}"
									@click=${() => this._selectJoinKind(k)}>
									${JOIN_KIND_LABELS[k]}
								</div>
							`)}
						</div>
					` : nothing}
				</div>
			</div>
			${this._renderJoinKeys(leftColNames, rightColNames)}
			${!isSemiAnti ? html`
				<div class="tf-row join-omit-row">
					<label></label>
					<label class="join-checkbox-label">
						<input type="checkbox"
							.checked=${this._joinOmitDuplicateColumns}
							@change=${(e: Event) => this._onJoinOmitDuplicateColumnsChanged((e.target as HTMLInputElement).checked)}
						/>
						Omit duplicate columns
					</label>
				</div>
			` : nothing}
		`;
	}

	private _renderJoinKeys(leftColNames: string[], rightColNames: string[]): TemplateResult {
		return html`
			<div class="join-keys-stack">
				<label>On</label>
				<div class="join-keys-body">
					<div class="join-key-rows ${this._joinKeyDragState ? 'is-dragging' : ''}">
						${this._joinKeys.map((key, i) => this._renderJoinKeyRow(key, i, leftColNames, rightColNames))}
					</div>
				</div>
			</div>
		`;
	}

	private _renderJoinKeyRow(key: JoinKey, index: number, leftColNames: string[], rightColNames: string[]): TemplateResult {
		const ds = this._joinKeyDragState;
		const isDropTarget = ds && ds.overIndex === index;
		const isDropBefore = ds && ds.overIndex === index && !ds.insertAfter;
		const isDropAfter = ds && ds.overIndex === index && ds.insertAfter;

		return html`
			<div class="join-key-row ${isDropTarget ? 'is-drop-target' : ''} ${isDropBefore ? 'is-drop-before' : ''} ${isDropAfter ? 'is-drop-after' : ''}"
				@dragover=${(e: DragEvent) => this._onJoinKeyDragOver(index, e)}
				@drop=${(e: DragEvent) => this._onJoinKeyDrop(index, e)}>
				<select class="tf-select"
					@change=${(e: Event) => this._onJoinKeyChanged(index, 'left', (e.target as HTMLSelectElement).value)}>
					<option value="" ?selected=${!key.left}>(left column)</option>
					${leftColNames.map(c => html`
						<option value="${esc(c)}" ?selected=${c === key.left}>${esc(c)}</option>
					`)}
				</select>
				<span class="join-eq" aria-hidden="true">==</span>
				<select class="tf-select"
					@change=${(e: Event) => this._onJoinKeyChanged(index, 'right', (e.target as HTMLSelectElement).value)}>
					<option value="" ?selected=${!key.right}>(right column)</option>
					${rightColNames.map(c => html`
						<option value="${esc(c)}" ?selected=${c === key.right}>${esc(c)}</option>
					`)}
				</select>
				<div class="join-key-row-actions">
					<button type="button" class="unified-btn-secondary unified-btn-icon-only mini-btn"
						@click=${() => this._addJoinKey(index)}
						title="Add key pair" aria-label="Add key pair">
						<span .innerHTML=${SVG_PLUS}></span>
					</button>
					<button type="button" class="unified-btn-secondary unified-btn-icon-only mini-btn"
						@click=${() => this._removeJoinKey(index)}
						?disabled=${this._joinKeys.length <= 1}
						title="Remove key pair" aria-label="Remove key pair">
						<span .innerHTML=${SVG_TRASH}></span>
					</button>
					<button type="button" class="drag-handle" draggable="true"
						title="Drag to reorder" aria-label="Reorder key pair"
						@dragstart=${(e: DragEvent) => this._onJoinKeyDragStart(index, e)}
						@dragend=${() => this._onJoinKeyDragEnd()}>
						<span class="drag-handle-glyph" aria-hidden="true">&#8942;</span>
					</button>
				</div>
			</div>
		`;
	}

	// ── Event handlers ────────────────────────────────────────────────────────

	private _onShellNameChange(e: CustomEvent<{ name: string }>): void {
		this._name = e.detail.name;
		this._schedulePersist();
		// Refresh Data dropdowns in Chart/Transformation sections.
		try { __kustoRefreshAllDataSourceDropdowns(); } catch (e) { console.error('[kusto]', e); }
	}

	private _setMode(mode: TransformationMode): void {
		this._mode = mode;
		this._writeToGlobalState();
		this._computeTransformation();
		this._autoFitAfterLayout();
		this._schedulePersist();
	}

	private _toggleExpanded(): void {
		this._expanded = !this._expanded;
		this._updateHostClasses();
		this._writeToGlobalState();
		if (this._expanded) {
			this._computeTransformation();
		}
		this._schedulePersist();
	}

	private _onFitToContents(): void {
		this._wrapperHeight = this._computeFitHeight();
		this._schedulePersist();
	}

	/** Schedule auto-fit after Lit render + browser layout pass. */
	private _autoFitAfterLayout(): void {
		const fit = () => {
			this._wrapperHeight = this._computeFitHeight();
			this._schedulePersist();
		};
		this.updateComplete.then(() => {
			requestAnimationFrame(() => {
				requestAnimationFrame(() => {
					fit();
					// Retry: kw-data-table's virtualizer initializes asynchronously
					// (rAF + ResizeObserver); a delayed second pass ensures accurate
					// measurements once the virtualizer has settled.
					setTimeout(fit, 150);
				});
			});
		});
	}

	/**
	 * Compute the minimum wrapper height: controls + resizer so the resizer
	 * is always visible and grabbable regardless of how small the user drags.
	 */
	private _computeMinHeight(): number {
		let controlsH = 0;
		const wrapper = this.shadowRoot?.getElementById('tf-wrapper');
		if (wrapper) {
			for (const child of Array.from(wrapper.children) as HTMLElement[]) {
				if (child.classList.contains('results-area')) continue;
				const cs = getComputedStyle(child);
				if (cs.display === 'none') continue;
				const rect = child.getBoundingClientRect();
				controlsH += Math.ceil(rect.height)
					+ (parseFloat(cs.marginTop) || 0)
					+ (parseFloat(cs.marginBottom) || 0);
			}
		}
		// Ensure at least enough room for the controls plus a small results buffer
		return Math.max(120, Math.ceil(controlsH) + 40);
	}

	private _computeFitHeight(): number {
		// Measure controls + resizer height from their current rendered sizes
		let nonTableH = 0;
		const wrapper = this.shadowRoot?.getElementById('tf-wrapper');
		if (wrapper) {
			for (const child of Array.from(wrapper.children) as HTMLElement[]) {
				if (child.classList.contains('results-area')) continue;
				const cs = getComputedStyle(child);
				if (cs.display === 'none') continue;
				const rect = child.getBoundingClientRect();
				nonTableH += Math.ceil(rect.height)
					+ (parseFloat(cs.marginTop) || 0)
					+ (parseFloat(cs.marginBottom) || 0);
			}
		}

		// Use kw-data-table.getContentHeight() which accounts for all internal
		// chrome (header bar, thead, search bar, row-jump, col-jump, rows).
		// +10 accounts for .results-area padding-bottom that creates the gap
		// between the table and the section resizer (matches Kusto/SQL sections).
		const dataTable = this.shadowRoot?.querySelector('kw-data-table') as any;
		if (dataTable && typeof dataTable.getContentHeight === 'function') {
			const contentH = dataTable.getContentHeight();
			nonTableH += Math.max(60, contentH) + 10;
		} else if (this._resultError) {
			const errorEl = wrapper?.querySelector('.error-message') as HTMLElement | null;
			nonTableH += errorEl ? Math.max(30, Math.ceil(errorEl.scrollHeight)) : 44;
		} else {
			const resultsArea = wrapper?.querySelector('.results-area') as HTMLElement | null;
			if (resultsArea) {
				nonTableH += Math.ceil(resultsArea.getBoundingClientRect().height);
			}
		}

		return Math.max(120, Math.min(900, Math.ceil(nonTableH)));
	}

	private _onResizerMouseDown(e: MouseEvent): void {
		e.preventDefault();
		e.stopPropagation();

		const resizer = e.currentTarget as HTMLElement;
		resizer.classList.add('is-dragging');

		const prevCursor = document.body.style.cursor;
		const prevSelect = document.body.style.userSelect;
		document.body.style.cursor = 'ns-resize';
		document.body.style.userSelect = 'none';

		const startPageY = e.clientY + getScrollY();
		const startHeight = this._wrapperHeight;

		const minH = this._computeMinHeight();
		const maxH = this._computeFitHeight();

		const onMove = (moveEvent: MouseEvent) => {
			try {
				maybeAutoScrollWhileDragging(moveEvent.clientY);
			} catch (e) { console.error('[kusto]', e); }
			const pageY = moveEvent.clientY + getScrollY();
			const delta = pageY - startPageY;
			this._wrapperHeight = Math.max(minH, Math.min(maxH, Math.ceil(startHeight + delta)));
		};

		const onUp = () => {
			document.removeEventListener('mousemove', onMove, true);
			document.removeEventListener('mouseup', onUp, true);
			document.removeEventListener('mouseleave', onUp);
			window.removeEventListener('blur', onUp);
			resizer.classList.remove('is-dragging');
			document.body.style.cursor = prevCursor;
			document.body.style.userSelect = prevSelect;
			this._schedulePersist();
		};

		document.addEventListener('mousemove', onMove, true);
		document.addEventListener('mouseup', onUp, true);
		document.addEventListener('mouseleave', onUp);
		window.addEventListener('blur', onUp);
	}



	private _setTransformationType(type: TransformationType): void {
		this._transformationType = type;
		this._autoFitAfterLayout();
		this._schedulePersist();
	}

	private _selectDataSource(id: string): void {
		this._dataSourceId = id;
		this._openDropdownId = '';
		document.removeEventListener('mousedown', this._closeDropdownBound);
		this._schedulePersist();
	}

	// ── Dropdown management ───────────────────────────────────────────────────

	private _toggleDropdown(id: string, e: Event): void {
		e.stopPropagation();
		if (this._openDropdownId === id) {
			this._openDropdownId = '';
			document.removeEventListener('mousedown', this._closeDropdownBound);
		} else {
			// Refresh datasets before opening data source dropdown
			if (id === 'datasource') {
				this._refreshDatasets();
			}
			this._openDropdownId = id;
			this._scrollAtPopupOpen = document.documentElement.scrollTop || document.body.scrollTop || 0;
			this.updateComplete.then(() => {
				const menu = this.shadowRoot?.querySelector('.dropdown-menu') as HTMLElement;
				if (menu) {
					const btn = (e.target as HTMLElement).closest('.dropdown-btn') as HTMLElement;
					if (btn) {
						const rect = btn.getBoundingClientRect();
						menu.style.top = rect.bottom + 'px';
						menu.style.left = rect.left + 'px';
						menu.style.width = rect.width + 'px';
					}
				}
			});
			setTimeout(() => document.addEventListener('mousedown', this._closeDropdownBound), 0);
		}
	}

	private _closeDropdownOnClickOutside(): void {
		this._openDropdownId = '';
		document.removeEventListener('mousedown', this._closeDropdownBound);
	}

	private _closeAllPopupsOnScroll(): void {
		if (!this._openDropdownId) return;
		const scrollY = document.documentElement.scrollTop || document.body.scrollTop || 0;
		if (Math.abs(scrollY - this._scrollAtPopupOpen) <= 20) return;
		this._openDropdownId = '';
		document.removeEventListener('mousedown', this._closeDropdownBound);
	}

	// ── Derive handlers ───────────────────────────────────────────────────────

	private _onDeriveColumnChanged(index: number, field: 'name' | 'expression', value: string): void {
		const cols = [...this._deriveColumns];
		if (!cols[index]) cols[index] = { name: '', expression: '' };
		const oldName = field === 'name' ? cols[index].name : '';
		cols[index] = { ...cols[index], [field]: value };
		this._deriveColumns = cols;
		this._writeToGlobalState();
		this._computeTransformation();
		this._schedulePersist();

		// Propagate column rename to downstream sections.
		if (field === 'name' && oldName && value && oldName !== value) {
			this._propagateColumnRename(oldName, value);
		}
	}

	private _addDeriveColumn(afterIndex: number): void {
		const cols = [...this._deriveColumns];
		const insertedIndex = afterIndex + 1;
		cols.splice(insertedIndex, 0, { name: '', expression: '' });
		this._deriveColumns = cols;
		this._autoFitAfterLayout();
		this._schedulePersist();
	}

	private _removeDeriveColumn(index: number): void {
		if (this._deriveColumns.length <= 1) return;
		const cols = [...this._deriveColumns];
		cols.splice(index, 1);
		this._deriveColumns = cols;
		this._autoFitAfterLayout();
		this._schedulePersist();
	}

	// ── Derive drag & drop ────────────────────────────────────────────────────

	private _onDeriveDragStart(index: number, e: DragEvent): void {
		this._deriveDragState = { fromIndex: index, overIndex: null, insertAfter: false };
		if (e.dataTransfer) {
			e.dataTransfer.effectAllowed = 'move';
			try { e.dataTransfer.setData('text/plain', 'kusto-derive'); } catch (e) { console.error('[kusto]', e); }
		}
		this.requestUpdate();
	}

	private _onDeriveDragOver(index: number, e: DragEvent): void {
		if (!this._deriveDragState) return;
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
		const row = (e.currentTarget as HTMLElement);
		const rect = row.getBoundingClientRect();
		const insertAfter = e.clientY >= rect.top + rect.height / 2;
		this._deriveDragState = { ...this._deriveDragState!, overIndex: index, insertAfter };
		this.requestUpdate();
	}

	private _onDeriveDrop(toIndex: number, e: DragEvent): void {
		e.preventDefault();
		const ds = this._deriveDragState;
		if (!ds) return;
		const fromIdx = ds.fromIndex;
		const overIdx = ds.overIndex ?? toIndex;
		const insertAfter = ds.insertAfter;
		let insertion = overIdx + (insertAfter ? 1 : 0);
		insertion = Math.max(0, Math.min(this._deriveColumns.length, insertion));
		if (insertion === fromIdx || insertion === fromIdx + 1) {
			this._deriveDragState = null;
			this.requestUpdate();
			return;
		}
		const cols = [...this._deriveColumns];
		const moved = cols.splice(fromIdx, 1)[0];
		const toInsert = fromIdx < insertion ? insertion - 1 : insertion;
		cols.splice(toInsert, 0, moved);
		this._deriveColumns = cols;
		this._deriveDragState = null;
		this._schedulePersist();
	}

	private _onDeriveDragEnd(): void {
		this._deriveDragState = null;
		this.requestUpdate();
	}

	/**
	 * Propagate a column rename to all downstream sections (charts & transformations)
	 * that use this transformation as their data source.
	 */
	private _propagateColumnRename(oldName: string, newName: string): void {
		try {
			const myId = this.boxId || this.id;
			if (!myId) return;
			const container = document.getElementById('queries-container') as HTMLElement | null;
			if (!container) return;

			for (const child of Array.from(container.children)) {
				const el = child as any;
				const id = el.id ? String(el.id) : '';
				if (!id || id === myId) continue;

				// Charts that reference this transformation.
				if (id.startsWith('chart_')) {
					const w = window;
					const st = typeof w.__kustoGetChartState === 'function' ? w.__kustoGetChartState(id) : null;
					if (!st || String(st.dataSourceId || '') !== myId) continue;

					let changed = false;
					if (st.xColumn === oldName) { st.xColumn = newName; changed = true; }
					if (st.legendColumn === oldName) { st.legendColumn = newName; changed = true; }
					if (st.labelColumn === oldName) { st.labelColumn = newName; changed = true; }
					if (st.valueColumn === oldName) { st.valueColumn = newName; changed = true; }
					if (st.sortColumn === oldName) { st.sortColumn = newName; changed = true; }
					if (Array.isArray(st.yColumns)) {
						const idx = st.yColumns.indexOf(oldName);
						if (idx >= 0) { st.yColumns[idx] = newName; changed = true; }
					}
					if (Array.isArray(st.tooltipColumns)) {
						const idx = st.tooltipColumns.indexOf(oldName);
						if (idx >= 0) { st.tooltipColumns[idx] = newName; changed = true; }
					}

					if (changed) {
						// Sync Lit chart component state.
						if (typeof el.syncFromGlobalState === 'function') {
							el.syncFromGlobalState();
						}
						// Refresh legacy UI.
						try { w.__kustoUpdateChartBuilderUI(id); } catch (e) { console.error('[kusto]', e); }
						try { __kustoRenderChart(id); } catch (e) { console.error('[kusto]', e); }
					}
					continue;
				}

				// Downstream transformations that reference this transformation.
				if (id.startsWith('transformation_')) {
					const w = window;
					const stMap = w.transformationStateByBoxId;
					const st = stMap ? stMap[id] : null;
					if (!st || String(st.dataSourceId || '') !== myId) continue;

					let changed = false;
					if (st.distinctColumn === oldName) { st.distinctColumn = newName; changed = true; }
					if (st.pivotRowKeyColumn === oldName) { st.pivotRowKeyColumn = newName; changed = true; }
					if (st.pivotColumnKeyColumn === oldName) { st.pivotColumnKeyColumn = newName; changed = true; }
					if (st.pivotValueColumn === oldName) { st.pivotValueColumn = newName; changed = true; }
					if (Array.isArray(st.groupByColumns)) {
						const idx = st.groupByColumns.indexOf(oldName);
						if (idx >= 0) { st.groupByColumns[idx] = newName; changed = true; }
					}
					if (Array.isArray(st.aggregations)) {
						for (const agg of st.aggregations) {
							if (agg && agg.column === oldName) { agg.column = newName; changed = true; }
						}
					}

					if (changed) {
						// Sync Lit transformation component state.
						if (typeof el.syncFromGlobalState === 'function') {
							el.syncFromGlobalState();
						}
						try { w.__kustoUpdateTransformationBuilderUI(id); } catch (e) { console.error('[kusto]', e); }
						try { w.__kustoRenderTransformation(id); } catch (e) { console.error('[kusto]', e); }
					}
				}
			}
		} catch (e) { console.error('[kusto]', e); }
	}

	// ── Aggregation handlers ──────────────────────────────────────────────────

	private _onAggChanged(index: number, newFn: string | null, newCol: string | null, newName: string | undefined): void {
		const aggs = [...this._aggregations];
		if (!aggs[index]) aggs[index] = { name: '', function: 'count', column: '' };
		const a = { ...aggs[index] };
		const nameOnlyChange = typeof newName === 'string' && newFn === null && newCol === null;
		if (newFn !== null) a.function = newFn;
		if (newCol !== null) a.column = newCol;
		if (typeof newName === 'string') a.name = newName;
		if (a.function === 'count') a.column = '';
		aggs[index] = a;
		this._aggregations = aggs;

		if (!nameOnlyChange) {
			this._writeToGlobalState();
			this._computeTransformation();
		}
		this._schedulePersist();
	}

	private _addAgg(afterIndex: number): void {
		const aggs = [...this._aggregations];
		const insertedIndex = afterIndex + 1;
		aggs.splice(insertedIndex, 0, { name: '', function: 'count', column: '' });
		this._aggregations = aggs;
		this._autoFitAfterLayout();
		this._schedulePersist();
	}

	private _removeAgg(index: number): void {
		if (this._aggregations.length <= 1) return;
		const aggs = [...this._aggregations];
		aggs.splice(index, 1);
		this._aggregations = aggs;
		this._autoFitAfterLayout();
		this._schedulePersist();
	}

	// ── Aggregation drag & drop ───────────────────────────────────────────────

	private _onAggDragStart(index: number, e: DragEvent): void {
		this._aggDragState = { fromIndex: index, overIndex: null, insertAfter: false };
		if (e.dataTransfer) {
			e.dataTransfer.effectAllowed = 'move';
			try { e.dataTransfer.setData('text/plain', 'kusto-agg'); } catch (e) { console.error('[kusto]', e); }
		}
		this.requestUpdate();
	}

	private _onAggDragOver(index: number, e: DragEvent): void {
		if (!this._aggDragState) return;
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
		const row = (e.currentTarget as HTMLElement);
		const rect = row.getBoundingClientRect();
		const insertAfter = e.clientY >= rect.top + rect.height / 2;
		this._aggDragState = { ...this._aggDragState!, overIndex: index, insertAfter };
		this.requestUpdate();
	}

	private _onAggDrop(toIndex: number, e: DragEvent): void {
		e.preventDefault();
		const ds = this._aggDragState;
		if (!ds) return;
		const fromIdx = ds.fromIndex;
		const overIdx = ds.overIndex ?? toIndex;
		const insertAfter = ds.insertAfter;
		let insertion = overIdx + (insertAfter ? 1 : 0);
		insertion = Math.max(0, Math.min(this._aggregations.length, insertion));
		if (insertion === fromIdx || insertion === fromIdx + 1) {
			this._aggDragState = null;
			this.requestUpdate();
			return;
		}
		const aggs = [...this._aggregations];
		const moved = aggs.splice(fromIdx, 1)[0];
		const toInsert = fromIdx < insertion ? insertion - 1 : insertion;
		aggs.splice(toInsert, 0, moved);
		this._aggregations = aggs;
		this._aggDragState = null;
		this._schedulePersist();
	}

	private _onAggDragEnd(): void {
		this._aggDragState = null;
		this.requestUpdate();
	}

	// ── Group-by handlers ─────────────────────────────────────────────────────

	private _onGroupByColumnChanged(index: number, value: string): void {
		const cols = [...this._groupByColumns];
		if (index >= 0 && index < cols.length) {
			cols[index] = value;
		}
		this._groupByColumns = cols;
		this._schedulePersist();
	}

	private _addGroupByColumn(afterIndex: number): void {
		const cols = [...this._groupByColumns];
		const insertedIndex = afterIndex + 1;
		cols.splice(insertedIndex, 0, '');
		this._groupByColumns = cols;
		this._autoFitAfterLayout();
		this._schedulePersist();
	}

	private _removeGroupByColumn(index: number): void {
		if (this._groupByColumns.length <= 1) return;
		const cols = [...this._groupByColumns];
		cols.splice(index, 1);
		this._groupByColumns = cols;
		this._autoFitAfterLayout();
		this._schedulePersist();
	}

	// ── Group-by drag & drop ──────────────────────────────────────────────────

	private _onGroupByDragStart(index: number, e: DragEvent): void {
		this._groupByDragState = { fromIndex: index, overIndex: null, insertAfter: false };
		if (e.dataTransfer) {
			e.dataTransfer.effectAllowed = 'move';
			try { e.dataTransfer.setData('text/plain', 'kusto-groupby'); } catch (e) { console.error('[kusto]', e); }
		}
		this.requestUpdate();
	}

	private _onGroupByDragOver(index: number, e: DragEvent): void {
		if (!this._groupByDragState) return;
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
		const row = (e.currentTarget as HTMLElement);
		const rect = row.getBoundingClientRect();
		const insertAfter = e.clientY >= rect.top + rect.height / 2;
		this._groupByDragState = { ...this._groupByDragState!, overIndex: index, insertAfter };
		this.requestUpdate();
	}

	private _onGroupByDrop(toIndex: number, e: DragEvent): void {
		e.preventDefault();
		const ds = this._groupByDragState;
		if (!ds) return;
		const fromIdx = ds.fromIndex;
		const overIdx = ds.overIndex ?? toIndex;
		const insertAfter = ds.insertAfter;
		let insertion = overIdx + (insertAfter ? 1 : 0);
		insertion = Math.max(0, Math.min(this._groupByColumns.length, insertion));
		if (insertion === fromIdx || insertion === fromIdx + 1) {
			this._groupByDragState = null;
			this.requestUpdate();
			return;
		}
		const cols = [...this._groupByColumns];
		const moved = cols.splice(fromIdx, 1)[0];
		const toInsert = fromIdx < insertion ? insertion - 1 : insertion;
		cols.splice(toInsert, 0, moved);
		this._groupByColumns = cols;
		this._groupByDragState = null;
		this._schedulePersist();
	}

	private _onGroupByDragEnd(): void {
		this._groupByDragState = null;
		this.requestUpdate();
	}

	// ── Distinct handlers ─────────────────────────────────────────────────────

	private _selectDistinctColumn(col: string): void {
		this._distinctColumn = col;
		this._openDropdownId = '';
		document.removeEventListener('mousedown', this._closeDropdownBound);
		// Allow shrink/grow to fit new contents
		this._schedulePersist();
	}

	// ── Pivot handlers ────────────────────────────────────────────────────────

	private _selectPivotColumn(dropdownId: string, value: string): void {
		if (dropdownId === 'pivotRow') this._pivotRowKeyColumn = value;
		else if (dropdownId === 'pivotCol') this._pivotColumnKeyColumn = value;
		else if (dropdownId === 'pivotVal') this._pivotValueColumn = value;
		this._openDropdownId = '';
		document.removeEventListener('mousedown', this._closeDropdownBound);
		this._pivotMaxColumns = 100;
		this._schedulePersist();
	}

	private _selectPivotAgg(value: string): void {
		this._pivotAggregation = value;
		this._openDropdownId = '';
		document.removeEventListener('mousedown', this._closeDropdownBound);
		this._pivotMaxColumns = 100;
		this._schedulePersist();
	}

	// ── Join handlers ─────────────────────────────────────────────────────────

	private _selectJoinRightDataSource(id: string): void {
		this._joinRightDataSourceId = id;
		this._openDropdownId = '';
		document.removeEventListener('mousedown', this._closeDropdownBound);
		this._schedulePersist();
	}

	private _selectJoinKind(kind: JoinKind): void {
		this._joinKind = kind;
		this._openDropdownId = '';
		document.removeEventListener('mousedown', this._closeDropdownBound);
		this._schedulePersist();
	}

	private _onJoinKeyChanged(index: number, side: 'left' | 'right', value: string): void {
		const keys = [...this._joinKeys];
		if (!keys[index]) keys[index] = { left: '', right: '' };
		keys[index] = { ...keys[index], [side]: value };
		this._joinKeys = keys;
		this._writeToGlobalState();
		this._computeTransformation();
		this._schedulePersist();
	}

	private _addJoinKey(afterIndex: number): void {
		const keys = [...this._joinKeys];
		keys.splice(afterIndex + 1, 0, { left: '', right: '' });
		this._joinKeys = keys;
		this._autoFitAfterLayout();
		this._schedulePersist();
	}

	private _removeJoinKey(index: number): void {
		if (this._joinKeys.length <= 1) return;
		const keys = [...this._joinKeys];
		keys.splice(index, 1);
		this._joinKeys = keys;
		this._autoFitAfterLayout();
		this._schedulePersist();
	}

	private _onJoinOmitDuplicateColumnsChanged(checked: boolean): void {
		this._joinOmitDuplicateColumns = checked;
		this._writeToGlobalState();
		this._computeTransformation();
		this._schedulePersist();
	}

	// ── Join key drag & drop ──────────────────────────────────────────────────

	private _onJoinKeyDragStart(index: number, e: DragEvent): void {
		this._joinKeyDragState = { fromIndex: index, overIndex: null, insertAfter: false };
		if (e.dataTransfer) {
			e.dataTransfer.effectAllowed = 'move';
			try { e.dataTransfer.setData('text/plain', 'kusto-joinkey'); } catch (e) { console.error('[kusto]', e); }
		}
		this.requestUpdate();
	}

	private _onJoinKeyDragOver(index: number, e: DragEvent): void {
		if (!this._joinKeyDragState) return;
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
		const row = (e.currentTarget as HTMLElement);
		const rect = row.getBoundingClientRect();
		const insertAfter = e.clientY >= rect.top + rect.height / 2;
		this._joinKeyDragState = { ...this._joinKeyDragState!, overIndex: index, insertAfter };
		this.requestUpdate();
	}

	private _onJoinKeyDrop(toIndex: number, e: DragEvent): void {
		e.preventDefault();
		const ds = this._joinKeyDragState;
		if (!ds) return;
		const fromIdx = ds.fromIndex;
		const overIdx = ds.overIndex ?? toIndex;
		const insertAfter = ds.insertAfter;
		let insertion = overIdx + (insertAfter ? 1 : 0);
		insertion = Math.max(0, Math.min(this._joinKeys.length, insertion));
		if (insertion === fromIdx || insertion === fromIdx + 1) {
			this._joinKeyDragState = null;
			this.requestUpdate();
			return;
		}
		const keys = [...this._joinKeys];
		const moved = keys.splice(fromIdx, 1)[0];
		const toInsert = fromIdx < insertion ? insertion - 1 : insertion;
		keys.splice(toInsert, 0, moved);
		this._joinKeys = keys;
		this._joinKeyDragState = null;
		this._schedulePersist();
	}

	private _onJoinKeyDragEnd(): void {
		this._joinKeyDragState = null;
		this.requestUpdate();
	}

	// ── Global state bridge ───────────────────────────────────────────────────

	/**
	 * Read state from the global transformationStateByBoxId into Lit properties.
	 * Public so column rename propagation can push updated names into this component.
	 */
	public syncFromGlobalState(): void {
		this._syncGlobalState();
	}

	private _syncGlobalState(): void {
		const w = window;
		const stateMap = w.transformationStateByBoxId;
		if (!stateMap || typeof stateMap !== 'object') return;
		const st = stateMap[this.boxId];
		if (!st) return;

		if (typeof st.mode === 'string') this._mode = st.mode as TransformationMode;
		if (typeof st.expanded === 'boolean') this._expanded = st.expanded;
		if (typeof st.transformationType === 'string') this._transformationType = st.transformationType as TransformationType;
		if (typeof st.dataSourceId === 'string') this._dataSourceId = st.dataSourceId;
		if (typeof st.distinctColumn === 'string') this._distinctColumn = st.distinctColumn;
		if (Array.isArray(st.deriveColumns)) this._deriveColumns = st.deriveColumns.map((c: any) => ({ name: String(c?.name || ''), expression: String(c?.expression || '') }));
		if (Array.isArray(st.groupByColumns)) {
			const mapped = st.groupByColumns.map((c: any) => String(c || ''));
			this._groupByColumns = mapped.length ? mapped : [''];
		}
		if (Array.isArray(st.aggregations)) this._aggregations = st.aggregations.map((a: any) => ({ name: String(a?.name || ''), function: String(a?.function || 'count'), column: String(a?.column || '') }));
		if (typeof st.pivotRowKeyColumn === 'string') this._pivotRowKeyColumn = st.pivotRowKeyColumn;
		if (typeof st.pivotColumnKeyColumn === 'string') this._pivotColumnKeyColumn = st.pivotColumnKeyColumn;
		if (typeof st.pivotValueColumn === 'string') this._pivotValueColumn = st.pivotValueColumn;
		if (typeof st.pivotAggregation === 'string') this._pivotAggregation = st.pivotAggregation;
		if (typeof st.pivotMaxColumns === 'number') this._pivotMaxColumns = st.pivotMaxColumns;
		if (typeof st.joinRightDataSourceId === 'string') this._joinRightDataSourceId = st.joinRightDataSourceId;
		if (typeof st.joinKind === 'string') this._joinKind = st.joinKind as JoinKind;
		if (Array.isArray(st.joinKeys)) this._joinKeys = st.joinKeys.map((k: any) => ({ left: String(k?.left || ''), right: String(k?.right || '') }));
		if (typeof st.joinOmitDuplicateColumns === 'boolean') this._joinOmitDuplicateColumns = st.joinOmitDuplicateColumns;
	}

	private _writeToGlobalState(): void {
		const w = window;
		if (!w.transformationStateByBoxId) w.transformationStateByBoxId = {};
		const st = w.transformationStateByBoxId[this.boxId] || {};

		st.mode = this._mode;
		st.expanded = this._expanded;
		st.transformationType = this._transformationType;
		st.dataSourceId = this._dataSourceId;
		st.distinctColumn = this._distinctColumn;
		st.deriveColumns = this._deriveColumns.map(c => ({ name: c.name, expression: c.expression }));
		// Keep legacy fields in sync
		const first = this._deriveColumns[0] || { name: '', expression: '' };
		st.deriveColumnName = first.name;
		st.deriveExpression = first.expression;
		st.groupByColumns = [...this._groupByColumns];
		st.aggregations = this._aggregations.map(a => ({ name: a.name, function: a.function, column: a.column }));
		st.pivotRowKeyColumn = this._pivotRowKeyColumn;
		st.pivotColumnKeyColumn = this._pivotColumnKeyColumn;
		st.pivotValueColumn = this._pivotValueColumn;
		st.pivotAggregation = this._pivotAggregation;
		st.pivotMaxColumns = this._pivotMaxColumns;
		st.joinRightDataSourceId = this._joinRightDataSourceId;
		st.joinKind = this._joinKind;
		st.joinKeys = this._joinKeys.map(k => ({ left: k.left, right: k.right }));
		st.joinOmitDuplicateColumns = this._joinOmitDuplicateColumns;

		w.transformationStateByBoxId[this.boxId] = st;
	}

	// ── Data helpers ──────────────────────────────────────────────────────────

	private _refreshDatasets(): void {
		try {
			// Filter out this transformation's own ID to prevent circular dependency.
			const all = __kustoGetChartDatasetsInDomOrder() || [];
			const next = all.filter((d: DatasetEntry) => d.id !== this.id);
			if (this._datasetsEqual(this._datasets, next)) return;
			this._datasets = next;
		} catch (e) { console.error('[kusto]', e); }
	}

	/**
	 * Unconditionally replace the cached datasets with fresh data.
	 * Used by refresh() (the cross-section dependency path) where the upstream
	 * data has changed but the dataset id/label/shape may be identical.
	 */
	private _forceRefreshDatasets(): void {
		try {
			const all = __kustoGetChartDatasetsInDomOrder() || [];
			this._datasets = all.filter((d: DatasetEntry) => d.id !== this.id);
		} catch (e) { console.error('[kusto]', e); }
	}

	private _datasetsEqual(a: DatasetEntry[], b: DatasetEntry[]): boolean {
		if (a === b) return true;
		if (!Array.isArray(a) || !Array.isArray(b)) return false;
		if (a.length !== b.length) return false;
		for (let i = 0; i < a.length; i++) {
			const ai = a[i];
			const bi = b[i];
			if (!ai || !bi) return false;
			if (ai.id !== bi.id || ai.label !== bi.label) return false;
			// Compare column definitions so refreshed query results propagate.
			const aCols = ai.columns;
			const bCols = bi.columns;
			if (aCols.length !== bCols.length) return false;
			for (let c = 0; c < aCols.length; c++) {
				if (aCols[c] !== bCols[c]) return false;
			}
			// Compare row count so data changes propagate even when columns are identical.
			if (ai.rows.length !== bi.rows.length) return false;
		}
		return true;
	}

	private _getColumnNames(): string[] {
		const ds = this._datasets.find(d => d.id === this._dataSourceId);
		if (!ds) return [];
		const cols = Array.isArray(ds.columns) ? ds.columns : [];
		return cols.map((c: string) => normalizeResultsColumnName(c)).filter((c: string) => c);
	}

	// ── Rendering delegation ──────────────────────────────────────────────────

	private _computeTransformation(): void {
		if (!this._expanded) return;

		this._computeTransformationImpl();

		// Sync results to the global results-state map so other sections
		// (charts, other transformations) can use this transformation as a data source.
		this._syncResultsToGlobal();

		// Auto-fit after every recomputation — each config change can alter
		// the output shape (row count, columns, error state).  Mirrors how
		// Kusto/SQL sections auto-fit after every query execution.
		this._autoFitAfterLayout();
	}

	private _syncResultsToGlobal(): void {
		try {
			const w = window;
			const cols = this._resultColumns.map(c => c.name);
			const rows = this._resultRows;
			// Register results directly in the global state map so other sections
			// (charts, other transformations) can use this transformation as a data source.
			setResultsState(this.boxId, {
					boxId: this.boxId,
					columns: cols,
					rows: rows,
					metadata: { transformationType: this._transformationType },
					selectedCell: null, cellSelectionAnchor: null, cellSelectionRange: null,
					selectedRows: new Set(), searchMatches: [], currentSearchIndex: -1,
					sortSpec: [], columnFilters: {}, filteredRowIndices: null,
					displayRowIndices: null, rowIndexToDisplayIndex: null
				});
		} catch (e) { console.error('[kusto]', e); }
	}

	private _computeTransformationImpl(): void {

		this._refreshDatasets();
		const ds = this._datasets.find(d => d.id === this._dataSourceId);
		if (!ds) {
			this._resultColumns = [];
			this._resultRows = [];
			this._resultError = this._dataSourceId
				? 'Data source not found.'
				: 'Select a data source (a query, CSV URL, or transformation section with results).';
			return;
		}

		const colNames = (ds.columns || []).map((c: string) => normalizeResultsColumnName(c)).filter((c: string) => c);
		const colIndex: Record<string, number> = {};
		for (let i = 0; i < colNames.length; i++) {
			colIndex[colNames[i]] = i;
			colIndex[String(colNames[i]).toLowerCase()] = i;
		}
		const rows = Array.isArray(ds.rows) ? ds.rows : [];
		const getRaw = (cell: unknown) => getRawCellValue(cell);
		const tryParseNum = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

		try {
			const type = this._transformationType;

			if (type === 'derive') {
				this._computeDerive(colNames, colIndex, rows, getRaw);
				return;
			}
			if (type === 'summarize') {
				this._computeSummarize(colNames, colIndex, rows, getRaw, tryParseNum);
				return;
			}
			if (type === 'pivot') {
				this._computePivot(colNames, colIndex, rows, getRaw, tryParseNum);
				return;
			}
			if (type === 'distinct') {
				this._computeDistinct(colNames, colIndex, rows, getRaw);
				return;
			}
			if (type === 'join') {
				this._computeJoin(colNames, colIndex, rows, getRaw);
				return;
			}
			this._resultError = 'Unknown transformation type.';
			this._resultColumns = [];
			this._resultRows = [];
		} catch (e: any) {
			this._resultError = e?.message || String(e || 'Failed to compute transformation.');
			this._resultColumns = [];
			this._resultRows = [];
		}
	}

	private _computeDerive(colNames: string[], _colIndex: Record<string, number>, rows: unknown[][], getRaw: (v: unknown) => unknown): void {
		let deriveColumns = this._deriveColumns;
		if (!deriveColumns.length) {
			deriveColumns = [{ name: '', expression: '' }];
		}

		const parsed: { name: string; rpn: ExprToken[] }[] = [];
		for (const d of deriveColumns) {
			const n = String(d.name || '').trim();
			const e = String(d.expression || '').trim();
			if (!n && !e) continue;
			if (!e) continue;
			const name = n || 'derived';
			try {
				const rpn = parseExprToRpn(tokenizeExpr(e));
				parsed.push({ name, rpn });
			} catch { continue; }
		}

		if (!parsed.length) {
			const outRows = rows.map(r => (Array.isArray(r) ? r : []).map(getRaw));
			this._resultColumns = colNames.map(c => ({ name: c }));
			this._resultRows = outRows;
			this._resultError = '';
			return;
		}

		const outCols = colNames.concat(parsed.map(p => p.name));
		const outRows: unknown[][] = [];
		for (const r of rows) {
			const row = Array.isArray(r) ? r : [];
			const baseRawRow = row.map(getRaw);
			const env: Record<string, unknown> = {};
			for (let i = 0; i < colNames.length; i++) {
				env[colNames[i]] = baseRawRow[i];
				env[String(colNames[i]).toLowerCase()] = baseRawRow[i];
			}
			const derivedValues: unknown[] = [];
			for (const p of parsed) {
				let v: unknown = null;
				try { v = evalRpn(p.rpn, env); } catch { v = null; }
				derivedValues.push(v);
				if (p.name) {
					env[p.name] = v;
					env[p.name.toLowerCase()] = v;
				}
			}
			outRows.push(baseRawRow.concat(derivedValues));
		}

		this._resultColumns = outCols.map(c => ({ name: c }));
		this._resultRows = outRows;
		this._resultError = '';
	}

	private _computeSummarize(colNames: string[], colIndex: Record<string, number>, rows: unknown[][], getRaw: (v: unknown) => unknown, tryParseNum: (v: unknown) => number | null): void {
		const groupBy = this._groupByColumns.filter(c => c);
		const aggs = this._aggregations;
		if (!aggs.length) {
			this._resultError = 'Add one or more aggregations.';
			this._resultColumns = [];
			this._resultRows = [];
			return;
		}

		const groups = new Map<string, { gvals: unknown[]; acc: any[] }>();
		for (const r of rows) {
			const row = Array.isArray(r) ? r : [];
			const gvals = groupBy.map(c => {
				const idx = colIndex[c] ?? colIndex[c.toLowerCase()];
				return getRaw(row[idx]);
			});
			const key = JSON.stringify(gvals);
			let g = groups.get(key);
			if (!g) {
				g = { gvals, acc: aggs.map(a => ({
					fn: a.function || 'count', col: a.column || '',
					count: 0, sum: 0, numCount: 0, min: null as any, max: null as any, distinct: new Set<string>(),
				})) };
				groups.set(key, g);
			}
			for (let i = 0; i < g.acc.length; i++) {
				const a = g.acc[i];
				if (a.fn === 'count') { a.count++; continue; }
				const idx = colIndex[a.col] ?? colIndex[a.col.toLowerCase()];
				const raw = getRaw(row[idx]);
				if (a.fn === 'distinct') { a.distinct.add(String(raw)); continue; }
				if (a.fn === 'sum' || a.fn === 'avg') {
					const n = tryParseNum(raw);
					if (n !== null) { a.sum += n; a.numCount++; }
					continue;
				}
				if (a.fn === 'min' || a.fn === 'max') {
					const n = tryParseNum(raw);
					// eslint-disable-next-line eqeqeq
					const v: any = n !== null ? n : (raw == null ? null : String(raw));
					if (v === null) continue;
					if (a.fn === 'min') { if (a.min === null || v < a.min) a.min = v; }
					else { if (a.max === null || v > a.max) a.max = v; }
				}
			}
		}

		const outCols: string[] = [];
		for (const c of groupBy) outCols.push(c);
		for (const a of aggs) {
			const fn = a.function || 'count';
			const col = a.column || '';
			const custom = (a.name || '').trim();
			outCols.push(custom || (fn === 'count' ? 'count()' : `${fn}(${col})`));
		}
		const outRows: unknown[][] = [];
		for (const g of groups.values()) {
			const rowOut = [...g.gvals];
			for (const a of g.acc) {
				if (a.fn === 'count') rowOut.push(a.count);
				else if (a.fn === 'sum') rowOut.push(a.sum);
				else if (a.fn === 'avg') rowOut.push(a.numCount ? a.sum / a.numCount : null);
				else if (a.fn === 'min') rowOut.push(a.min);
				else if (a.fn === 'max') rowOut.push(a.max);
				else if (a.fn === 'distinct') rowOut.push(a.distinct.size);
				else rowOut.push(null);
			}
			outRows.push(rowOut);
		}

		this._resultColumns = outCols.map(c => ({ name: c }));
		this._resultRows = outRows;
		this._resultError = '';
	}

	private _computePivot(colNames: string[], colIndex: Record<string, number>, rows: unknown[][], getRaw: (v: unknown) => unknown, tryParseNum: (v: unknown) => number | null): void {
		const rowKey = this._pivotRowKeyColumn;
		const colKey = this._pivotColumnKeyColumn;
		const valKey = this._pivotValueColumn;
		const agg = this._pivotAggregation || 'sum';
		const maxCols = Math.max(1, Math.min(500, this._pivotMaxColumns || 100));

		if (!rowKey || !colKey) {
			this._resultError = 'Pick Row key and Column key.';
			this._resultColumns = [];
			this._resultRows = [];
			return;
		}
		if (agg !== 'count' && !valKey) {
			this._resultError = 'Pick a Value column (or switch aggregation to count).';
			this._resultColumns = [];
			this._resultRows = [];
			return;
		}

		const rowIdx = colIndex[rowKey] ?? colIndex[rowKey.toLowerCase()];
		const colIdx = colIndex[colKey] ?? colIndex[colKey.toLowerCase()];
		const valIdx = colIndex[valKey] ?? colIndex[valKey.toLowerCase()];
		const pivotCols: string[] = [];
		const pivotColSet = new Set<string>();
		const table = new Map<string, Map<string, any>>();
		const rowOrder: string[] = [];
		const rowSeen = new Set<string>();

		for (const r of rows) {
			const row = Array.isArray(r) ? r : [];
			const rk = getRaw(row[rowIdx]);
			const ck = getRaw(row[colIdx]);
			const ckStr = String(ck ?? '');
			if (!pivotColSet.has(ckStr)) {
				pivotColSet.add(ckStr);
				pivotCols.push(ckStr);
				if (pivotCols.length > maxCols) {
					this._resultError = `Pivot would create too many columns (${pivotCols.length}+). Choose a different column key.`;
					this._resultColumns = [];
					this._resultRows = [];
					return;
				}
			}
			const rkStr = String(rk ?? '');
			if (!rowSeen.has(rkStr)) { rowSeen.add(rkStr); rowOrder.push(rkStr); }
			let rowMap = table.get(rkStr);
			if (!rowMap) { rowMap = new Map(); table.set(rkStr, rowMap); }
			let acc = rowMap.get(ckStr);
			if (!acc) { acc = { count: 0, sum: 0, numCount: 0, first: null }; rowMap.set(ckStr, acc); }
			acc.count++;
			if (agg === 'count') continue;
			const raw = getRaw(row[valIdx]);
			if (agg === 'first') { if (acc.first === null) acc.first = raw; continue; }
			const n = tryParseNum(raw);
			if (n !== null) { acc.sum += n; acc.numCount++; }
		}

		const outCols = [rowKey, ...pivotCols];
		const outRows: unknown[][] = [];
		for (const rk of rowOrder) {
			const rm = table.get(rk) || new Map();
			const out: unknown[] = [rk];
			for (const ck of pivotCols) {
				const acc = rm.get(ck);
				if (!acc) { out.push(null); continue; }
				if (agg === 'count') out.push(acc.count);
				else if (agg === 'first') out.push(acc.first);
				else if (agg === 'avg') out.push(acc.numCount ? acc.sum / acc.numCount : null);
				else out.push(acc.sum);
			}
			outRows.push(out);
		}

		this._resultColumns = outCols.map(c => ({ name: c }));
		this._resultRows = outRows;
		this._resultError = '';
	}

	private _computeDistinct(colNames: string[], colIndex: Record<string, number>, rows: unknown[][], getRaw: (v: unknown) => unknown): void {
		const col = this._distinctColumn;
		if (!col) {
			this._resultError = 'Pick a column.';
			this._resultColumns = [];
			this._resultRows = [];
			return;
		}
		const idx = colIndex[col] ?? colIndex[col.toLowerCase()];
		if (typeof idx !== 'number' || !Number.isFinite(idx)) {
			this._resultError = 'Pick a valid column.';
			this._resultColumns = [];
			this._resultRows = [];
			return;
		}
		const seen = new Set<string>();
		const outRows: unknown[][] = [];
		for (const r of rows) {
			const row = Array.isArray(r) ? r : [];
			const raw = getRaw(row[idx]);
			// eslint-disable-next-line eqeqeq
			const key = raw == null ? 'null' : (typeof raw === 'string' ? 's:' + raw : JSON.stringify(raw));
			if (seen.has(key)) continue;
			seen.add(key);
			outRows.push([raw]);
		}

		this._resultColumns = [{ name: col }];
		this._resultRows = outRows;
		this._resultError = '';
	}

	private _computeJoin(leftColNames: string[], leftColIndex: Record<string, number>, leftRows: unknown[][], getRaw: (v: unknown) => unknown): void {
		const rightDsId = this._joinRightDataSourceId;
		if (!rightDsId) {
			this._resultError = 'Select a right data source.';
			this._resultColumns = [];
			this._resultRows = [];
			return;
		}
		const rightDs = this._datasets.find(d => d.id === rightDsId);
		if (!rightDs) {
			this._resultError = 'Right data source not found.';
			this._resultColumns = [];
			this._resultRows = [];
			return;
		}
		const rightColNames = (rightDs.columns || []).map((c: string) => normalizeResultsColumnName(c)).filter((c: string) => c);
		const rightColIndex: Record<string, number> = {};
		for (let i = 0; i < rightColNames.length; i++) {
			rightColIndex[rightColNames[i]] = i;
			rightColIndex[String(rightColNames[i]).toLowerCase()] = i;
		}
		const rightRows = Array.isArray(rightDs.rows) ? rightDs.rows : [];

		const joinKeys = this._joinKeys.filter(k => k.left && k.right);
		if (!joinKeys.length) {
			this._resultError = 'Select at least one key pair.';
			this._resultColumns = [];
			this._resultRows = [];
			return;
		}

		const kind = this._joinKind;
		const omitDups = this._joinOmitDuplicateColumns;
		const isSemiAnti = kind === 'leftanti' || kind === 'rightanti' || kind === 'leftsemi' || kind === 'rightsemi';

		// Build a hash index on the right side for the join keys.
		const rightKeyIndices = joinKeys.map(k => rightColIndex[k.right] ?? rightColIndex[k.right.toLowerCase()]);
		const leftKeyIndices = joinKeys.map(k => leftColIndex[k.left] ?? leftColIndex[k.left.toLowerCase()]);

		// Validate key indices exist
		for (let i = 0; i < joinKeys.length; i++) {
			if (typeof leftKeyIndices[i] !== 'number' || !Number.isFinite(leftKeyIndices[i])) {
				this._resultError = `Left key column "${joinKeys[i].left}" not found.`;
				this._resultColumns = [];
				this._resultRows = [];
				return;
			}
			if (typeof rightKeyIndices[i] !== 'number' || !Number.isFinite(rightKeyIndices[i])) {
				this._resultError = `Right key column "${joinKeys[i].right}" not found.`;
				this._resultColumns = [];
				this._resultRows = [];
				return;
			}
		}

		const makeKey = (row: unknown[], indices: number[]): string => {
			const parts: unknown[] = [];
			for (const idx of indices) {
				parts.push(getRaw(row[idx]));
			}
			return JSON.stringify(parts);
		};

		// Build hash map: right key -> list of right rows
		const rightMap = new Map<string, unknown[][]>();
		const rightMatched = new Set<number>();
		for (let ri = 0; ri < rightRows.length; ri++) {
			const row = Array.isArray(rightRows[ri]) ? rightRows[ri] : [];
			const key = makeKey(row, rightKeyIndices);
			let list = rightMap.get(key);
			if (!list) { list = []; rightMap.set(key, list); }
			list.push(row);
		}

		// Determine output columns
		// Columns that appear in both left and right sides
		const leftSet = new Set(leftColNames);
		const rightSet = new Set(rightColNames);
		const duplicated = new Set(leftColNames.filter(c => rightSet.has(c)));
		let outColNames: string[];
		if (isSemiAnti) {
			// Semi/anti emit only left columns (for left*) or right columns (for right*)
			if (kind === 'leftsemi' || kind === 'leftanti') {
				outColNames = [...leftColNames];
			} else {
				outColNames = [...rightColNames];
			}
		} else if (omitDups) {
			// Omit duplicate columns: keep left copy for duplicated names, skip right copy
			outColNames = [...leftColNames];
			for (const rc of rightColNames) {
				if (duplicated.has(rc)) continue;
				outColNames.push(rc);
			}
		} else {
			// Include all; prefix Left./Right. only on columns that appear in both sides
			outColNames = leftColNames.map(c => duplicated.has(c) ? 'Left.' + c : c);
			for (const rc of rightColNames) {
				outColNames.push(duplicated.has(rc) ? 'Right.' + rc : rc);
			}
		}

		const outRows: unknown[][] = [];
		const nullRightRow = rightColNames.map(() => null);
		const nullLeftRow = leftColNames.map(() => null);

		const buildOutputRow = (leftRow: unknown[], rightRow: unknown[]): unknown[] => {
			const lr = Array.isArray(leftRow) ? leftRow.map(getRaw) : leftColNames.map(() => null);
			const rr = Array.isArray(rightRow) ? rightRow.map(getRaw) : rightColNames.map(() => null);
			if (isSemiAnti) {
				return (kind === 'leftsemi' || kind === 'leftanti') ? lr : rr;
			}
			if (omitDups) {
				const row = [...lr];
				for (let i = 0; i < rightColNames.length; i++) {
					if (duplicated.has(rightColNames[i])) continue;
					row.push(rr[i]);
				}
				return row;
			}
			return [...lr, ...rr];
		};

		if (kind === 'leftanti') {
			for (const leftRow of leftRows) {
				const row = Array.isArray(leftRow) ? leftRow : [];
				const key = makeKey(row, leftKeyIndices);
				if (!rightMap.has(key)) {
					outRows.push(buildOutputRow(row, nullRightRow));
				}
			}
		} else if (kind === 'rightanti') {
			// Track which right indices matched
			for (const leftRow of leftRows) {
				const row = Array.isArray(leftRow) ? leftRow : [];
				const key = makeKey(row, leftKeyIndices);
				if (rightMap.has(key)) {
					// Mark all matching right rows
					for (let ri = 0; ri < rightRows.length; ri++) {
						const rRow = Array.isArray(rightRows[ri]) ? rightRows[ri] : [];
						const rKey = makeKey(rRow, rightKeyIndices);
						if (rKey === key) rightMatched.add(ri);
					}
				}
			}
			for (let ri = 0; ri < rightRows.length; ri++) {
				if (!rightMatched.has(ri)) {
					const rRow = Array.isArray(rightRows[ri]) ? rightRows[ri] : [];
					outRows.push(buildOutputRow(nullLeftRow, rRow));
				}
			}
		} else if (kind === 'leftsemi') {
			const emittedKeys = new Set<string>();
			for (const leftRow of leftRows) {
				const row = Array.isArray(leftRow) ? leftRow : [];
				const key = makeKey(row, leftKeyIndices);
				if (rightMap.has(key) && !emittedKeys.has(key)) {
					emittedKeys.add(key);
					outRows.push(buildOutputRow(row, nullRightRow));
				}
			}
		} else if (kind === 'rightsemi') {
			const emittedKeys = new Set<string>();
			for (const leftRow of leftRows) {
				const row = Array.isArray(leftRow) ? leftRow : [];
				const key = makeKey(row, leftKeyIndices);
				if (rightMap.has(key)) {
					for (const rRow of rightMap.get(key)!) {
						const rKey = makeKey(rRow, rightKeyIndices);
						if (!emittedKeys.has(rKey)) {
							emittedKeys.add(rKey);
							outRows.push(buildOutputRow(nullLeftRow, rRow));
						}
					}
				}
			}
		} else {
			// inner, leftouter, rightouter, fullouter
			const rightUsed = new Set<string>();

			for (const leftRow of leftRows) {
				const row = Array.isArray(leftRow) ? leftRow : [];
				const key = makeKey(row, leftKeyIndices);
				const matches = rightMap.get(key);
				if (matches && matches.length > 0) {
					rightUsed.add(key);
					for (const rRow of matches) {
						outRows.push(buildOutputRow(row, rRow));
					}
				} else if (kind === 'leftouter' || kind === 'fullouter') {
					outRows.push(buildOutputRow(row, nullRightRow));
				}
			}

			if (kind === 'rightouter' || kind === 'fullouter') {
				for (const rightRow of rightRows) {
					const rRow = Array.isArray(rightRow) ? rightRow : [];
					const key = makeKey(rRow, rightKeyIndices);
					if (!rightUsed.has(key)) {
						outRows.push(buildOutputRow(nullLeftRow, rRow));
					}
				}
			}
		}

		this._resultColumns = outColNames.map(c => ({ name: c }));
		this._resultRows = outRows;
		this._resultError = outRows.length > JOIN_ROW_WARNING_THRESHOLD
			? `Warning: join produced ${outRows.length.toLocaleString()} rows. Performance may be affected.`
			: '';
	}

	private _updateHostClasses(): void {
		this.classList.toggle('is-collapsed', !this._expanded);
	}

	// ── Persistence ───────────────────────────────────────────────────────────

	private _schedulePersist(): void {
		try {
			schedulePersist();
		} catch (e) { console.error('[kusto]', e); }
	}

	/**
	 * Serialize to the .kqlx JSON format.
	 * Output is identical to the original persistence.js transformation section shape.
	 */
	public serialize(): TransformationSectionData {
		const data: TransformationSectionData = {
			id: this.boxId,
			type: 'transformation',
			name: this._name,
			mode: this._mode,
			expanded: this._expanded,
		};

		if (this._dataSourceId) data.dataSourceId = this._dataSourceId;
		if (this._transformationType) data.transformationType = this._transformationType;
		if (this._distinctColumn) data.distinctColumn = this._distinctColumn;

		// Derive columns
		const deriveColumns = this._deriveColumns
			.filter(c => c && typeof c === 'object')
			.map(c => ({ name: String(c.name || ''), expression: String(c.expression || '') }));
		if (deriveColumns.length) data.deriveColumns = deriveColumns;

		// Back-compat: if deriveColumns is empty but legacy fields exist, serialize them
		if (!deriveColumns.length) {
			const w = window;
			const st = w.transformationStateByBoxId?.[this.boxId];
			if (st?.deriveColumnName || st?.deriveExpression) {
				data.deriveColumns = [{ name: st.deriveColumnName || 'derived', expression: st.deriveExpression || '' }];
			}
		}

		// Group-by
		const groupByColumns = this._groupByColumns.filter(c => c);
		if (groupByColumns.length) data.groupByColumns = groupByColumns;

		// Aggregations
		const aggregations = this._aggregations
			.filter(a => a && typeof a === 'object')
			.map(a => ({ name: String(a.name || ''), function: String(a.function || ''), column: String(a.column || '') }));
		if (aggregations.length) data.aggregations = aggregations;

		// Pivot
		if (this._pivotRowKeyColumn) data.pivotRowKeyColumn = this._pivotRowKeyColumn;
		if (this._pivotColumnKeyColumn) data.pivotColumnKeyColumn = this._pivotColumnKeyColumn;
		if (this._pivotValueColumn) data.pivotValueColumn = this._pivotValueColumn;
		if (this._pivotAggregation) data.pivotAggregation = this._pivotAggregation;
		if (typeof this._pivotMaxColumns === 'number') data.pivotMaxColumns = this._pivotMaxColumns;

		// Join
		if (this._joinRightDataSourceId) data.joinRightDataSourceId = this._joinRightDataSourceId;
		if (this._joinKind) data.joinKind = this._joinKind;
		const joinKeys = this._joinKeys.filter(k => k && typeof k === 'object');
		if (joinKeys.length) data.joinKeys = joinKeys.map(k => ({ left: String(k.left || ''), right: String(k.right || '') }));
		data.joinOmitDuplicateColumns = this._joinOmitDuplicateColumns;

		// Wrapper height
		if (this._wrapperHeight > 0) {
			data.editorHeightPx = this._wrapperHeight;
		}

		return data;
	}

	/** Set initial state from options passed by addTransformationBox. */
	public applyOptions(options: Record<string, unknown>): void {
		if (typeof options.name === 'string') this._name = options.name;
		if (typeof options.mode === 'string') this._mode = options.mode as TransformationMode;
		if (typeof options.expanded === 'boolean') this._expanded = options.expanded;
		if (typeof options.transformationType === 'string') this._transformationType = options.transformationType as TransformationType;
		if (typeof options.dataSourceId === 'string') this._dataSourceId = options.dataSourceId;
		if (typeof options.distinctColumn === 'string') this._distinctColumn = options.distinctColumn;
		if (Array.isArray(options.deriveColumns)) {
			this._deriveColumns = (options.deriveColumns as DeriveColumn[]).map(c => ({
				name: String(c?.name || ''),
				expression: String(c?.expression || ''),
			}));
		}
		if (Array.isArray(options.groupByColumns)) {
			const mapped = (options.groupByColumns as string[]).map(c => String(c || ''));
			this._groupByColumns = mapped.length ? mapped : [''];
		}
		if (Array.isArray(options.aggregations)) {
			this._aggregations = (options.aggregations as Aggregation[]).map(a => ({
				name: String(a?.name || ''),
				function: String(a?.function || 'count'),
				column: String(a?.column || ''),
			}));
		}
		if (typeof options.pivotRowKeyColumn === 'string') this._pivotRowKeyColumn = options.pivotRowKeyColumn;
		if (typeof options.pivotColumnKeyColumn === 'string') this._pivotColumnKeyColumn = options.pivotColumnKeyColumn;
		if (typeof options.pivotValueColumn === 'string') this._pivotValueColumn = options.pivotValueColumn;
		if (typeof options.pivotAggregation === 'string') this._pivotAggregation = options.pivotAggregation;
		if (typeof options.pivotMaxColumns === 'number') this._pivotMaxColumns = options.pivotMaxColumns;
		if (typeof options.joinRightDataSourceId === 'string') this._joinRightDataSourceId = options.joinRightDataSourceId;
		if (typeof options.joinKind === 'string') this._joinKind = options.joinKind as JoinKind;
		if (Array.isArray(options.joinKeys)) {
			this._joinKeys = (options.joinKeys as JoinKey[]).map(k => ({
				left: String(k?.left || ''),
				right: String(k?.right || ''),
			}));
		}
		if (typeof options.joinOmitDuplicateColumns === 'boolean') this._joinOmitDuplicateColumns = options.joinOmitDuplicateColumns;
		if (typeof options.editorHeightPx === 'number' && options.editorHeightPx > 0) {
			this._wrapperHeight = Math.round(options.editorHeightPx as number);
		}
	}

	/** Set expanded state. */
	public setExpanded(expanded: boolean): void {
		this._expanded = expanded;
		this._updateHostClasses();
		this._writeToGlobalState();
		if (expanded) {
			this._computeTransformation();
		}
		this._schedulePersist();
	}

	/** Get section name. */
	public getName(): string {
		return this._name;
	}

	/** Set section name programmatically (used by agent tools). */
	public setName(name: string): void {
		this._name = name;
	}

	/** Public refresh — called by cross-section dependency refresh loops. */
	public refresh(): void {
		this._forceRefreshDatasets();
		this._computeTransformation();
	}

	/** Public lightweight refresh — updates only data-source picker options/labels. */
	public refreshDataSources(): void {
		this._refreshDatasets();
	}

	/** Configure from agent tool. */
	public configure(config: Record<string, unknown>): boolean {
		try {
			if (typeof config.dataSourceId === 'string') this._dataSourceId = config.dataSourceId;
			if (typeof config.transformationType === 'string') this._transformationType = config.transformationType as TransformationType;
			if (Array.isArray(config.deriveColumns)) {
				this._deriveColumns = (config.deriveColumns as DeriveColumn[]).map(c => ({
					name: String(c?.name || ''),
					expression: String(c?.expression || ''),
				}));
			}
			if (typeof config.distinctColumn === 'string') this._distinctColumn = config.distinctColumn;
			if (Array.isArray(config.groupByColumns)) {
				const mapped = (config.groupByColumns as string[]).map(c => String(c));
				this._groupByColumns = mapped.length ? mapped : [''];
			}
			if (Array.isArray(config.aggregations)) {
				this._aggregations = (config.aggregations as Aggregation[]).map(a => ({
					name: String(a?.name || ''),
					function: String(a?.function || 'count'),
					column: String(a?.column || ''),
				}));
			}
			if (typeof config.pivotRowKeyColumn === 'string') this._pivotRowKeyColumn = config.pivotRowKeyColumn;
			if (typeof config.pivotColumnKeyColumn === 'string') this._pivotColumnKeyColumn = config.pivotColumnKeyColumn;
			if (typeof config.pivotValueColumn === 'string') this._pivotValueColumn = config.pivotValueColumn;
			if (typeof config.pivotAggregation === 'string') this._pivotAggregation = config.pivotAggregation;
			if (typeof config.pivotMaxColumns === 'number') this._pivotMaxColumns = config.pivotMaxColumns;
			if (typeof config.joinRightDataSourceId === 'string') this._joinRightDataSourceId = config.joinRightDataSourceId;
			if (typeof config.joinKind === 'string') this._joinKind = config.joinKind as JoinKind;
			if (Array.isArray(config.joinKeys)) {
				this._joinKeys = (config.joinKeys as JoinKey[]).map(k => ({
					left: String(k?.left || ''),
					right: String(k?.right || ''),
				}));
			}
			if (typeof config.joinOmitDuplicateColumns === 'boolean') this._joinOmitDuplicateColumns = config.joinOmitDuplicateColumns;

			this._writeToGlobalState();
			this._computeTransformation();
			this._schedulePersist();
			return true;
		} catch {
			return false;
		}
	}
}

export function addTransformationBox(options: Record<string, unknown> = {}): string {
	return KwTransformationSection.addTransformationBox(options);
}

export function removeTransformationBox(boxId: unknown): void {
	const id = String(boxId || '');
	if (!id) return;
	try { __kustoCleanupSectionModeResizeObserver(id); } catch (e) { console.error('[kusto]', e); }
	try {
		const el = document.getElementById(id) as any;
		if (el && el.parentElement) {
			el.parentElement.removeChild(el);
		}
	} catch (e) { console.error('[kusto]', e); }
	const idx = transformationBoxes.indexOf(id);
	if (idx >= 0) transformationBoxes.splice(idx, 1);
	try {
		if (transformationStateByBoxId && typeof transformationStateByBoxId === 'object') {
			delete transformationStateByBoxId[id];
		}
	} catch (e) { console.error('[kusto]', e); }
	try { schedulePersist(); } catch (e) { console.error('[kusto]', e); }
}

export function __kustoConfigureTransformationFromTool(boxId: unknown, config: unknown): boolean {
	try {
		const id = String(boxId || '');
		if (!id) return false;
		if (!config || typeof config !== 'object') return false;

		const el = document.getElementById(id) as any;
		if (el && typeof el.configure === 'function') {
			return el.configure(config);
		}
		return false;
	} catch (err: any) {
		console.error('[Kusto] Error configuring transformation:', err);
		return false;
	}
}

window.__kustoConfigureTransformation = __kustoConfigureTransformationFromTool;
window.__kustoRenderTransformation = __kustoRenderTransformation;
window.__kustoUpdateTransformationBuilderUI = __kustoUpdateTransformationBuilderUI;
window.__kustoGetTransformationState = __kustoGetTransformationState;
window.addTransformationBox = addTransformationBox;

// Declare the custom element type for TypeScript
declare global {
	interface HTMLElementTagNameMap {
		'kw-transformation-section': KwTransformationSection;
	}
}
