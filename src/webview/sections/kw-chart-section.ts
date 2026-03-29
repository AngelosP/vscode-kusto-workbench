import { LitElement, html, nothing, type PropertyValues, type TemplateResult } from 'lit';
import { styles } from './kw-chart-section.styles.js';
import { customElement, property, state } from 'lit/decorators.js';
import { pushDismissable, removeDismissable } from '../components/dismiss-stack.js';
import { schedulePersist } from '../core/persistence.js';
import { getScrollY, maybeAutoScrollWhileDragging } from '../core/utils.js';
import {
	maximizeChartBox,
	disposeChartEcharts,
	renderChart,
	getChartState,
	getChartMinResizeHeight,
} from '../shared/chart-renderer.js';
import {
	__kustoGetChartValidationStatus,
	__kustoCleanupSectionModeResizeObserver,
} from '../core/section-factory.js';
import {
	getDefaultXAxisSettings,
	getDefaultYAxisSettings,
	hasCustomXAxisSettings,
	hasCustomYAxisSettings,
	hasCustomLabelSettings,
	normalizeLegendPosition,
	normalizeStackMode,
	type XAxisSettings,
	type YAxisSettings,
	type LegendPosition,
	type StackMode,
} from '../shared/chart-utils.js';
import '../components/kw-section-shell.js';
import '../components/kw-popover.js';
import type { PopoverAnchorRect } from '../components/kw-popover.js';
import { ChartDataSourceController, type DatasetEntry } from './chart-data-source.controller.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ChartType = 'line' | 'area' | 'bar' | 'scatter' | 'pie' | 'funnel' | '';
export type ChartMode = 'edit' | 'preview';
export type { LegendPosition, StackMode, XAxisSettings, YAxisSettings };
export type SortDirection = 'asc' | 'desc' | '';
export type ScaleType = 'category' | 'continuous' | '';
export type LabelMode = 'auto' | 'all' | 'top5' | 'top10' | 'topPercent';

/** Serialized shape for .kqlx persistence — must match KqlxSectionV1 chart variant. */
export interface ChartSectionData {
	id: string;
	type: 'chart';
	name: string;
	mode: ChartMode;
	expanded: boolean;
	dataSourceId?: string;
	chartType?: string;
	xColumn?: string;
	yColumn?: string;
	yColumns?: string[];
	tooltipColumns?: string[];
	legendColumn?: string;
	legendPosition?: string;
	stackMode?: string;
	labelColumn?: string;
	valueColumn?: string;
	showDataLabels?: boolean;
	labelMode?: string;
	labelDensity?: number;
	sortColumn?: string;
	sortDirection?: string;
	xAxisSettings?: Partial<XAxisSettings>;
	yAxisSettings?: Partial<YAxisSettings>;
	editorHeightPx?: number;
	validation?: unknown;
}

// ─── Default axis settings (re-exported from shared) ─────────────────────────

const defaultXAxisSettings = getDefaultXAxisSettings;
const defaultYAxisSettings = getDefaultYAxisSettings;

// ─── SVG icon constants ───────────────────────────────────────────────────────

const CHART_TYPE_ICONS: Record<string, string> = {
	line: '<svg viewBox="0 0 32 32" width="32" height="32" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4,24 10,16 16,20 22,8 28,12"/></svg>',
	area: '<svg viewBox="0 0 32 32" width="32" height="32" fill="currentColor" fill-opacity="0.3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4,24 L10,16 L16,20 L22,8 L28,12 L28,28 L4,28 Z"/></svg>',
	bar: '<svg viewBox="0 0 32 32" width="32" height="32" fill="currentColor" fill-opacity="0.7"><rect x="4" y="16" width="5" height="12" rx="1"/><rect x="11" y="10" width="5" height="18" rx="1"/><rect x="18" y="14" width="5" height="14" rx="1"/><rect x="25" y="6" width="5" height="22" rx="1"/></svg>',
	scatter: '<svg viewBox="0 0 32 32" width="32" height="32" fill="currentColor"><circle cx="8" cy="20" r="2.5"/><circle cx="14" cy="12" r="2.5"/><circle cx="20" cy="18" r="2.5"/><circle cx="26" cy="8" r="2.5"/><circle cx="11" cy="24" r="2.5"/><circle cx="23" cy="22" r="2.5"/></svg>',
	pie: '<svg viewBox="0 0 32 32" width="32" height="32" fill="none" stroke="currentColor" stroke-width="2"><circle cx="16" cy="16" r="12" fill="currentColor" fill-opacity="0.2"/><path d="M16,16 L16,4 A12,12 0 0,1 27.2,20.8 Z" fill="currentColor" fill-opacity="0.5"/><path d="M16,16 L27.2,20.8 A12,12 0 0,1 8,25.6 Z" fill="currentColor" fill-opacity="0.7"/></svg>',
	funnel: '<svg viewBox="0 0 32 32" width="32" height="32" fill="currentColor" fill-opacity="0.7"><path d="M4,4 L28,4 L28,7 L4,7 Z"/><path d="M6,9 L26,9 L26,12 L6,12 Z" fill-opacity="0.6"/><path d="M8,14 L24,14 L24,17 L8,17 Z" fill-opacity="0.5"/><path d="M10,19 L22,19 L22,22 L10,22 Z" fill-opacity="0.4"/><path d="M12,24 L20,24 L20,27 L12,27 Z" fill-opacity="0.3"/></svg>',
};

const CHART_TYPE_LABELS: Record<string, string> = {
	line: 'Line', area: 'Area', bar: 'Bar', scatter: 'Scatter', pie: 'Pie', funnel: 'Funnel',
};

const CHART_TYPES_ORDERED: ChartType[] = ['area', 'bar', 'funnel', 'line', 'pie', 'scatter'];

const LEGEND_POSITION_ICONS: Record<LegendPosition, string> = {
	top: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="5" width="10" height="8" rx="1"/><path d="M3 3h10"/></svg>',
	bottom: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="3" width="10" height="8" rx="1"/><path d="M3 13h10"/></svg>',
	left: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><rect x="5" y="3" width="8" height="10" rx="1"/><path d="M3 3v10"/></svg>',
	right: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="3" width="8" height="10" rx="1"/><path d="M13 3v10"/></svg>',
};

const LEGEND_CYCLE = ['top', 'right', 'bottom', 'left'] as const;

const STACK_MODE_ICONS: Record<StackMode, string> = {
	normal: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.2" xmlns="http://www.w3.org/2000/svg"><rect x="1" y="8" width="4" height="6" rx="0.5"/><rect x="6" y="4" width="4" height="10" rx="0.5"/><rect x="11" y="6" width="4" height="8" rx="0.5"/></svg>',
	stacked: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.2" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="3" width="4" height="11" rx="0.5"/><path d="M3 8h4"/><rect x="9" y="5" width="4" height="9" rx="0.5"/><path d="M9 9h4"/></svg>',
	stacked100: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.2" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="3" width="4" height="11" rx="0.5"/><path d="M3 7h4"/><rect x="9" y="3" width="4" height="11" rx="0.5"/><path d="M9 9h4"/></svg>',
};

const STACK_MODE_LABELS: Record<StackMode, string> = {
	normal: 'Normal',
	stacked: 'Stacked',
	stacked100: 'Stacked 100%',
};

const STACK_MODE_CYCLE: StackMode[] = ['normal', 'stacked', 'stacked100'];

const SVG_CARET = '<svg width="12" height="12" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M7.976 10.072l4.357-4.357.62.618L8.284 11h-.618L3 6.333l.619-.618 4.357 4.357z" fill="currentColor"/></svg>';

// Keep legacy global state arrays/maps in one place.
window.chartStateByBoxId = window.chartStateByBoxId || {};
window.__kustoChartBoxes = window.__kustoChartBoxes || [];
export const chartBoxes: string[] = window.__kustoChartBoxes;

// Re-export rendering functions for existing callers.
export {
	getChartState as __kustoGetChartState,
	renderChart as __kustoRenderChart,
	disposeChartEcharts as __kustoDisposeChartEcharts,
	maximizeChartBox as __kustoMaximizeChartBox,
	getChartMinResizeHeight as __kustoGetChartMinResizeHeight,
};

export function __kustoUpdateChartBuilderUI(boxId: unknown): void {
	const id = String(boxId || '');
	if (!id) return;
	try {
		const el = document.getElementById(id) as any;
		if (el && typeof el.refreshDatasets === 'function') {
			if (typeof el.syncFromGlobalState === 'function') el.syncFromGlobalState();
			el.refreshDatasets();
		}
	} catch (e) { console.error('[kusto]', e); }
}

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

