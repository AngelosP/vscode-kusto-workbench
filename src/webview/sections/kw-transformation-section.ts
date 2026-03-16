import { LitElement, html, nothing, type PropertyValues, type TemplateResult } from 'lit';
import { styles } from './kw-transformation-section.styles.js';
import { customElement, property, state } from 'lit/decorators.js';
import type { DataTableColumn, DataTableOptions } from '../components/kw-data-table.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type TransformationType = 'derive' | 'summarize' | 'distinct' | 'pivot';
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

const SVG_CLOSE = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" xmlns="http://www.w3.org/2000/svg"><path d="M4 4l8 8"/><path d="M12 4L4 12"/></svg>';
const SVG_EYE = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><path d="M1.5 8c1.8-3.1 4-4.7 6.5-4.7S12.7 4.9 14.5 8c-1.8 3.1-4 4.7-6.5 4.7S3.3 11.1 1.5 8z"/><circle cx="8" cy="8" r="2.1"/></svg>';
const SVG_FIT = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><path d="M3 6V3h3"/><path d="M13 10v3h-3"/><path d="M3 3l4 4"/><path d="M13 13l-4-4"/></svg>';
const SVG_PLUS = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><path d="M8 3.2v9.6"/><path d="M3.2 8h9.6"/></svg>';
const SVG_TRASH = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><path d="M3 5h10"/><path d="M6 5V3.8c0-.4.3-.8.8-.8h2.4c.4 0 .8.3.8.8V5"/><path d="M5.2 5l.6 8.2c0 .5.4.8.8.8h3c.5 0 .8-.4.8-.8l.6-8.2"/><path d="M7 7.4v4.6"/><path d="M9 7.4v4.6"/></svg>';

const TRANSFORM_TYPE_ICONS: Record<string, string> = {
	derive: '<svg viewBox="0 0 32 32" width="32" height="32" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 24h20"/><path d="M10 24V8h12v16"/><path d="M12 12h8"/><path d="M12 16h8"/><path d="M12 20h8"/></svg>',
	summarize: '<svg viewBox="0 0 32 32" width="32" height="32" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 10h20"/><path d="M6 16h14"/><path d="M6 22h10"/><path d="M24 22v-8"/><path d="M21 17l3-3 3 3"/></svg>',
	distinct: '<svg viewBox="0 0 32 32" width="32" height="32" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 10h12"/><path d="M10 16h12"/><path d="M10 22h12"/><circle cx="8" cy="10" r="1.8"/><circle cx="8" cy="16" r="1.8"/><circle cx="8" cy="22" r="1.8"/></svg>',
	pivot: '<svg viewBox="0 0 32 32" width="32" height="32" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="6" width="20" height="20" rx="2"/><path d="M6 14h20"/><path d="M14 6v20"/><path d="M18 10h6"/><path d="M18 18h6"/></svg>',
};

const TRANSFORM_TYPE_LABELS: Record<string, string> = {
	derive: 'Calc. Column',
	summarize: 'Summarize',
	distinct: 'Distinct',
	pivot: 'Pivot',
};

const TRANSFORM_TYPES_ORDERED: TransformationType[] = ['derive', 'summarize', 'distinct', 'pivot'];

const AGG_FUNCTIONS = ['count', 'sum', 'avg', 'min', 'max', 'distinct'];