/**
 * `<kw-chart-section>` — Lit web component for a Chart section in the
 * Kusto Workbench notebook. Renders chart configuration UI in shadow DOM
 * and delegates ECharts rendering to light DOM via <slot>.
 */
@customElement('kw-chart-section')
export class KwChartSection extends LitElement {
	public static addChartBox(options: Record<string, unknown> = {}): string {
		const id = typeof options.id === 'string' && options.id
			? String(options.id)
			: ('chart_' + Date.now());
		chartBoxes.push(id);

		const st = getChartState(id);
		st.mode = (typeof options.mode === 'string' && String(options.mode).toLowerCase() === 'preview') ? 'preview' : 'edit';
		st.expanded = typeof options.expanded === 'boolean' ? !!options.expanded : true;
		st.dataSourceId = typeof options.dataSourceId === 'string' ? String(options.dataSourceId) : (st.dataSourceId || '');
		st.chartType = typeof options.chartType === 'string' ? String(options.chartType) : (st.chartType || 'area');
		st.xColumn = typeof options.xColumn === 'string' ? String(options.xColumn) : (st.xColumn || '');
		st.yColumn = typeof options.yColumn === 'string' ? String(options.yColumn) : (st.yColumn || '');
		st.yColumns = Array.isArray(options.yColumns)
			? options.yColumns.filter((c: unknown) => c)
			: (st.yColumns || (st.yColumn ? [st.yColumn] : []));
		st.legendColumn = typeof options.legendColumn === 'string' ? String(options.legendColumn) : (st.legendColumn || '');
		st.legendPosition = typeof options.legendPosition === 'string' ? String(options.legendPosition) : (st.legendPosition || 'top');
		st.stackMode = typeof options.stackMode === 'string' ? String(options.stackMode) : (st.stackMode || 'normal');
		st.labelColumn = typeof options.labelColumn === 'string' ? String(options.labelColumn) : (st.labelColumn || '');
		st.valueColumn = typeof options.valueColumn === 'string' ? String(options.valueColumn) : (st.valueColumn || '');
		st.showDataLabels = typeof options.showDataLabels === 'boolean' ? !!options.showDataLabels : (st.showDataLabels || false);
		st.labelMode = typeof options.labelMode === 'string' ? String(options.labelMode) : (st.labelMode || 'auto');
		st.labelDensity = typeof options.labelDensity === 'number' ? options.labelDensity : (typeof st.labelDensity === 'number' ? st.labelDensity : 50);
		st.tooltipColumns = Array.isArray(options.tooltipColumns)
			? options.tooltipColumns.filter((c: unknown) => c)
			: (Array.isArray(st.tooltipColumns) ? st.tooltipColumns : []);
		st.sortColumn = typeof options.sortColumn === 'string' ? String(options.sortColumn) : (st.sortColumn || '');
		st.sortDirection = typeof options.sortDirection === 'string' ? String(options.sortDirection) : (st.sortDirection || '');
		if (options.xAxisSettings && typeof options.xAxisSettings === 'object') {
			st.xAxisSettings = { ...getDefaultXAxisSettings(), ...st.xAxisSettings, ...options.xAxisSettings };
		}
		if (options.yAxisSettings && typeof options.yAxisSettings === 'object') {
			st.yAxisSettings = { ...getDefaultYAxisSettings(), ...st.yAxisSettings, ...options.yAxisSettings };
		}

		const container = document.getElementById('queries-container');
		if (!container) return id;

		const litEl = document.createElement('kw-chart-section') as KwChartSection;
		litEl.id = id;
		litEl.setAttribute('box-id', id);
		if (typeof options.editorHeightPx === 'number') {
			litEl.setAttribute('editor-height-px', String(options.editorHeightPx));
		}

		const chartWrapper = document.createElement('div');
		chartWrapper.id = id + '_chart_wrapper';
		chartWrapper.className = 'query-editor-wrapper';
		chartWrapper.setAttribute('slot', 'chart-content');
		chartWrapper.style.border = 'none';
		chartWrapper.style.overflow = 'visible';
		chartWrapper.style.height = 'auto';
		chartWrapper.style.minHeight = '0';

		const editContainer = document.createElement('div');
		editContainer.id = id + '_chart_edit';
		editContainer.style.display = 'flex';
		editContainer.style.flexDirection = 'column';
		editContainer.style.height = '100%';
		editContainer.style.minHeight = '0';

		const canvasEdit = document.createElement('div');
		canvasEdit.className = 'kusto-chart-canvas';
		canvasEdit.id = id + '_chart_canvas_edit';
		canvasEdit.style.minHeight = '140px';
		canvasEdit.style.flex = '1 1 auto';
		editContainer.appendChild(canvasEdit);
		chartWrapper.appendChild(editContainer);

		const previewContainer = document.createElement('div');
		previewContainer.id = id + '_chart_preview';
		previewContainer.style.display = 'none';
		previewContainer.style.flexDirection = 'column';
		previewContainer.style.height = '100%';
		previewContainer.style.minHeight = '0';

		const canvasPreview = document.createElement('div');
		canvasPreview.className = 'kusto-chart-canvas';
		canvasPreview.id = id + '_chart_canvas_preview';
		canvasPreview.style.minHeight = '140px';
		canvasPreview.style.flex = '1 1 auto';
		previewContainer.appendChild(canvasPreview);
		chartWrapper.appendChild(previewContainer);

		const resizerEl = document.createElement('div');
		resizerEl.id = id + '_chart_resizer';
		resizerEl.className = 'query-editor-resizer chart-bottom-resizer';
		resizerEl.title = 'Drag to resize\nDouble-click to fit to contents';
		resizerEl.setAttribute('slot', 'chart-resizer');
		litEl.appendChild(chartWrapper);
		litEl.appendChild(resizerEl);

		litEl.applyOptions(st);
		litEl.addEventListener('section-remove', (e: any) => {
			try {
				const detail = e && e.detail ? e.detail : {};
				const removeId = detail.boxId || id;
				removeChartBox(removeId);
			} catch (err) { console.error('[kusto]', err); }
		});

		container.insertAdjacentElement('beforeend', litEl);

		resizerEl.addEventListener('dblclick', () => {
			try { maximizeChartBox(id); } catch (e) { console.error('[kusto]', e); }
		});
		resizerEl.addEventListener('mousedown', (e: MouseEvent) => {
			try { e.preventDefault(); e.stopPropagation(); } catch (err) { console.error('[kusto]', err); }
			try { chartWrapper.dataset.kustoUserResized = 'true'; } catch (err) { console.error('[kusto]', err); }
			resizerEl.classList.add('is-dragging');
			const prevCursor = document.body.style.cursor;
			const prevUserSelect = document.body.style.userSelect;
			document.body.style.cursor = 'ns-resize';
			document.body.style.userSelect = 'none';
			const startPageY = e.clientY + getScrollY();
			const startHeight = chartWrapper.getBoundingClientRect().height;
			try { chartWrapper.style.height = Math.max(0, Math.ceil(startHeight)) + 'px'; } catch (err) { console.error('[kusto]', err); }
			const maxH = 900;
			const onMove = (moveEvent: MouseEvent) => {
				try { maybeAutoScrollWhileDragging(moveEvent.clientY); } catch (err) { console.error('[kusto]', err); }
				const pageY = moveEvent.clientY + getScrollY();
				const delta = pageY - startPageY;
				const currentMinH = getChartMinResizeHeight(id);
				const nextHeight = Math.max(currentMinH, Math.min(maxH, startHeight + delta));
				chartWrapper.style.height = nextHeight + 'px';
				try { renderChart(id); } catch (err) { console.error('[kusto]', err); }
			};
			const onUp = () => {
				document.removeEventListener('mousemove', onMove, true);
				document.removeEventListener('mouseup', onUp, true);
				resizerEl.classList.remove('is-dragging');
				document.body.style.cursor = prevCursor;
				document.body.style.userSelect = prevUserSelect;
				try { schedulePersist(); } catch (err) { console.error('[kusto]', err); }
				try { renderChart(id); } catch (err) { console.error('[kusto]', err); }
			};
			document.addEventListener('mousemove', onMove, true);
			document.addEventListener('mouseup', onUp, true);
		});

		try { schedulePersist(); } catch (e) { console.error('[kusto]', e); }
		try {
			const controls = document.querySelector('.add-controls');
			if (controls && typeof controls.scrollIntoView === 'function') {
				controls.scrollIntoView({ block: 'end' });
			}
		} catch (e) { console.error('[kusto]', e); }

		return id;
	}

	// ── Public properties ─────────────────────────────────────────────────────

	@property({ type: String, reflect: true, attribute: 'box-id' })
	boxId = '';

	@property({ type: Number, attribute: 'editor-height-px' })
	editorHeightPx: number | undefined = undefined;

	// ── Internal state ────────────────────────────────────────────────────────

	@state() private _name = '';
	@state() private _mode: ChartMode = 'edit';
	@state() private _expanded = true;
	@state() private _chartType: ChartType = 'area';
	@state() private _dataSourceId = '';
	@state() private _xColumn = '';
	@state() private _yColumns: string[] = [];
	@state() private _legendColumn = '';
	@state() private _legendPosition: LegendPosition = 'top';
	@state() private _stackMode: StackMode = 'normal';
	@state() private _labelColumn = '';
	@state() private _valueColumn = '';
	@state() private _showDataLabels = false;
	@state() private _labelMode: LabelMode = 'auto';
	@state() private _labelDensity = 50;
	@state() private _tooltipColumns: string[] = [];
	@state() private _sortColumn = '';
	@state() private _sortDirection: SortDirection = '';
	@state() private _xAxisSettings: XAxisSettings = defaultXAxisSettings();
	@state() private _yAxisSettings: YAxisSettings = defaultYAxisSettings();

	// Datasets available for selection
	@state() private _datasets: DatasetEntry[] = [];

	// UI sub-state
	@state() private _modeDropdownOpen = false;
	@state() private _openDropdownId = '';
	@state() private _openAxisPopup: '' | 'x' | 'y' | 'labels' = '';
	@state() private _popoverAnchorRect: PopoverAnchorRect | null = null;

	private _userResized = false;
	private _closeDropdownBound = this._closeDropdownOnClickOutside.bind(this);
	private _closeAllPopupsOnScrollBound = this._closeAllPopupsOnScroll.bind(this);
	private _onChartAxisTitleClickBound = this._onChartAxisTitleClick.bind(this) as EventListener;
	private _scrollAtPopupOpen = 0;

	// Stable dismiss callbacks for dismiss stack
	private _dismissDropdown = (): void => { this._openDropdownId = ''; document.removeEventListener('mousedown', this._closeDropdownBound); };
	private _dismissModeDropdown = (): void => { this._modeDropdownOpen = false; };
	private _themeObserver: MutationObserver | null = null;
	private _lastThemeDark: boolean | null = null;

	// ── ReactiveController ────────────────────────────────────────────────────
	public dataSourceCtrl = new ChartDataSourceController(this as any);

	// ── ChartSectionHost interface for dataSourceCtrl ──────────────────────────
	getDataSourceId(): string { return this._dataSourceId; }
	setDataSourceId(id: string): void { this._dataSourceId = id; }
	getDatasets(): DatasetEntry[] { return this._datasets; }
	setDatasets(ds: DatasetEntry[]): void { this._datasets = ds; }
	getXColumn(): string { return this._xColumn; }
	setXColumn(v: string): void { this._xColumn = v; }
	getYColumns(): string[] { return this._yColumns; }
	setYColumns(v: string[]): void { this._yColumns = v; }
	getLegendColumn(): string { return this._legendColumn; }
	setLegendColumn(v: string): void { this._legendColumn = v; }
	getStackMode(): StackMode { return this._stackMode; }
	setStackMode(v: StackMode): void { this._stackMode = v; }
	getLabelColumn(): string { return this._labelColumn; }
	setLabelColumn(v: string): void { this._labelColumn = v; }
	getValueColumn(): string { return this._valueColumn; }
	setValueColumn(v: string): void { this._valueColumn = v; }
	getTooltipColumns(): string[] { return this._tooltipColumns; }
	setTooltipColumns(v: string[]): void { this._tooltipColumns = v; }
	getSortColumn(): string { return this._sortColumn; }
	setSortColumn(v: string): void { this._sortColumn = v; }
	getXAxisSettings(): XAxisSettings { return this._xAxisSettings; }
	setXAxisSettings(v: XAxisSettings): void { this._xAxisSettings = v; }
	getYAxisSettings(): YAxisSettings { return this._yAxisSettings; }
	setYAxisSettings(v: YAxisSettings): void { this._yAxisSettings = v; }

	// ── Lifecycle ─────────────────────────────────────────────────────────────

	override connectedCallback(): void {
		super.connectedCallback();
		this._syncGlobalChartState();
		this._setupThemeObserver();
		this.addEventListener('kusto-axis-title-click', this._onChartAxisTitleClickBound);
		// Close fixed-position popups/dropdowns when the page scrolls so they
		// don't float detached from their anchor buttons.
		window.addEventListener('scroll', this._closeAllPopupsOnScrollBound, { capture: true, passive: true });
		// Register public API for tool configuration
		(this as any).__kustoLitChart = true;
	}

	override disconnectedCallback(): void {
		super.disconnectedCallback();
		this.removeEventListener('kusto-axis-title-click', this._onChartAxisTitleClickBound);
		document.removeEventListener('mousedown', this._closeDropdownBound);
		window.removeEventListener('scroll', this._closeAllPopupsOnScrollBound, { capture: true });
		removeDismissable(this._dismissDropdown);
		removeDismissable(this._dismissModeDropdown);
		this._themeObserver?.disconnect();
		this._themeObserver = null;
	}

	override firstUpdated(_changedProperties: PropertyValues): void {
		super.firstUpdated(_changedProperties);

		// Apply persisted height to the light-DOM wrapper
		if (this.editorHeightPx && this.editorHeightPx > 0) {
			const wrapper = document.getElementById(this.boxId + '_chart_wrapper');
			if (wrapper) {
				const clamped = Math.round(this.editorHeightPx);
				wrapper.style.height = clamped + 'px';
				wrapper.dataset.kustoUserResized = 'true';
			}
		}

		this._refreshDatasets();
		this._updateHostClasses();
		this._applyModeToDom();
		this._writeToGlobalChartState();
		this._renderChart();
	}

	override updated(changed: PropertyValues): void {
		super.updated(changed);

		if (changed.has('_expanded')) {
			this._updateHostClasses();
		}

		// Manage dismiss stack for dropdowns
		if (changed.has('_openDropdownId')) {
			if (this._openDropdownId) pushDismissable(this._dismissDropdown);
			else removeDismissable(this._dismissDropdown);
		}
		if (changed.has('_modeDropdownOpen')) {
			if (this._modeDropdownOpen) pushDismissable(this._dismissModeDropdown);
			else removeDismissable(this._dismissModeDropdown);
		}

		// Re-render chart when key properties change
		const chartTriggers = [
			'_chartType', '_dataSourceId', '_xColumn', '_yColumns', '_legendColumn',
			'_legendPosition', '_stackMode', '_labelColumn', '_valueColumn', '_showDataLabels',
			'_labelMode', '_labelDensity', '_tooltipColumns', '_sortColumn',
			'_sortDirection', '_xAxisSettings', '_yAxisSettings',
		];
		if (chartTriggers.some(k => changed.has(k))) {
			this._writeToGlobalChartState();
			this._renderChart();
		}
	}

	// ── Styles ────────────────────────────────────────────────────────────────

	static override styles = styles;
	// ── Render ─────────────────────────────────────────────────────────────────