const PIVOT_AGG_FUNCTIONS = ['sum', 'avg', 'count', 'first'];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function esc(s: unknown): string {
	return String(s ?? '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

// ─── Component ────────────────────────────────────────────────────────────────

@customElement('kw-transformation-section')
export class KwTransformationSection extends LitElement {

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
		this._computeTransformation();
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
		];
		if (triggers.some(k => changed.has(k))) {
			this._writeToGlobalState();
			this._computeTransformation();
		}
	}

	// ── Styles ────────────────────────────────────────────────────────────────

	static override styles = styles;

	// ── Render ─────────────────────────────────────────────────────────────────

	override render(): TemplateResult {
		return html`
			<div class="section-root">
				${this._renderHeader()}
				<div class="tf-wrapper-host ${this._expanded ? '' : 'is-hidden'}" id="tf-wrapper"
					style="height:${this._wrapperHeight}px">
					${this._mode === 'edit' ? this._renderControls() : nothing}
					${this._renderResults()}
					<div class="resizer"
						title="Drag to resize"
						@mousedown=${this._onResizerMouseDown}
						@dblclick=${this._onFitToContents}></div>
				</div>
			</div>
		`;
	}

	// ── Sub-templates ─────────────────────────────────────────────────────────

	private _renderHeader(): TemplateResult {
		return html`
			<div class="section-header">
				<div class="query-name-group">
					<button type="button" class="section-drag-handle" draggable="true" title="Drag to reorder" aria-label="Reorder section">
						<span class="section-drag-handle-glyph" aria-hidden="true">⋮</span>
					</button>
					<input type="text"
						class="query-name"
						placeholder="Transformation name (optional)"
						.value=${this._name}
						@input=${this._onNameInput}
					/>
				</div>
				<div class="section-actions">
					<div class="md-tabs" role="tablist" aria-label="Transformation tools">
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
						<span class="md-tabs-divider" aria-hidden="true"></span>
						<button class="unified-btn-secondary md-tab md-max-btn" type="button"
							@click=${this._onFitToContents}
							title="Fit to contents" aria-label="Fit to contents">
							<span .innerHTML=${SVG_FIT}></span>
						</button>
						<button class="unified-btn-secondary md-tab ${this._expanded ? 'is-active' : ''}"
							type="button" role="tab"
							aria-selected="${this._expanded ? 'true' : 'false'}"
							@click=${this._toggleExpanded}
							title="${this._expanded ? 'Hide' : 'Show'}"
							aria-label="${this._expanded ? 'Hide' : 'Show'}">
							<span .innerHTML=${SVG_EYE}></span>
						</button>
					</div>
					<button class="unified-btn-secondary unified-btn-icon-only close-btn" type="button"
						@click=${this._onRemove}
						title="Remove" aria-label="Remove">
						<span .innerHTML=${SVG_CLOSE}></span>
					</button>
				</div>
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
					.options=${{ label: 'Transformations', showExecutionTime: false, compact: true, hideTopBorder: true } as DataTableOptions}
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
					@chrome-height-change=${() => {
						requestAnimationFrame(() => {
							this._wrapperHeight = this._computeFitHeight();
						});
					}}
				></kw-data-table>
			</div>
		`;
	}

	private _renderControls(): TemplateResult {
		this._refreshDatasets();
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

		return html`
			<div class="tf-row">
				<label>Data</label>
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

	// ── Event handlers ────────────────────────────────────────────────────────

	private _onNameInput(e: Event): void {
		this._name = (e.target as HTMLInputElement).value;
		this._schedulePersist();
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
		this.updateComplete.then(() => {
			// First rAF: Lit has updated the DOM but browser hasn't laid out yet
			requestAnimationFrame(() => {
				// Second rAF: browser has completed layout, measurements are accurate
				requestAnimationFrame(() => {
					this._wrapperHeight = this._computeFitHeight();
					this._schedulePersist();
				});
			});
		});
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
		const dataTable = this.shadowRoot?.querySelector('kw-data-table') as any;
		if (dataTable && typeof dataTable.getContentHeight === 'function') {
			const contentH = dataTable.getContentHeight();
			nonTableH += Math.max(60, contentH);
		} else {
			const resultsArea = wrapper?.querySelector('.results-area') as HTMLElement | null;
			if (resultsArea) {
				nonTableH += Math.ceil(resultsArea.getBoundingClientRect().height);
			}
		}

		return Math.max(80, Math.min(900, Math.ceil(nonTableH)));
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

		const getScrollY = typeof window.__kustoGetScrollY === 'function'
			? window.__kustoGetScrollY as () => number
			: () => 0;

		const startPageY = e.clientY + getScrollY();
		const startHeight = this._wrapperHeight;

		const minH = 80;
		const maxH = this._computeFitHeight();

		const onMove = (moveEvent: MouseEvent) => {
			try {
				if (typeof window.__kustoMaybeAutoScrollWhileDragging === 'function') {
					window.__kustoMaybeAutoScrollWhileDragging(moveEvent.clientY);
				}
			} catch { /* ignore */ }
			const pageY = moveEvent.clientY + getScrollY();
			const delta = pageY - startPageY;
			this._wrapperHeight = Math.max(minH, Math.min(maxH, Math.ceil(startHeight + delta)));
		};

		const onUp = () => {
			document.removeEventListener('mousemove', onMove, true);
			document.removeEventListener('mouseup', onUp, true);
			resizer.classList.remove('is-dragging');
			document.body.style.cursor = prevCursor;
			document.body.style.userSelect = prevSelect;
			this._schedulePersist();
		};

		document.addEventListener('mousemove', onMove, true);
		document.addEventListener('mouseup', onUp, true);
	}

	private _onRemove(): void {
		this.dispatchEvent(new CustomEvent('section-remove', {
			bubbles: true,
			composed: true,
			detail: { boxId: this.boxId },
		}));
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
		this._schedulePersist();
	}

	private _removeDeriveColumn(index: number): void {
		if (this._deriveColumns.length <= 1) return;
		const cols = [...this._deriveColumns];
		cols.splice(index, 1);
		this._deriveColumns = cols;
		this._schedulePersist();
	}

	// ── Derive drag & drop ────────────────────────────────────────────────────

	private _onDeriveDragStart(index: number, e: DragEvent): void {
		this._deriveDragState = { fromIndex: index, overIndex: null, insertAfter: false };
		if (e.dataTransfer) {
			e.dataTransfer.effectAllowed = 'move';
			try { e.dataTransfer.setData('text/plain', 'kusto-derive'); } catch { /* ignore */ }
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
						try { w.__kustoUpdateChartBuilderUI(id); } catch { /* ignore */ }
						try { w.__kustoRenderChart(id); } catch { /* ignore */ }
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
						try { w.__kustoUpdateTransformationBuilderUI(id); } catch { /* ignore */ }
						try { w.__kustoRenderTransformation(id); } catch { /* ignore */ }
					}
				}
			}
		} catch { /* ignore */ }
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
		this._schedulePersist();
	}

	private _removeAgg(index: number): void {
		if (this._aggregations.length <= 1) return;
		const aggs = [...this._aggregations];
		aggs.splice(index, 1);
		this._aggregations = aggs;
		this._schedulePersist();
	}

	// ── Aggregation drag & drop ───────────────────────────────────────────────

	private _onAggDragStart(index: number, e: DragEvent): void {
		this._aggDragState = { fromIndex: index, overIndex: null, insertAfter: false };
		if (e.dataTransfer) {
			e.dataTransfer.effectAllowed = 'move';
			try { e.dataTransfer.setData('text/plain', 'kusto-agg'); } catch { /* ignore */ }
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
		this._schedulePersist();
	}

	private _removeGroupByColumn(index: number): void {
		if (this._groupByColumns.length <= 1) return;
		const cols = [...this._groupByColumns];
		cols.splice(index, 1);
		this._groupByColumns = cols;
		this._schedulePersist();
	}

	// ── Group-by drag & drop ──────────────────────────────────────────────────

	private _onGroupByDragStart(index: number, e: DragEvent): void {
		this._groupByDragState = { fromIndex: index, overIndex: null, insertAfter: false };
		if (e.dataTransfer) {
			e.dataTransfer.effectAllowed = 'move';
			try { e.dataTransfer.setData('text/plain', 'kusto-groupby'); } catch { /* ignore */ }
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

		w.transformationStateByBoxId[this.boxId] = st;
	}

	// ── Data helpers ──────────────────────────────────────────────────────────

	private _refreshDatasets(): void {
		try {
			const fn = window.__kustoGetChartDatasetsInDomOrder;
			if (typeof fn === 'function') {
				// Filter out this transformation's own ID to prevent circular dependency.
				const all = fn() || [];
				this._datasets = all.filter((d: DatasetEntry) => d.id !== this.id);
			}
		} catch { /* ignore */ }
	}

	private _getColumnNames(): string[] {
		const ds = this._datasets.find(d => d.id === this._dataSourceId);
		if (!ds) return [];
		const norm = window.__kustoNormalizeResultsColumnName;
		const cols = Array.isArray(ds.columns) ? ds.columns : [];
		if (typeof norm === 'function') {
			return cols.map((c: string) => norm(c)).filter((c: string) => c);
		}
		return cols.filter((c: string) => c);
	}

	// ── Rendering delegation ──────────────────────────────────────────────────

	private _computeTransformation(): void {
		if (!this._expanded) return;

		this._computeTransformationImpl();

		// Sync results to the global results-state map so other sections
		// (charts, other transformations) can use this transformation as a data source.
		this._syncResultsToGlobal();
	}

	private _syncResultsToGlobal(): void {
		try {
			const w = window;
			const cols = this._resultColumns.map(c => c.name);
			const rows = this._resultRows;
			// Register results directly in the global state map so other sections
			// (charts, other transformations) can use this transformation as a data source.
			if (typeof w.__kustoSetResultsState === 'function') {
				w.__kustoSetResultsState(this.boxId, {
					boxId: this.boxId,
					columns: cols,
					rows: rows,
					metadata: { transformationType: this._transformationType },
					selectedCell: null, cellSelectionAnchor: null, cellSelectionRange: null,
					selectedRows: new Set(), searchMatches: [], currentSearchIndex: -1,
					sortSpec: [], columnFilters: {}, filteredRowIndices: null,
					displayRowIndices: null, rowIndexToDisplayIndex: null
				});
			}
		} catch { /* ignore */ }
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

		const w = window;
		const norm = typeof w.__kustoNormalizeResultsColumnName === 'function'
			? w.__kustoNormalizeResultsColumnName : (c: string) => c;
		const colNames = (ds.columns || []).map((c: string) => norm(c)).filter((c: string) => c);
		const colIndex: Record<string, number> = {};
		for (let i = 0; i < colNames.length; i++) {
			colIndex[colNames[i]] = i;
			colIndex[String(colNames[i]).toLowerCase()] = i;
		}
		const rows = Array.isArray(ds.rows) ? ds.rows : [];
		const getRaw = typeof w.__kustoGetRawCellValueForTransform === 'function'
			? w.__kustoGetRawCellValueForTransform
			: (cell: unknown) => {
				if (cell && typeof cell === 'object') {
					if ('full' in (cell as any)) return (cell as any).full;
					if ('display' in (cell as any)) return (cell as any).display;
				}
				return cell;
			};
		const tryParseNum = typeof w.__kustoTryParseFiniteNumber === 'function'
			? w.__kustoTryParseFiniteNumber
			: (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

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
		const w = window;
		let deriveColumns = this._deriveColumns;
		if (!deriveColumns.length) {
			deriveColumns = [{ name: '', expression: '' }];
		}

		const tokenize = w.__kustoTokenizeExpr;
		const parseRpn = w.__kustoParseExprToRpn;
		const evalRpn = w.__kustoEvalRpn;
		if (typeof tokenize !== 'function' || typeof parseRpn !== 'function' || typeof evalRpn !== 'function') {
			// Fallback: show base dataset without derived columns
			const outRows = rows.map(r => (Array.isArray(r) ? r : []).map(getRaw));
			this._resultColumns = colNames.map(c => ({ name: c }));
			this._resultRows = outRows;
			this._resultError = '';
			return;
		}

		const parsed: { name: string; rpn: unknown[] }[] = [];
		for (const d of deriveColumns) {
			const n = String(d.name || '').trim();
			const e = String(d.expression || '').trim();
			if (!n && !e) continue;
			if (!e) continue;
			const name = n || 'derived';
			try {
				const rpn = parseRpn(tokenize(e));
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

	private _updateHostClasses(): void {
		this.classList.toggle('is-collapsed', !this._expanded);
	}

	// ── Persistence ───────────────────────────────────────────────────────────

	private _schedulePersist(): void {
		try {
			const sp = window.schedulePersist;
			if (typeof sp === 'function') sp();
		} catch { /* ignore */ }
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
		if (typeof options.editorHeightPx === 'number' && options.editorHeightPx > 0) {
			this._wrapperHeight = Math.round(options.editorHeightPx as number);
		}
	}

	/** Public refresh — called by cross-section dependency refresh loops. */
	public refresh(): void {
		this._refreshDatasets();
		this._computeTransformation();
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

			this._writeToGlobalState();
			this._computeTransformation();
			this._schedulePersist();
			return true;
		} catch {
			return false;
		}
	}
}

// Declare the custom element type for TypeScript
declare global {
	interface HTMLElementTagNameMap {
		'kw-transformation-section': KwTransformationSection;
	}
}