	override render(): TemplateResult {
		const isXY = this._chartType === 'line' || this._chartType === 'area' || this._chartType === 'bar' || this._chartType === 'scatter';
		const isPieOrFunnel = this._chartType === 'pie' || this._chartType === 'funnel';
		const supportsLegend = this._chartType === 'line' || this._chartType === 'area' || this._chartType === 'bar';
		const isFunnel = this._chartType === 'funnel';
		const colNames = this._getColumnNames();
		const multiYSelected = this._yColumns.length > 1;

		return html`
			<div class="section-root">
				<kw-section-shell
					.name=${this._name}
					.expanded=${this._expanded}
					box-id=${this.boxId}
					name-placeholder="Chart name (optional)"
					@name-change=${this._onShellNameChange}
					@toggle-visibility=${this._toggleVisibility}
					@fit-to-contents=${this._onFitToContents}>
					<div slot="header-buttons" class="chart-mode-buttons">
						<button class="unified-btn-secondary md-tab md-mode-btn mode-btn ${this._mode === 'edit' ? 'is-active' : ''}"
							type="button" role="tab" aria-selected=${this._mode === 'edit' ? 'true' : 'false'}
							@click=${() => this._setMode('edit')} title="Edit">Edit</button>
						<button class="unified-btn-secondary md-tab md-mode-btn mode-btn ${this._mode === 'preview' ? 'is-active' : ''}"
							type="button" role="tab" aria-selected=${this._mode === 'preview' ? 'true' : 'false'}
							@click=${() => this._setMode('preview')} title="Preview">Preview</button>
					</div>

				<!-- Chart content: wrapper + canvases + resizer in light DOM -->
				<div class="chart-wrapper" id="chart-wrapper">
					<!-- Edit mode -->
					<div class="chart-edit-mode" id="chart-edit"
						style=${this._mode === 'edit' ? '' : 'display:none'}>
						<div class="chart-builder">
							<div class="chart-controls">
								<div class="chart-controls-scroll">
									<div class="chart-controls-scroll-content">
										<!-- Chart type row -->
										<div class="chart-row">
											<label>Type</label>
											<div class="chart-type-picker">
												${CHART_TYPES_ORDERED.map(t => html`
													<button type="button"
														class="chart-type-btn ${this._chartType === t ? 'is-active' : ''}"
														@click=${() => this._selectChartType(t)}
														title="${CHART_TYPE_LABELS[t]} Chart"
														aria-label="${CHART_TYPE_LABELS[t]} Chart"
														aria-pressed=${this._chartType === t ? 'true' : 'false'}>
														<span .innerHTML=${CHART_TYPE_ICONS[t]}></span>
														<span>${CHART_TYPE_LABELS[t]}</span>
													</button>
												`)}
											</div>
										</div>

										<!-- Data source row -->
										<div class="chart-row">
											<label>Data</label>
											<select class="chart-select" @change=${(e: Event) => this.dataSourceCtrl.onDataSourceChanged(e)}
												@focus=${() => this.dataSourceCtrl.refreshDatasets()}>
												<option value="">(select)</option>
												${this._datasets.map(ds => html`
													<option value=${ds.id} ?selected=${this._dataSourceId === ds.id}>${ds.label}</option>
												`)}
											</select>
										</div>

										<!-- XY mapping (line/area/bar/scatter) -->
										${isXY ? this._renderXYMapping(colNames, supportsLegend, multiYSelected) : nothing}

										<!-- Pie/Funnel mapping -->
										${isPieOrFunnel ? this._renderPieMapping(colNames, isFunnel) : nothing}
									</div>
								</div>
							</div>
						</div>
					</div>

					<!-- Light-DOM wrapper/canvases/resizer via slot -->
					<slot name="chart-content"></slot>
				</div>
				<slot name="chart-resizer"></slot>
				</kw-section-shell>
			</div>
		`;
	}

	// ── Sub-templates ──────────────────────────────────────────────────────────

	/** Render a checkbox-style dropdown button (Y columns, Tooltip columns). */
	private _renderCheckboxDropdown(
		dropdownId: string,
		options: string[],
		selected: string[],
		emptyLabel: string,
	): TemplateResult {
		const isOpen = this._openDropdownId === dropdownId;
		const btnText = selected.length ? selected.join(', ') : emptyLabel;

		return html`
			<div class="dropdown-wrapper">
				<button type="button" class="dropdown-btn"
					@click=${(e: Event) => { e.stopPropagation(); this._toggleDropdown(dropdownId, e.currentTarget as HTMLElement); }}
					aria-haspopup="listbox" aria-expanded=${isOpen ? 'true' : 'false'}>
					${btnText}
				</button>
				${isOpen ? html`
					<div class="dropdown-menu" role="listbox" @mousedown=${(e: Event) => e.stopPropagation()}>
						${options.map(c => html`
							<label class="dropdown-item" @click=${(e: Event) => e.stopPropagation()} @mousedown=${(e: Event) => e.stopPropagation()}>
								<input type="checkbox" .checked=${selected.includes(c)}
									@change=${(e: Event) => this._onCheckboxDropdownChange(dropdownId, c, (e.target as HTMLInputElement).checked)} />
								<span>${c}</span>
							</label>
						`)}
						${!options.length ? html`<div class="dropdown-item" style="opacity:0.5">No columns available</div>` : nothing}
					</div>
				` : nothing}
			</div>
		`;
	}

	private _renderXYMapping(colNames: string[], supportsLegend: boolean, multiYSelected: boolean): TemplateResult {
		const xOptions = ['', ...colNames];

		return html`
			<div class="chart-mapping">
				<div class="chart-mapping-grid">
					<!-- X column -->
					<span class="chart-field-group">
						<label class="axis-label-clickable ${this._hasCustomXSettings() ? 'has-settings' : ''}" data-axis="x"
							@click=${(e: Event) => this._toggleAxisPopup('x', e)}
							title="Click to configure X-axis settings">X</label>
						<select class="chart-select" @change=${this._onXColumnChanged}>
							${xOptions.map(c => html`
								<option value=${c} ?selected=${this._xColumn === c}>${c || '(none)'}</option>
							`)}
						</select>
					</span>

					<!-- Y columns -->
					<span class="chart-field-group">
						<label class="axis-label-clickable ${this._hasCustomYSettings() ? 'has-settings' : ''}" data-axis="y"
							@click=${(e: Event) => this._toggleAxisPopup('y', e)}
							title="Click to configure Y-axis settings">Y</label>
						${this._renderCheckboxDropdown('y', colNames.filter(c => c !== this._xColumn), this._yColumns, 'Select...')}
					</span>

					<!-- Legend (line/area/bar only) -->
					${supportsLegend ? html`
						<span class="chart-field-group">
							<label>Legend</label>
							<div class="chart-legend-inline">
								<select class="chart-select" @change=${this._onLegendColumnChanged}
									?disabled=${multiYSelected}>
									<option value="" ?selected=${!this._legendColumn}>(none)</option>
									${colNames.filter(c => c !== this._xColumn).map(c => html`
										<option value=${c} ?selected=${this._legendColumn === c}>${c}</option>
									`)}
								</select>
								${this._legendColumn || multiYSelected ? html`
									<button type="button" class="unified-btn-secondary unified-btn-icon-only chart-legend-pos-btn"
										@click=${this._cycleStackMode}
										title="Stack mode: ${STACK_MODE_LABELS[this._stackMode]}">
										<span .innerHTML=${STACK_MODE_ICONS[this._stackMode]}></span>
									</button>
								` : nothing}
								${this._legendColumn && !multiYSelected ? html`
									<button type="button" class="unified-btn-secondary unified-btn-icon-only chart-legend-pos-btn"
										@click=${this._cycleLegendPosition}
										title="Legend position: ${this._legendPosition.charAt(0).toUpperCase() + this._legendPosition.slice(1)}">
										<span .innerHTML=${LEGEND_POSITION_ICONS[this._legendPosition]}></span>
									</button>
								` : nothing}
							</div>
						</span>
					` : nothing}

					<!-- Tooltip -->
					<span class="chart-field-group">
						<label>Tooltip</label>
						${this._renderCheckboxDropdown('tooltip', colNames, this._tooltipColumns, '(none)')}
					</span>

					<!-- Labels toggle -->
					<div class="chart-labels-toggle ${this._showDataLabels ? 'is-active' : ''}"
						@click=${this._toggleDataLabels}
						role="switch" aria-checked=${this._showDataLabels ? 'true' : 'false'}
						tabindex="0" title="Toggle data labels">
						<span class="chart-labels-toggle-text">Labels</span>
						<span class="chart-labels-toggle-track">
							<span class="chart-labels-toggle-thumb"></span>
						</span>
					</div>

					<span class="chart-grid-spacer" aria-hidden="true"></span>
				</div>
			</div>

			${this._renderXAxisPopup()}
			${this._renderYAxisPopup()}
		`;
	}

	private _renderPieMapping(colNames: string[], isFunnel: boolean): TemplateResult {
		return html`
			<div class="chart-mapping">
				<div class="chart-mapping-grid">
					<!-- Label column -->
					<span class="chart-field-group">
						<label>Label</label>
						<select class="chart-select" @change=${this._onLabelColumnChanged}>
							${colNames.map(c => html`
								<option value=${c} ?selected=${this._labelColumn === c}>${c}</option>
							`)}
						</select>
					</span>

					<!-- Value column -->
					<span class="chart-field-group">
						<label>Value</label>
						<select class="chart-select" @change=${this._onValueColumnChanged}>
							${colNames.map(c => html`
								<option value=${c} ?selected=${this._valueColumn === c}>${c}</option>
							`)}
						</select>
					</span>

					<!-- Tooltip -->
					<span class="chart-field-group">
						<label>Tooltip</label>
						${this._renderCheckboxDropdown('tooltip-pie', colNames, this._tooltipColumns, '(none)')}
					</span>

					<!-- Funnel sort -->
					${isFunnel ? html`
						<span class="chart-field-group">
							<label>Sort</label>
							<select class="chart-select" @change=${this._onSortColumnChanged}>
								<option value="" ?selected=${!this._sortColumn}>(none)</option>
								${colNames.map(c => html`
									<option value=${c} ?selected=${this._sortColumn === c}>${c}</option>
								`)}
							</select>
						</span>
					` : nothing}

					<!-- Labels toggle (pie/funnel) -->
					<div class="chart-labels-toggle ${this._showDataLabels ? 'is-active' : ''}"
						@click=${this._toggleDataLabels}
						role="switch" aria-checked=${this._showDataLabels ? 'true' : 'false'}
						tabindex="0" title="Toggle data labels">
						<span class="chart-labels-toggle-text axis-label-clickable ${this._hasCustomLabelSettings() ? 'has-settings' : ''}"
							@click=${(e: Event) => { e.stopPropagation(); this._toggleAxisPopup('labels', e); }}
							title="Click to configure label settings">Labels</span>
						<span class="chart-labels-toggle-track">
							<span class="chart-labels-toggle-thumb"></span>
						</span>
					</div>

					<span class="chart-grid-spacer" aria-hidden="true"></span>
				</div>
			</div>

			${this._renderLabelSettingsPopup()}
		`;
	}

	// ── Axis settings popup templates ─────────────────────────────────────────

	private _renderXAxisPopup(): TemplateResult {
		const s = this._xAxisSettings;
		const densityLabel = s.labelDensity >= 100 ? 'All' : s.labelDensity + '%';
		return html`
			<kw-popover
				.open=${this._openAxisPopup === 'x'}
				.anchorRect=${this._popoverAnchorRect}
				.title=${'X-Axis Settings'}
				@popover-close=${() => this._closeAxisPopup()}
			>
				<div class="axis-popup-checkbox">
						<input type="checkbox" .checked=${s.showAxisLabel !== false}
							@change=${(e: Event) => this._onAxisSetting('x', 'showAxisLabel', (e.target as HTMLInputElement).checked)}>
						<label>Show axis title</label>
					</div>
					${s.showAxisLabel !== false ? html`
						<div class="axis-popup-row">
							<input type="text" .value=${s.customLabel || ''} placeholder="Column name"
								@input=${(e: Event) => this._onAxisSetting('x', 'customLabel', (e.target as HTMLInputElement).value)}>
						</div>
						<div class="axis-popup-slider-row">
							<div class="axis-popup-slider-header"><label>Title Gap</label><span>${s.titleGap}</span></div>
							<input type="range" class="axis-popup-slider" min="10" max="200" .value=${String(s.titleGap)}
								@input=${(e: Event) => this._onAxisSetting('x', 'titleGap', parseInt((e.target as HTMLInputElement).value, 10))}>
						</div>
					` : nothing}
					<div class="axis-popup-row">
						<label>Sort Direction</label>
						<select @change=${(e: Event) => this._onAxisSetting('x', 'sortDirection', (e.target as HTMLSelectElement).value)}>
							<option value="" ?selected=${!s.sortDirection}>Auto (default)</option>
							<option value="asc" ?selected=${s.sortDirection === 'asc'}>Ascending</option>
							<option value="desc" ?selected=${s.sortDirection === 'desc'}>Descending</option>
						</select>
					</div>
					<div class="axis-popup-row">
						<label>Scale Type</label>
						<select @change=${(e: Event) => this._onAxisSetting('x', 'scaleType', (e.target as HTMLSelectElement).value)}>
							<option value="" ?selected=${!s.scaleType}>Auto (default)</option>
							<option value="category" ?selected=${s.scaleType === 'category'}>Categorical</option>
							<option value="continuous" ?selected=${s.scaleType === 'continuous'}>Continuous</option>
						</select>
					</div>
					<div class="axis-popup-slider-row">
						<div class="axis-popup-slider-header"><label>Label Density</label><span>${densityLabel}</span></div>
						<input type="range" class="axis-popup-slider" min="1" max="100" .value=${String(Math.max(1, s.labelDensity))}
							@input=${(e: Event) => this._onAxisSetting('x', 'labelDensity', parseInt((e.target as HTMLInputElement).value, 10))}>
				</div>
				<div slot="footer">
					<button class="axis-popup-reset" @click=${() => this._resetAxisSettings('x')}>Reset to defaults</button>
				</div>
			</kw-popover>
		`;
	}

	private _renderYAxisPopup(): TemplateResult {
		const s = this._yAxisSettings;
		const defColors = ['#5470c6','#91cc75','#fac858','#ee6666','#73c0de','#3ba272','#fc8452','#9a60b4','#ea7ccc','#48b8d0'];
		return html`
			<kw-popover
				.open=${this._openAxisPopup === 'y'}
				.anchorRect=${this._popoverAnchorRect}
				.title=${'Y-Axis Settings'}
				@popover-close=${() => this._closeAxisPopup()}
			>
				<div class="axis-popup-checkbox">
						<input type="checkbox" .checked=${s.showAxisLabel !== false}
							@change=${(e: Event) => this._onAxisSetting('y', 'showAxisLabel', (e.target as HTMLInputElement).checked)}>
						<label>Show axis title</label>
					</div>
					${s.showAxisLabel !== false ? html`
						<div class="axis-popup-row">
							<input type="text" .value=${s.customLabel || ''} placeholder="Column name"
								@input=${(e: Event) => this._onAxisSetting('y', 'customLabel', (e.target as HTMLInputElement).value)}>
						</div>
						<div class="axis-popup-slider-row">
							<div class="axis-popup-slider-header"><label>Title Gap</label><span>${s.titleGap}</span></div>
							<input type="range" class="axis-popup-slider" min="10" max="200" .value=${String(s.titleGap)}
								@input=${(e: Event) => this._onAxisSetting('y', 'titleGap', parseInt((e.target as HTMLInputElement).value, 10))}>
						</div>
					` : nothing}
					<div class="axis-popup-minmax">
						<div class="axis-popup-minmax-field">
							<label>Min</label>
							<input type="text" inputmode="decimal" .value=${s.min || ''} placeholder="Auto"
								@change=${(e: Event) => this._onAxisSetting('y', 'min', (e.target as HTMLInputElement).value)}>
						</div>
						<div class="axis-popup-minmax-field">
							<label>Max</label>
							<input type="text" inputmode="decimal" .value=${s.max || ''} placeholder="Auto"
								@change=${(e: Event) => this._onAxisSetting('y', 'max', (e.target as HTMLInputElement).value)}>
						</div>
					</div>
					${this._yColumns.length > 0 ? html`
						<div>
							<div class="axis-popup-colors-header">Series Colors</div>
							${this._yColumns.map((col, i) => {
								const custom = s.seriesColors?.[col] || '';
								const def = defColors[i % defColors.length];
								return html`
									<div class="axis-popup-color-row">
										<input type="color" .value=${custom || def}
											@change=${(e: Event) => this._onSeriesColorChanged(col, (e.target as HTMLInputElement).value, def)}>
										<span class="axis-popup-color-label" title=${col}>${col}</span>
									</div>
								`;
							})}
						</div>
					` : nothing}
				<div slot="footer">
					<button class="axis-popup-reset" @click=${() => this._resetAxisSettings('y')}>Reset to defaults</button>
				</div>
			</kw-popover>
		`;
	}

	private _renderLabelSettingsPopup(): TemplateResult {
		return html`
			<kw-popover
				.open=${this._openAxisPopup === 'labels'}
				.anchorRect=${this._popoverAnchorRect}
				.title=${'Label Settings'}
				@popover-close=${() => this._closeAxisPopup()}
			>
				<div class="axis-popup-row">
						<label>Display Mode</label>
						<select @change=${(e: Event) => { this._labelMode = (e.target as HTMLSelectElement).value as LabelMode; this._schedulePersist(); }}>
							<option value="auto" ?selected=${this._labelMode === 'auto'}>Auto (smart)</option>
							<option value="all" ?selected=${this._labelMode === 'all'}>All slices</option>
							<option value="top5" ?selected=${this._labelMode === 'top5'}>Top 5 only</option>
							<option value="top10" ?selected=${this._labelMode === 'top10'}>Top 10 only</option>
							<option value="topPercent" ?selected=${this._labelMode === 'topPercent'}>\u22655% only</option>
						</select>
					</div>
					${this._labelMode === 'auto' ? html`
						<div class="axis-popup-slider-row">
							<div class="axis-popup-slider-header"><label>Density</label><span>${this._labelDensity}%</span></div>
							<input type="range" class="axis-popup-slider" min="0" max="100" .value=${String(this._labelDensity)}
								@input=${(e: Event) => { this._labelDensity = parseInt((e.target as HTMLInputElement).value, 10); this._schedulePersist(); }}>
						</div>
					` : nothing}
			</kw-popover>
		`;
	}

	// ── Event handlers ─────────────────────────────────────────────────────────

	private _onShellNameChange(e: CustomEvent<{ name: string }>): void {
		this._name = e.detail.name;
		this._schedulePersist();
	}

	private _captureScrollPosition(): void {
		this._scrollAtPopupOpen = document.documentElement.scrollTop || document.body.scrollTop || 0;
	}

	private _toggleDropdown(id: string, btnEl?: HTMLElement): void {
		if (this._openDropdownId === id) {
			this._openDropdownId = '';
			document.removeEventListener('mousedown', this._closeDropdownBound);
		} else {
			this._openDropdownId = id;
			this._captureScrollPosition();
			// After Lit re-renders the menu, position it using the button's bounding rect
			if (btnEl) {
				this.updateComplete.then(() => {
					const menu = this.shadowRoot?.querySelector('.dropdown-menu') as HTMLElement | null;
					if (menu) {
						const rect = btnEl.getBoundingClientRect();
						menu.style.top = rect.bottom + 'px';
						menu.style.left = rect.left + 'px';
						menu.style.width = rect.width + 'px';
					}
				});
			}
			// Defer so the current click doesn't immediately close it
			setTimeout(() => document.addEventListener('mousedown', this._closeDropdownBound), 0);
		}
	}

	private _closeDropdownOnClickOutside(): void {
		this._openDropdownId = '';
		document.removeEventListener('mousedown', this._closeDropdownBound);
	}

	/** Close all fixed-position dropdowns when scroll exceeds threshold. */
	private _closeAllPopupsOnScroll(): void {
		if (!this._openDropdownId && !this._modeDropdownOpen) return;
		const scrollY = document.documentElement.scrollTop || document.body.scrollTop || 0;
		if (Math.abs(scrollY - this._scrollAtPopupOpen) <= 20) return;
		if (this._openDropdownId) {
			this._openDropdownId = '';
			document.removeEventListener('mousedown', this._closeDropdownBound);
		}
		if (this._modeDropdownOpen) {
			this._modeDropdownOpen = false;
		}
	}

	private _onCheckboxDropdownChange(dropdownId: string, value: string, checked: boolean): void {
		if (dropdownId === 'y') {
			const next = checked
				? [...this._yColumns, value]
				: this._yColumns.filter(c => c !== value);
			this._yColumns = next;
			if (next.length > 1) this._legendColumn = '';
			this._schedulePersist();
		} else if (dropdownId === 'tooltip' || dropdownId === 'tooltip-pie') {
			const next = checked
				? [...this._tooltipColumns, value]
				: this._tooltipColumns.filter(c => c !== value);
			this._tooltipColumns = next;
			this._schedulePersist();
		}
	}

	private _hasCanvasContent(): boolean {
		return !!this._dataSourceId && !!this._chartType;
	}

	private _getCanvasPlaceholderText(): string {
		if (!this._dataSourceId) return 'Select a data source (a query, CSV URL, or transformation section with results).';
		if (!this._chartType) return 'Select a chart type.';
		return '';
	}

	private _setMode(mode: ChartMode): void {
		this._mode = mode;
		this._modeDropdownOpen = false;
		// Toggle the light-DOM edit/preview containers
		this._applyModeToDom();
		this._writeToGlobalChartState();
		this._renderChart();
		this._schedulePersist();
	}

	private _toggleVisibility(): void {
		this._expanded = !this._expanded;
		this._updateHostClasses();
		// Show/hide the light-DOM wrapper
		const wrapper = document.getElementById(this.boxId + '_chart_wrapper');
		if (wrapper) wrapper.style.display = this._expanded ? '' : 'none';
		if (this._expanded) {
			this._applyModeToDom();
			this._renderChart();
		}
		this._writeToGlobalChartState();
		this._schedulePersist();
	}

	/** Toggle light-DOM edit/preview containers based on current mode. */
	private _applyModeToDom(): void {
		const editHost = document.getElementById(this.boxId + '_chart_edit');
		const prevHost = document.getElementById(this.boxId + '_chart_preview');
		if (editHost) editHost.style.display = this._mode === 'edit' ? '' : 'none';
		if (prevHost) prevHost.style.display = this._mode === 'preview' ? 'flex' : 'none';
	}

	private _onFitToContents(): void {
		try {
			maximizeChartBox(this.boxId);
		} catch (e) { console.error('[kusto]', e); }
	}



	private _selectChartType(t: ChartType): void {
		this._chartType = t;
		this._schedulePersist();
	}

	private _onXColumnChanged(e: Event): void {
		this._xColumn = (e.target as HTMLSelectElement).value;
		this._schedulePersist();
	}

	private _onLegendColumnChanged(e: Event): void {
		this._legendColumn = (e.target as HTMLSelectElement).value;
		this._schedulePersist();
	}

	private _cycleLegendPosition(): void {
		const idx = LEGEND_CYCLE.indexOf(this._legendPosition);
		this._legendPosition = LEGEND_CYCLE[(idx + 1) % LEGEND_CYCLE.length];
		this._schedulePersist();
	}

	private _cycleStackMode(): void {
		const idx = STACK_MODE_CYCLE.indexOf(this._stackMode);
		this._stackMode = STACK_MODE_CYCLE[(idx + 1) % STACK_MODE_CYCLE.length];
		this._schedulePersist();
	}

	private _toggleDataLabels(): void {
		this._showDataLabels = !this._showDataLabels;
		this._schedulePersist();
	}

	private _onLabelColumnChanged(e: Event): void {
		this._labelColumn = (e.target as HTMLSelectElement).value;
		this._schedulePersist();
	}

	private _onValueColumnChanged(e: Event): void {
		this._valueColumn = (e.target as HTMLSelectElement).value;
		this._schedulePersist();
	}

	private _onSortColumnChanged(e: Event): void {
		this._sortColumn = (e.target as HTMLSelectElement).value;
		if (!this._sortColumn) {
			this._sortDirection = '';
		} else if (!this._sortDirection) {
			this._sortDirection = 'desc';
		}
		this._schedulePersist();
	}

	// ── Axis settings handlers ────────────────────────────────────────────────

	private _toggleAxisPopup(axis: 'x' | 'y' | 'labels', e: Event): void {
		if (this._openAxisPopup === axis) {
			this._openAxisPopup = '';
			return;
		}
		this._setAxisPopupAnchorFromElement(e.target as HTMLElement);
		this._openAxisPopup = axis;
	}

	private _setAxisPopupAnchorFromElement(el: HTMLElement): void {
		const rect = el.getBoundingClientRect();

		// Measure actual text width to center the arrow on the text, not the padded element.
		const labelText = el.textContent || '';
		const computedStyle = window.getComputedStyle(el);
		const canvas = document.createElement('canvas');
		const ctx = canvas.getContext('2d');
		let textWidth = rect.width;
		if (ctx) {
			ctx.font = computedStyle.fontSize + ' ' + computedStyle.fontFamily;
			textWidth = ctx.measureText(labelText).width;
		}

		const textCenter = rect.left + (textWidth / 2);
		this._popoverAnchorRect = {
			top: rect.top,
			left: rect.left,
			bottom: rect.bottom,
			width: rect.width,
			textCenter,
		};
	}

	private _getAxisSettingsAnchorLabel(axis: 'x' | 'y'): HTMLElement | null {
		const root = this.shadowRoot;
		if (!root) return null;
		return root.querySelector(`.axis-label-clickable[data-axis="${axis}"]`) as HTMLElement | null;
	}

	private _onChartAxisTitleClick(e: Event): void {
		const detail = (e as CustomEvent<{ axis?: string; clientX?: number; clientY?: number }>).detail;
		const axis = detail?.axis;
		if (axis !== 'x' && axis !== 'y') return;

		const anchorLabel = this._getAxisSettingsAnchorLabel(axis);
		if (anchorLabel) {
			this._setAxisPopupAnchorFromElement(anchorLabel);
			this._openAxisPopup = axis;
			return;
		}

		const clientX = typeof detail.clientX === 'number' ? detail.clientX : 0;
		const clientY = typeof detail.clientY === 'number' ? detail.clientY : 0;
		this._popoverAnchorRect = {
			top: clientY,
			left: clientX,
			bottom: clientY + 1,
			width: 1,
			textCenter: clientX,
		};
		this._openAxisPopup = axis;
	}

	/** Close the axis popup. */
	private _closeAxisPopup(): void {
		this._openAxisPopup = '';
	}

	private _onAxisSetting(axis: 'x' | 'y', key: string, value: unknown): void {
		if (axis === 'x') {
			this._xAxisSettings = { ...this._xAxisSettings, [key]: value };
		} else {
			this._yAxisSettings = { ...this._yAxisSettings, [key]: value };
		}
		this._schedulePersist();
	}

	private _onSeriesColorChanged(col: string, newColor: string, defaultColor: string): void {
		const colors = { ...(this._yAxisSettings.seriesColors || {}) };
		if (newColor.toLowerCase() === defaultColor.toLowerCase()) {
			delete colors[col];
		} else {
			colors[col] = newColor;
		}
		this._yAxisSettings = { ...this._yAxisSettings, seriesColors: colors };
		this._schedulePersist();
	}

	private _resetAxisSettings(axis: 'x' | 'y'): void {
		if (axis === 'x') {
			this._xAxisSettings = defaultXAxisSettings();
		} else {
			this._yAxisSettings = defaultYAxisSettings();
		}
		this._schedulePersist();
	}

	private _hasCustomXSettings(): boolean {
		return hasCustomXAxisSettings(this._xAxisSettings);
	}

	private _hasCustomYSettings(): boolean {
		return hasCustomYAxisSettings(this._yAxisSettings);
	}

	private _hasCustomLabelSettings(): boolean {
		return hasCustomLabelSettings({ labelMode: this._labelMode, labelDensity: this._labelDensity });
	}

	// ── Theme observer ────────────────────────────────────────────────────────

	private _setupThemeObserver(): void {
		this._lastThemeDark = this._isDarkTheme();
		this._themeObserver = new MutationObserver(() => {
			const isDark = this._isDarkTheme();
			if (this._lastThemeDark !== isDark) {
				this._lastThemeDark = isDark;
				try { disposeChartEcharts(this.boxId); } catch (e) { console.error('[kusto]', e); }
				this._renderChart();
			}
		});
		if (document.body) {
			this._themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });
		}
		if (document.documentElement) {
			this._themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] });
		}
	}

	private _isDarkTheme(): boolean {
		const cls = document.body?.classList;
		if (cls?.contains('vscode-dark') || cls?.contains('vscode-high-contrast')) return true;
		if (cls?.contains('vscode-light') || cls?.contains('vscode-high-contrast-light')) return false;
		return true;
	}

	// ── Tool configuration (public API) ───────────────────────────────────────

	/** Configure chart programmatically (used by LLM tools). */
	public configure(config: Record<string, unknown>): boolean {
		try {
			if (typeof config.dataSourceId === 'string') this._dataSourceId = config.dataSourceId;
			if (typeof config.chartType === 'string') this._chartType = config.chartType as ChartType;
			if (typeof config.xColumn === 'string') this._xColumn = config.xColumn;
			if (Array.isArray(config.yColumns)) this._yColumns = (config.yColumns as string[]).filter(c => c);
			else if (typeof config.yColumn === 'string') this._yColumns = [config.yColumn as string];
			if (typeof config.labelColumn === 'string') this._labelColumn = config.labelColumn;
			if (typeof config.valueColumn === 'string') this._valueColumn = config.valueColumn;
			if (typeof config.legendColumn === 'string') this._legendColumn = config.legendColumn;
			if (Array.isArray(config.tooltipColumns)) this._tooltipColumns = (config.tooltipColumns as string[]).filter(c => c);
			if (typeof config.showDataLabels === 'boolean') this._showDataLabels = config.showDataLabels;
			if (typeof config.legendPosition === 'string') this._legendPosition = normalizeLegendPosition(config.legendPosition);
			if (typeof config.sortColumn === 'string') this._sortColumn = config.sortColumn;
			if (typeof config.sortDirection === 'string') this._sortDirection = config.sortDirection as SortDirection;
			this._refreshDatasets();
			this._schedulePersist();
			return true;
		} catch { return false; }
	}

	// ── Global state bridge ────────────────────────────────────────────────────

	/**
	 * Read state from the global chartStateByBoxId into Lit properties.
	 * Public so column rename propagation can push updated names into this component.
	 */
	public syncFromGlobalState(): void {
		this._syncGlobalChartState();
	}

	/**
	 * Read initial state from the global chartStateByBoxId, if present.
	 * This is how persisted state flows into the Lit component from addChartBox.
	 */
	private _syncGlobalChartState(): void {
		const win = window;
		if (!this.boxId) return;
		const global = win.chartStateByBoxId;
		if (!global || typeof global !== 'object') return;
		const st = global[this.boxId];
		if (!st || typeof st !== 'object') return;

		if (typeof st.mode === 'string') this._mode = st.mode as ChartMode;
		if (typeof st.expanded === 'boolean') this._expanded = st.expanded;
		if (typeof st.chartType === 'string') this._chartType = st.chartType as ChartType;
		if (typeof st.dataSourceId === 'string') this._dataSourceId = st.dataSourceId;
		if (typeof st.xColumn === 'string') this._xColumn = st.xColumn;
		if (Array.isArray(st.yColumns)) this._yColumns = st.yColumns.filter((c: unknown) => c);
		else if (typeof st.yColumn === 'string' && st.yColumn) this._yColumns = [st.yColumn];
		if (typeof st.legendColumn === 'string') this._legendColumn = st.legendColumn;
		if (typeof st.legendPosition === 'string') this._legendPosition = normalizeLegendPosition(st.legendPosition);
		if (typeof st.stackMode === 'string') this._stackMode = normalizeStackMode(st.stackMode);
		if (typeof st.labelColumn === 'string') this._labelColumn = st.labelColumn;
		if (typeof st.valueColumn === 'string') this._valueColumn = st.valueColumn;
		if (typeof st.showDataLabels === 'boolean') this._showDataLabels = st.showDataLabels;
		if (typeof st.labelMode === 'string') this._labelMode = st.labelMode as LabelMode;
		if (typeof st.labelDensity === 'number') this._labelDensity = st.labelDensity;
		if (Array.isArray(st.tooltipColumns)) this._tooltipColumns = st.tooltipColumns.filter((c: unknown) => c);
		if (typeof st.sortColumn === 'string') this._sortColumn = st.sortColumn;
		if (typeof st.sortDirection === 'string') this._sortDirection = st.sortDirection as SortDirection;
		if (st.xAxisSettings && typeof st.xAxisSettings === 'object') {
			this._xAxisSettings = { ...defaultXAxisSettings(), ...st.xAxisSettings };
		}
		if (st.yAxisSettings && typeof st.yAxisSettings === 'object') {
			this._yAxisSettings = { ...defaultYAxisSettings(), ...st.yAxisSettings };
		}
	}

	/**
	 * Write current Lit state back to the global chartStateByBoxId so that
	 * the existing __kustoRenderChart and persistence.js can read from it.
	 */
	private _writeToGlobalChartState(): void {
		const win = window;
		if (!this.boxId) return;
		if (!win.chartStateByBoxId) win.chartStateByBoxId = {};
		const st = win.chartStateByBoxId[this.boxId] || {};

		st.mode = this._mode;
		st.expanded = this._expanded;
		st.chartType = this._chartType;
		st.dataSourceId = this._dataSourceId;
		st.xColumn = this._xColumn;
		st.yColumn = this._yColumns.length ? this._yColumns[0] : '';
		st.yColumns = [...this._yColumns];
		st.legendColumn = this._legendColumn;
		st.legendPosition = this._legendPosition;
		st.stackMode = this._stackMode;
		st.labelColumn = this._labelColumn;
		st.valueColumn = this._valueColumn;
		st.showDataLabels = this._showDataLabels;
		st.labelMode = this._labelMode;
		st.labelDensity = this._labelDensity;
		st.tooltipColumns = [...this._tooltipColumns];
		st.sortColumn = this._sortColumn;
		st.sortDirection = this._sortDirection;
		st.xAxisSettings = { ...this._xAxisSettings };
		st.yAxisSettings = { ...this._yAxisSettings };

		win.chartStateByBoxId[this.boxId] = st;
	}

	// ── Data helpers ───────────────────────────────────────────────────────────

	/**
	 * Public refresh — called by __kustoRefreshAllDataSourceDropdowns and
	 * __kustoRefreshDependentExtraBoxes to update datasets and re-render.
	 */
	public refresh(): void {
		this.dataSourceCtrl.refreshDatasets();
		this._renderChart();
	}

	/**
	 * Refresh the list of available data sources from the DOM.
	 * Public so __kustoUpdateChartBuilderUI can call it for Lit elements.
	 */
	public refreshDatasets(): void {
		this.dataSourceCtrl.refreshDatasets();
	}

	/** Get column names from the currently selected dataset. */
	private _getColumnNames(): string[] {
		return this.dataSourceCtrl.getColumnNames();
	}

	/** Shorthand used internally. */
	private _refreshDatasets(): void {
		this.dataSourceCtrl.refreshDatasets();
	}

	// ── Chart rendering (delegates to existing global) ────────────────────────

	/**
	 * Delegate chart rendering to the existing __kustoRenderChart function.
	 * The chart canvas lives in light DOM via <slot>, so the legacy code can
	 * directly access and render into it.
	 */
	private _renderChart(): void {
		if (!this._expanded) return;
		this._refreshDatasets();
		try {
			renderChart(this.boxId);
		} catch (e) { console.error('[kusto]', e); }
	}

	// ── Host class management ─────────────────────────────────────────────────

	private _updateHostClasses(): void {
		this.classList.toggle('is-collapsed', !this._expanded);
	}

	// ── Persistence ───────────────────────────────────────────────────────────

	/** Public for ChartSectionHost interface. */
	schedulePersist(): void {
		try {
			schedulePersist();
		} catch (e) { console.error('[kusto]', e); }
	}

	private _schedulePersist(): void {
		this.schedulePersist();
	}

	/**
	 * Serialize to the .kqlx JSON format.
	 * Output is identical to the original persistence.js chart section shape.
	 */
	public serialize(): ChartSectionData {
		const data: ChartSectionData = {
			id: this.boxId,
			type: 'chart',
			name: this._name,
			mode: this._mode,
			expanded: this._expanded,
		};

		if (this._dataSourceId) data.dataSourceId = this._dataSourceId;
		if (this._chartType) data.chartType = this._chartType;
		if (this._xColumn) data.xColumn = this._xColumn;
		// Include yColumn for backward compatibility
		if (this._yColumns.length) {
			data.yColumn = this._yColumns[0];
			data.yColumns = [...this._yColumns];
		}
		if (this._tooltipColumns.length) data.tooltipColumns = [...this._tooltipColumns];
		if (this._legendColumn) data.legendColumn = this._legendColumn;
		if (this._legendPosition !== 'top') data.legendPosition = this._legendPosition;
		if (this._stackMode !== 'normal') data.stackMode = this._stackMode;
		if (this._labelColumn) data.labelColumn = this._labelColumn;
		if (this._valueColumn) data.valueColumn = this._valueColumn;
		if (this._showDataLabels) data.showDataLabels = true;
		if (this._labelMode !== 'auto') data.labelMode = this._labelMode;
		if (this._labelDensity !== 50) data.labelDensity = this._labelDensity;
		if (this._sortColumn) data.sortColumn = this._sortColumn;
		if (this._sortDirection) data.sortDirection = this._sortDirection;

		// Axis settings — only include if they differ from defaults
		const xDef = defaultXAxisSettings();
		const xSet = this._xAxisSettings;
		if (xSet.sortDirection !== xDef.sortDirection || xSet.scaleType !== xDef.scaleType ||
			xSet.labelDensity !== xDef.labelDensity || xSet.showAxisLabel !== xDef.showAxisLabel ||
			xSet.customLabel !== xDef.customLabel || xSet.titleGap !== xDef.titleGap) {
			data.xAxisSettings = { ...xSet };
		}

		const yDef = defaultYAxisSettings();
		const ySet = this._yAxisSettings;
		if (ySet.showAxisLabel !== yDef.showAxisLabel || ySet.customLabel !== yDef.customLabel ||
			ySet.min !== yDef.min || ySet.max !== yDef.max || ySet.titleGap !== yDef.titleGap ||
			(ySet.seriesColors && Object.keys(ySet.seriesColors).length > 0)) {
			data.yAxisSettings = { ...ySet };
		}

		// Wrapper height
		const heightPx = this._getWrapperHeightPx();
		if (heightPx !== undefined) {
			data.editorHeightPx = heightPx;
		}

		// Validation status
		try {
			const vs = __kustoGetChartValidationStatus(this.boxId);
			if (vs) data.validation = vs;
		} catch (e) { console.error('[kusto]', e); }

		return data;
	}

	/** Set initial state from options passed by addChartBox. */
	public applyOptions(options: Record<string, unknown>): void {
		if (typeof options.name === 'string') this._name = options.name;
		if (typeof options.mode === 'string') this._mode = options.mode as ChartMode;
		if (typeof options.expanded === 'boolean') this._expanded = options.expanded;
		if (typeof options.chartType === 'string') this._chartType = options.chartType as ChartType;
		if (typeof options.dataSourceId === 'string') this._dataSourceId = options.dataSourceId;
		if (typeof options.xColumn === 'string') this._xColumn = options.xColumn;
		if (Array.isArray(options.yColumns)) this._yColumns = (options.yColumns as string[]).filter(c => c);
		else if (typeof options.yColumn === 'string' && options.yColumn) this._yColumns = [options.yColumn as string];
		if (typeof options.legendColumn === 'string') this._legendColumn = options.legendColumn;
		if (typeof options.legendPosition === 'string') this._legendPosition = normalizeLegendPosition(options.legendPosition);
		if (typeof options.stackMode === 'string') this._stackMode = normalizeStackMode(options.stackMode);
		if (typeof options.labelColumn === 'string') this._labelColumn = options.labelColumn;
		if (typeof options.valueColumn === 'string') this._valueColumn = options.valueColumn;
		if (typeof options.showDataLabels === 'boolean') this._showDataLabels = options.showDataLabels;
		if (typeof options.labelMode === 'string') this._labelMode = options.labelMode as LabelMode;
		if (typeof options.labelDensity === 'number') this._labelDensity = options.labelDensity;
		if (Array.isArray(options.tooltipColumns)) this._tooltipColumns = (options.tooltipColumns as string[]).filter(c => c);
		if (typeof options.sortColumn === 'string') this._sortColumn = options.sortColumn;
		if (typeof options.sortDirection === 'string') this._sortDirection = options.sortDirection as SortDirection;
		if (options.xAxisSettings && typeof options.xAxisSettings === 'object') {
			this._xAxisSettings = { ...defaultXAxisSettings(), ...this._xAxisSettings, ...(options.xAxisSettings as Partial<XAxisSettings>) };
		}
		if (options.yAxisSettings && typeof options.yAxisSettings === 'object') {
			this._yAxisSettings = { ...defaultYAxisSettings(), ...this._yAxisSettings, ...(options.yAxisSettings as Partial<YAxisSettings>) };
		}
	}

	// ── Private helpers ───────────────────────────────────────────────────────

	private _getWrapperHeightPx(): number | undefined {
		// Wrapper is in light DOM, accessible via document.getElementById
		const wrapper = document.getElementById(this.boxId + '_chart_wrapper');
		if (!wrapper) return undefined;
		if (!wrapper.dataset.kustoUserResized) return undefined;
		const h = wrapper.style.height?.trim();
		if (!h || h === 'auto') return undefined;
		const m = h.match(/^(\d+)px$/i);
		return m ? parseInt(m[1], 10) : undefined;
	}

	/** Set expanded state. */
	public setExpanded(expanded: boolean): void {
		this._expanded = expanded;
		this._updateHostClasses();
		const wrapper = document.getElementById(this.boxId + '_chart_wrapper');
		if (wrapper) wrapper.style.display = expanded ? '' : 'none';
		if (expanded) {
			this._applyModeToDom();
			this._renderChart();
		}
		this._writeToGlobalChartState();
		this._schedulePersist();
	}

	/** Get section name. */
	public getName(): string {
		return this._name;
	}
}

export function addChartBox(options: Record<string, unknown> = {}): string {
	return KwChartSection.addChartBox(options);
}

export function removeChartBox(boxId: unknown): void {
	const id = String(boxId || '');
	if (!id) return;
	try { disposeChartEcharts(id); } catch (e) { console.error('[kusto]', e); }
	try { delete window.chartStateByBoxId[id]; } catch (e) { console.error('[kusto]', e); }
	try { __kustoCleanupSectionModeResizeObserver(id); } catch (e) { console.error('[kusto]', e); }
	const idx = chartBoxes.indexOf(id);
	if (idx >= 0) chartBoxes.splice(idx, 1);
	const box = document.getElementById(id);
	if (box?.parentNode) box.parentNode.removeChild(box);
	try { schedulePersist(); } catch (e) { console.error('[kusto]', e); }
}

window.addChartBox = addChartBox;
window.removeChartBox = removeChartBox;
window.__kustoUpdateChartBuilderUI = __kustoUpdateChartBuilderUI;

// Declare the custom element type for TypeScript
declare global {
	interface HTMLElementTagNameMap {
		'kw-chart-section': KwChartSection;
	}
}
