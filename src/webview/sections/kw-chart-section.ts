import { LitElement, html, nothing, type PropertyValues, type TemplateResult } from 'lit';
import type { SectionElement } from '../shared/dom-helpers';
import { styles } from './kw-chart-section.styles.js';
import { sectionGlowStyles } from '../shared/section-glow.styles.js';
import { scrollbarSheet } from '../shared/scrollbar-styles.js';
import { osStyles } from '../shared/os-styles.js';
import { customElement, property, state } from 'lit/decorators.js';
import { pushDismissable, removeDismissable } from '../components/dismiss-stack.js';
import { schedulePersist } from '../core/persistence.js';
import { getScrollY, maybeAutoScrollWhileDragging } from '../core/utils.js';
import { ICONS, iconRegistryStyles } from '../shared/icon-registry.js';
import { cellToChartString } from '../shared/data-utils.js';
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
	getDefaultLegendSettings,
	getDefaultHeatmapSettings,
	hasCustomXAxisSettings,
	hasCustomYAxisSettings,
	hasCustomLabelSettings,
	hasCustomLegendSettings,
	hasCustomHeatmapSettings,
	normalizeLegendPosition,
	normalizeStackMode,
	type XAxisSettings,
	type YAxisSettings,
	type LegendPosition,
	type StackMode,
	type LegendSettings,
	type LegendSortMode,
	type HeatmapSettings,
	type HeatmapVisualMapPosition,
	type HeatmapCellLabelMode,
} from '../shared/chart-utils.js';
import '../components/kw-section-shell.js';
import '../components/kw-popover.js';
import type { PopoverAnchorRect } from '../components/kw-popover.js';
import { ChartDataSourceController, type DatasetEntry } from './chart-data-source.controller.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ChartType = 'line' | 'area' | 'bar' | 'scatter' | 'pie' | 'funnel' | 'sankey' | 'heatmap' | '';
export type ChartMode = 'edit' | 'preview';
export type { LegendPosition, StackMode, LegendSettings, LegendSortMode, XAxisSettings, YAxisSettings, HeatmapSettings, HeatmapVisualMapPosition, HeatmapCellLabelMode };
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
	sourceColumn?: string;
	targetColumn?: string;
	orient?: string;
	sankeyLeftMargin?: number;
	showDataLabels?: boolean;
	labelMode?: string;
	labelDensity?: number;
	sortColumn?: string;
	sortDirection?: string;
	xAxisSettings?: Partial<XAxisSettings>;
	yAxisSettings?: Partial<YAxisSettings>;
	legendSettings?: Partial<LegendSettings>;
	heatmapSettings?: Partial<HeatmapSettings>;
	chartTitle?: string;
	chartSubtitle?: string;
	chartTitleAlign?: 'left' | 'center' | 'right';
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
	sankey: '<svg viewBox="0 0 32 32" width="32" height="32" fill="currentColor" fill-opacity="0.7"><rect x="2" y="3" width="5" height="8" rx="1"/><rect x="2" y="13" width="5" height="6" rx="1"/><rect x="2" y="21" width="5" height="8" rx="1"/><rect x="25" y="5" width="5" height="10" rx="1"/><rect x="25" y="18" width="5" height="10" rx="1"/><path d="M7,7 C16,7 16,10 25,10" stroke="currentColor" stroke-width="2" fill="none" opacity="0.5"/><path d="M7,16 C16,16 16,12 25,12" stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.4"/><path d="M7,25 C16,25 16,23 25,23" stroke="currentColor" stroke-width="2" fill="none" opacity="0.5"/><path d="M7,9 C16,9 16,21 25,21" stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.4"/></svg>',
	heatmap: '<svg viewBox="0 0 32 32" width="32" height="32" fill="currentColor" fill-opacity="0.7"><rect x="2" y="2" width="8" height="8" rx="1" opacity="0.3"/><rect x="12" y="2" width="8" height="8" rx="1" opacity="0.7"/><rect x="22" y="2" width="8" height="8" rx="1" opacity="0.5"/><rect x="2" y="12" width="8" height="8" rx="1" opacity="0.9"/><rect x="12" y="12" width="8" height="8" rx="1" opacity="0.4"/><rect x="22" y="12" width="8" height="8" rx="1" opacity="0.8"/><rect x="2" y="22" width="8" height="8" rx="1" opacity="0.6"/><rect x="12" y="22" width="8" height="8" rx="1" opacity="1.0"/><rect x="22" y="22" width="8" height="8" rx="1" opacity="0.2"/></svg>',
};

const CHART_TYPE_LABELS: Record<string, string> = {
	line: 'Line', area: 'Area', bar: 'Bar', scatter: 'Scatter', pie: 'Pie', funnel: 'Funnel', sankey: 'Sankey', heatmap: 'Heatmap',
};

const CHART_TYPES_ORDERED: ChartType[] = ['area', 'bar', 'funnel', 'heatmap', 'line', 'pie', 'sankey', 'scatter'];

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
export class KwChartSection extends LitElement implements SectionElement {
	public static addChartBox(options: Record<string, unknown> = {}): string {
		const id = typeof options.id === 'string' && options.id
			? String(options.id)
			: ('chart_' + Date.now());
		chartBoxes.push(id);

		const st = getChartState(id);
		st.name = typeof options.name === 'string' ? String(options.name) : (st.name || '');
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
		st.showDataLabels = typeof options.showDataLabels === 'boolean' ? !!options.showDataLabels : (typeof st.showDataLabels === 'boolean' ? st.showDataLabels : true);
		st.labelMode = typeof options.labelMode === 'string' ? String(options.labelMode) : (st.labelMode || 'auto');
		st.labelDensity = typeof options.labelDensity === 'number' ? options.labelDensity : (typeof st.labelDensity === 'number' ? st.labelDensity : 50);
		st.tooltipColumns = Array.isArray(options.tooltipColumns)
			? options.tooltipColumns.filter((c: unknown) => c)
			: (Array.isArray(st.tooltipColumns) ? st.tooltipColumns : []);
		st.sortColumn = typeof options.sortColumn === 'string' ? String(options.sortColumn) : (st.sortColumn || '');
		st.sortDirection = typeof options.sortDirection === 'string' ? String(options.sortDirection) : (st.sortDirection || '');
		st.sourceColumn = typeof options.sourceColumn === 'string' ? String(options.sourceColumn) : (st.sourceColumn || '');
		st.targetColumn = typeof options.targetColumn === 'string' ? String(options.targetColumn) : (st.targetColumn || '');
		st.orient = typeof options.orient === 'string' ? String(options.orient) : (st.orient || 'LR');
		st.chartTitle = typeof options.chartTitle === 'string' ? String(options.chartTitle) : (st.chartTitle || '');
		st.chartSubtitle = typeof options.chartSubtitle === 'string' ? String(options.chartSubtitle) : (st.chartSubtitle || '');
		st.chartTitleAlign = typeof options.chartTitleAlign === 'string' ? String(options.chartTitleAlign) : (st.chartTitleAlign || 'center');
		if (options.xAxisSettings && typeof options.xAxisSettings === 'object') {
			st.xAxisSettings = { ...getDefaultXAxisSettings(), ...st.xAxisSettings, ...options.xAxisSettings };
		}
		if (options.yAxisSettings && typeof options.yAxisSettings === 'object') {
			st.yAxisSettings = { ...getDefaultYAxisSettings(), ...st.yAxisSettings, ...options.yAxisSettings };
		}
		if (options.legendSettings && typeof options.legendSettings === 'object') {
			st.legendSettings = { ...getDefaultLegendSettings(), ...st.legendSettings, ...options.legendSettings };
			// Back-sync top-level fields so the renderer reads consistent values
			if (typeof st.legendSettings.position === 'string') st.legendPosition = st.legendSettings.position;
			if (typeof st.legendSettings.stackMode === 'string') st.stackMode = st.legendSettings.stackMode;
		}
		if (options.heatmapSettings && typeof options.heatmapSettings === 'object') {
			st.heatmapSettings = { ...getDefaultHeatmapSettings(), ...st.heatmapSettings, ...options.heatmapSettings };
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
		resizerEl.className = 'resizer query-editor-resizer chart-bottom-resizer';
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

		const afterBoxId = typeof options.afterBoxId === 'string' ? String(options.afterBoxId) : '';
		const afterEl = afterBoxId ? document.getElementById(afterBoxId) : null;
		if (afterEl) {
			afterEl.insertAdjacentElement('afterend', litEl);
		} else {
			container.insertAdjacentElement('beforeend', litEl);
		}

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
				document.removeEventListener('mouseleave', onUp);
				window.removeEventListener('blur', onUp);
				resizerEl.classList.remove('is-dragging');
				document.body.style.cursor = prevCursor;
				document.body.style.userSelect = prevUserSelect;
				try { schedulePersist(); } catch (err) { console.error('[kusto]', err); }
				try { renderChart(id); } catch (err) { console.error('[kusto]', err); }
			};
			document.addEventListener('mousemove', onMove, true);
			document.addEventListener('mouseup', onUp, true);
			document.addEventListener('mouseleave', onUp);
			window.addEventListener('blur', onUp);
		});

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
	@state() private _showDataLabels = true;
	@state() private _labelMode: LabelMode = 'auto';
	@state() private _labelDensity = 50;
	@state() private _tooltipColumns: string[] = [];
	@state() private _sortColumn = '';
	@state() private _sortDirection: SortDirection = '';
	@state() private _sourceColumn = '';
	@state() private _targetColumn = '';
	@state() private _orient: 'LR' | 'RL' | 'TB' | 'BT' = 'LR';
	@state() private _sankeyLeftMargin = 100;
	@state() private _xAxisSettings: XAxisSettings = defaultXAxisSettings();
	@state() private _yAxisSettings: YAxisSettings = defaultYAxisSettings();
	@state() private _legendSettings: LegendSettings = getDefaultLegendSettings();
	@state() private _heatmapSettings: HeatmapSettings = getDefaultHeatmapSettings();
	@state() private _chartTitle = '';
	@state() private _chartSubtitle = '';
	@state() private _chartTitleAlign: 'left' | 'center' | 'right' = 'center';
	@state() private _titleSplitPercent = 50;

	/** True when the chart renderer last produced an actual chart (not a placeholder message). */
	@state() private _isChartRendering = false;

	// Datasets available for selection
	@state() private _datasets: DatasetEntry[] = [];

	// UI sub-state
	@state() private _modeDropdownOpen = false;
	@state() private _openDropdownId = '';
	@state() private _openAxisPopup: '' | 'x' | 'y' | 'labels' | 'legend' | 'heatmap-labels' | 'heatmap-slicer' | 'sankey-orient' = '';
	@state() private _popoverAnchorRect: PopoverAnchorRect | null = null;

	private _userResized = false;
	private _closeDropdownBound = this._closeDropdownOnClickOutside.bind(this);
	private _closeAllPopupsOnScrollBound = this._closeAllPopupsOnScroll.bind(this);
	private _onChartAxisTitleClickBound = this._onChartAxisTitleClick.bind(this) as EventListener;
	private _onSeriesColorChangeBound = this._onSeriesColorChangeFromTooltip.bind(this) as EventListener;
	private _scrollAtPopupOpen = 0;

	/** Sticky slider max overrides, keyed by 'axis:key' (e.g. 'x:titleGap'). */
	private _sliderMaxOverrides = new Map<string, number>();

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
	getSourceColumn(): string { return this._sourceColumn; }
	setSourceColumn(v: string): void { this._sourceColumn = v; }
	getTargetColumn(): string { return this._targetColumn; }
	setTargetColumn(v: string): void { this._targetColumn = v; }
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
		this.addEventListener('kusto-series-color-change', this._onSeriesColorChangeBound);
		// Close fixed-position popups/dropdowns when the page scrolls so they
		// don't float detached from their anchor buttons.
		window.addEventListener('scroll', this._closeAllPopupsOnScrollBound, { capture: true, passive: true });
		// Register public API for tool configuration
		(this as any).__kustoLitChart = true;
	}

	override disconnectedCallback(): void {
		super.disconnectedCallback();
		this.removeEventListener('kusto-axis-title-click', this._onChartAxisTitleClickBound);
		this.removeEventListener('kusto-series-color-change', this._onSeriesColorChangeBound);
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
			'_legendPosition', '_stackMode', '_legendSettings', '_labelColumn', '_valueColumn', '_showDataLabels',
			'_labelMode', '_labelDensity', '_tooltipColumns', '_sortColumn',
			'_sortDirection', '_xAxisSettings', '_yAxisSettings', '_heatmapSettings',
			'_sourceColumn', '_targetColumn', '_orient', '_sankeyLeftMargin',
		];
		if (chartTriggers.some(k => changed.has(k))) {
			this._writeToGlobalChartState();
			this._renderChart();
		}
	}

	// ── Styles ────────────────────────────────────────────────────────────────

	static override styles = [...osStyles, scrollbarSheet, iconRegistryStyles, styles, sectionGlowStyles];
	// ── Render ─────────────────────────────────────────────────────────────────

	override render(): TemplateResult {
		const isXY = this._chartType === 'line' || this._chartType === 'area' || this._chartType === 'bar' || this._chartType === 'scatter';
		const isPieOrFunnel = this._chartType === 'pie' || this._chartType === 'funnel';
		const isSankey = this._chartType === 'sankey';
		const isHeatmap = this._chartType === 'heatmap';
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
					section-type="chart"
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
							<div class="chart-controls ${this._isChartRendering ? '' : 'no-canvas'}">
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

										<!-- Chart title / subtitle -->
										${this._renderTitleRow()}

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

										<!-- Sankey mapping -->
										${isSankey ? this._renderSankeyMapping(colNames) : nothing}

										<!-- Heatmap mapping -->
										${isHeatmap ? this._renderHeatmapMapping(colNames) : nothing}
									</div>
								</div>
							</div>
						</div>
					</div>

					<!-- Light-DOM wrapper/canvases/resizer via slot -->
					<slot name="chart-content"></slot>
				</div>
				${this._isChartRendering ? html`<slot name="chart-resizer"></slot>` : nothing}
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
							<label class="axis-label-clickable ${this._hasCustomLegendSettings() ? 'has-settings' : ''}"
								@click=${(e: Event) => this._toggleAxisPopup('legend', e)}
								title="Click to configure legend settings">Legend</label>
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

					<!-- Labels density (0 = off, >0 = on) -->
					<span class="chart-field-group">
						<label>Labels</label>
						${this._renderSlider({
							min: 0, max: this._effectiveMax('labels:labelDensity', 100), value: this._labelDensity,
							label: this._labelDensity >= 100 ? 'All' : this._labelDensity > 0 ? `${this._labelDensity}%` : 'Off',
							onInput: (e: Event) => this._onLabelDensitySlider(e),
						})}
					</span>

					<span class="chart-grid-spacer" aria-hidden="true"></span>
				</div>
			</div>

			${this._renderXAxisPopup()}
			${this._renderYAxisPopup()}
			${this._renderLegendPopup()}
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

					<!-- Labels density (pie/funnel — 0 = off, >0 = on) -->
					<span class="chart-field-group">
						<label class="axis-label-clickable ${this._hasCustomLabelSettings() ? 'has-settings' : ''}"
							@click=${(e: Event) => this._toggleAxisPopup('labels', e)}
							title="Click to configure label settings">Labels</label>
						${this._renderSlider({
							min: 0, max: this._effectiveMax('labels:labelDensity', 100), value: this._labelDensity,
							label: this._labelDensity >= 100 ? 'All' : this._labelDensity > 0 ? `${this._labelDensity}%` : 'Off',
							onInput: (e: Event) => this._onLabelDensitySlider(e),
						})}
					</span>

					<span class="chart-grid-spacer" aria-hidden="true"></span>
				</div>
			</div>

			${this._renderLabelSettingsPopup()}
		`;
	}

	private _renderSankeyMapping(colNames: string[]): TemplateResult {
		return html`
			<div class="chart-mapping">
				<div class="chart-mapping-grid">
					<!-- Source column -->
					<span class="chart-field-group">
						<label>Source</label>
						<select class="chart-select" @change=${this._onSourceColumnChanged}>
							<option value="" ?selected=${!this._sourceColumn}>(select)</option>
							${colNames.map(c => html`
								<option value=${c} ?selected=${this._sourceColumn === c}>${c}</option>
							`)}
						</select>
					</span>

					<!-- Target column -->
					<span class="chart-field-group">
						<label>Target</label>
						<select class="chart-select" @change=${this._onTargetColumnChanged}>
							<option value="" ?selected=${!this._targetColumn}>(select)</option>
							${colNames.map(c => html`
								<option value=${c} ?selected=${this._targetColumn === c}>${c}</option>
							`)}
						</select>
					</span>

					<!-- Value column -->
					<span class="chart-field-group">
						<label>Value</label>
						<select class="chart-select" @change=${this._onValueColumnChanged}>
							<option value="" ?selected=${!this._valueColumn}>(select)</option>
							${colNames.map(c => html`
								<option value=${c} ?selected=${this._valueColumn === c}>${c}</option>
							`)}
						</select>
					</span>

					<!-- Orient -->
					<span class="chart-field-group">
						<label class="axis-label-clickable ${this._sankeyLeftMargin !== 100 ? 'has-settings' : ''}"
							@click=${(e: Event) => this._toggleAxisPopup('sankey-orient', e)}
							title="Click to configure layout settings">Orient</label>
						<select class="chart-select" @change=${this._onOrientChanged}>
							<option value="LR" ?selected=${this._orient === 'LR'}>Left → Right</option>
							<option value="RL" ?selected=${this._orient === 'RL'}>Right → Left</option>
							<option value="TB" ?selected=${this._orient === 'TB'}>Top → Bottom</option>
							<option value="BT" ?selected=${this._orient === 'BT'}>Bottom → Top</option>
						</select>
					</span>

					<span class="chart-grid-spacer" aria-hidden="true"></span>
				</div>
			</div>

			${this._renderSankeyOrientPopup()}
		`;
	}

	private _renderHeatmapMapping(colNames: string[]): TemplateResult {
		const heatmapY = this._yColumns.length ? this._yColumns[0] : '';
		const hs = this._heatmapSettings;
		return html`
			<div class="chart-mapping">
				<div class="chart-mapping-grid">
					<!-- X column -->
					<span class="chart-field-group">
						<label class="axis-label-clickable ${this._hasCustomXSettings() ? 'has-settings' : ''}" data-axis="x"
							@click=${(e: Event) => this._toggleAxisPopup('x', e)}
							title="Click to configure X-axis settings">X</label>
						<select class="chart-select" @change=${this._onXColumnChanged}>
							<option value="" ?selected=${!this._xColumn}>(select)</option>
							${colNames.map(c => html`
								<option value=${c} ?selected=${this._xColumn === c}>${c}</option>
							`)}
						</select>
					</span>

					<!-- Y column (singular) -->
					<span class="chart-field-group">
						<label class="axis-label-clickable ${this._hasCustomYSettings() ? 'has-settings' : ''}" data-axis="y"
							@click=${(e: Event) => this._toggleAxisPopup('y', e)}
							title="Click to configure Y-axis settings">Y</label>
						<select class="chart-select" @change=${this._onHeatmapYColumnChanged}>
							<option value="" ?selected=${!heatmapY}>(select)</option>
							${colNames.map(c => html`
								<option value=${c} ?selected=${heatmapY === c}>${c}</option>
							`)}
						</select>
					</span>

					<!-- Value column -->
					<span class="chart-field-group">
						<label>Value</label>
						<select class="chart-select" @change=${this._onValueColumnChanged}>
							<option value="" ?selected=${!this._valueColumn}>(select)</option>
							${colNames.map(c => html`
								<option value=${c} ?selected=${this._valueColumn === c}>${c}</option>
							`)}
						</select>
					</span>

					<!-- Tooltip -->
					<span class="chart-field-group">
						<label>Tooltip</label>
						${this._renderCheckboxDropdown('tooltip-heatmap', colNames, this._tooltipColumns, '(none)')}
					</span>

					<!-- Slicer (visual map) -->
					<span class="chart-field-group">
						<label class="axis-label-clickable ${this._hasCustomHeatmapSlicerSettings() ? 'has-settings' : ''}"
							@click=${(e: Event) => this._toggleAxisPopup('heatmap-slicer', e)}
							title="Click to configure slicer position and spacing">Slicer</label>
						<select class="chart-select" @change=${(e: Event) => this._onHeatmapSetting('visualMapPosition', (e.target as HTMLSelectElement).value as 'right' | 'left' | 'bottom' | 'top')}>
							${(['right', 'left', 'bottom', 'top'] as const).map(p => html`
								<option value=${p} ?selected=${hs.visualMapPosition === p}>
									${p.charAt(0).toUpperCase() + p.slice(1)}
								</option>
							`)}
						</select>
					</span>

					<!-- Cell labels -->
					<span class="chart-field-group">
						<label class="axis-label-clickable ${this._hasCustomHeatmapLabelSettings() ? 'has-settings' : ''}"
							@click=${(e: Event) => this._toggleAxisPopup('heatmap-labels', e)}
							title="Click to configure cell label settings">Labels</label>
						<label class="toggle-switch" title="Show values inside each cell">
							<input type="checkbox" .checked=${!!hs.showCellLabels}
								@change=${(e: Event) => this._onHeatmapSetting('showCellLabels', (e.target as HTMLInputElement).checked)}>
							<span class="toggle-switch-track"></span>
						</label>
					</span>

					<span class="chart-grid-spacer" aria-hidden="true"></span>
				</div>
			</div>

			${this._renderXAxisPopup()}
			${this._renderYAxisPopup()}
			${this._renderHeatmapLabelsPopup()}
			${this._renderHeatmapSlicerPopup()}
		`;
	}

	// ── Axis settings popup templates ─────────────────────────────────────────

	private _renderTitleRow(): TemplateResult {
		const ALIGN_OPTIONS = ['left', 'center', 'right'] as const;
		const ALIGN_ICONS: Record<string, string> = {
			left: '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M1 3h14v1.5H1zm0 4h9v1.5H1zm0 4h12v1.5H1z"/></svg>',
			center: '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M1 3h14v1.5H1zm3.5 4h7v1.5h-7zM2 11h12v1.5H2z"/></svg>',
			right: '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M1 3h14v1.5H1zm6 4h8v1.5H7zm3 4h5v1.5h-5z"/></svg>',
		};

		return html`
			<div class="chart-title-row">
				<label>Title</label>
				<div class="chart-title-inputs">
					<input type="text" class="chart-title-input"
						placeholder="Chart title"
						style="flex-basis:${this._titleSplitPercent}%"
						.value=${this._chartTitle}
						@input=${(e: Event) => { this._chartTitle = (e.target as HTMLInputElement).value; this._writeToGlobalChartState(); this._renderChart(); this._schedulePersist(); }} />
					<div class="chart-title-splitter" @mousedown=${this._onTitleSplitterDown}></div>
					<input type="text" class="chart-subtitle-input"
						placeholder="Subtitle"
						style="flex-basis:${100 - this._titleSplitPercent}%"
						.value=${this._chartSubtitle}
						@input=${(e: Event) => { this._chartSubtitle = (e.target as HTMLInputElement).value; this._writeToGlobalChartState(); this._renderChart(); this._schedulePersist(); }} />
					<div class="chart-title-align-group">
						${ALIGN_OPTIONS.map(a => html`
							<button type="button"
								class="chart-title-align-btn ${this._chartTitleAlign === a ? 'is-active' : ''}"
								title="${a.charAt(0).toUpperCase() + a.slice(1)} align"
								@click=${() => { this._chartTitleAlign = a; this._writeToGlobalChartState(); this._renderChart(); this._schedulePersist(); }}>
								<span .innerHTML=${ALIGN_ICONS[a]}></span>
							</button>
						`)}
					</div>
				</div>
			</div>
		`;
	}

	private _onTitleSplitterDown(e: MouseEvent): void {
		e.preventDefault();
		const splitter = e.currentTarget as HTMLElement;
		const container = splitter.parentElement;
		if (!container) return;
		splitter.classList.add('is-dragging');
		const containerRect = container.getBoundingClientRect();
		// Subtract space taken by the align-group button cluster
		const alignGroup = container.querySelector('.chart-title-align-group') as HTMLElement | null;
		const alignW = alignGroup ? alignGroup.getBoundingClientRect().width : 0;
		const availableW = containerRect.width - alignW;

		const onMove = (ev: MouseEvent) => {
			const x = ev.clientX - containerRect.left;
			const pct = Math.min(85, Math.max(15, (x / availableW) * 100));
			this._titleSplitPercent = Math.round(pct);
		};
		const onUp = () => {
			splitter.classList.remove('is-dragging');
			document.removeEventListener('mousemove', onMove);
			document.removeEventListener('mouseup', onUp);
		};
		document.addEventListener('mousemove', onMove);
		document.addEventListener('mouseup', onUp);
	}

	private _renderXAxisPopup(): TemplateResult {
		const s = this._xAxisSettings;
		const gapMax = 1000;
		const densMax = this._effectiveMax('x:labelDensity', 100);
		const isHeatmap = this._chartType === 'heatmap';
		return html`
			<kw-popover
				.open=${this._openAxisPopup === 'x'}
				.anchorRect=${this._popoverAnchorRect}
				.title=${'X-Axis Settings'}
				@popover-close=${() => this._closeAxisPopup()}
			>
				<div class="axis-popup-inline">
					<label>Title</label>
					<input type="text" class="axis-text-input" .value=${s.customLabel || ''} placeholder=${this._xColumn || 'Axis title'}
						title="Custom title text for the X axis (leave empty to use column name, enter a space to hide)"
						@input=${(e: Event) => this._onAxisSetting('x', 'customLabel', (e.target as HTMLInputElement).value)}>
					<div class="axis-title-gap-slider" title="Title gap — space in pixels between the axis title and the tick labels">
						${this._renderSlider({
							min: 10, max: gapMax, value: s.titleGap,
							label: `${s.titleGap}px`,
							onInput: (e: Event) => this._onSliderInput('x', 'titleGap', e),
						})}
					</div>
				</div>
				<div class="axis-popup-inline" title="Sort order for X-axis values">
					<label>Sort</label>
					<div class="seg-control">
						<button type="button" class="seg-btn ${!s.sortDirection ? 'is-active' : ''}"
							title="Automatic sort order based on data type"
							@click=${() => this._onAxisSetting('x', 'sortDirection', '')}>Auto</button>
						<button type="button" class="seg-btn ${s.sortDirection === 'asc' ? 'is-active' : ''}"
							title="Sort values in ascending order (A→Z, 0→9)"
							@click=${() => this._onAxisSetting('x', 'sortDirection', 'asc')}>Asc</button>
						<button type="button" class="seg-btn ${s.sortDirection === 'desc' ? 'is-active' : ''}"
							title="Sort values in descending order (Z→A, 9→0)"
							@click=${() => this._onAxisSetting('x', 'sortDirection', 'desc')}>Desc</button>
					</div>
				</div>
				${!isHeatmap ? html`
				<div class="axis-popup-inline" title="How X-axis values are interpreted and spaced">
					<label>Scale</label>
					<div class="seg-control">
						<button type="button" class="seg-btn ${!s.scaleType ? 'is-active' : ''}"
							title="Automatically detect scale type from data"
							@click=${() => this._onAxisSetting('x', 'scaleType', '')}>Auto</button>
						<button type="button" class="seg-btn ${s.scaleType === 'category' ? 'is-active' : ''}"
							title="Treat values as discrete categories with equal spacing"
							@click=${() => this._onAxisSetting('x', 'scaleType', 'category')}>Cat</button>
						<button type="button" class="seg-btn ${s.scaleType === 'continuous' ? 'is-active' : ''}"
							title="Treat values as continuous numbers with proportional spacing"
							@click=${() => this._onAxisSetting('x', 'scaleType', 'continuous')}>Cont</button>
					</div>
				</div>
				<div class="compact-slider-row" title="Percentage of axis labels to show — lower values skip labels to reduce overlap">
					<label>Density</label>
					${this._renderSlider({
						min: 1, max: densMax, value: Math.max(1, s.labelDensity),
						label: s.labelDensity >= 100 ? 'All' : `${s.labelDensity}%`,
						onInput: (e: Event) => this._onSliderInput('x', 'labelDensity', e),
					})}
				</div>
				` : nothing}
				<button slot="header-actions" class="axis-popup-reset-icon" @click=${() => this._resetAxisSettings('x')} title="Reset to defaults">
					${ICONS.discard}
				</button>
			</kw-popover>
		`;
	}

	private _renderYAxisPopup(): TemplateResult {
		const s = this._yAxisSettings;
		const defColors = ['#5470c6','#91cc75','#fac858','#ee6666','#73c0de','#3ba272','#fc8452','#9a60b4','#ea7ccc','#48b8d0'];
		const gapMax = 1000;
		const isHeatmap = this._chartType === 'heatmap';
		return html`
			<kw-popover
				.open=${this._openAxisPopup === 'y'}
				.anchorRect=${this._popoverAnchorRect}
				.title=${'Y-Axis Settings'}
				@popover-close=${() => this._closeAxisPopup()}
			>
				<div class="axis-popup-inline">
					<label>Title</label>
					<input type="text" class="axis-text-input" .value=${s.customLabel || ''} placeholder=${this._yColumns.join(', ') || 'Axis title'}
						title="Custom title text for the Y axis (leave empty to use column name, enter a space to hide)"
						@input=${(e: Event) => this._onAxisSetting('y', 'customLabel', (e.target as HTMLInputElement).value)}>
					<div class="axis-title-gap-slider" title="Title gap — space in pixels between the axis title and the tick labels">
						${this._renderSlider({
							min: 10, max: gapMax, value: s.titleGap,
							label: `${s.titleGap}px`,
							onInput: (e: Event) => this._onSliderInput('y', 'titleGap', e),
						})}
					</div>
				</div>
				${isHeatmap ? html`
				<div class="axis-popup-inline" title="Sort order for Y-axis values">
					<label>Sort</label>
					<div class="seg-control">
						<button type="button" class="seg-btn ${!s.sortDirection ? 'is-active' : ''}"
							title="Automatic sort order (alphabetical ascending)"
							@click=${() => this._onAxisSetting('y', 'sortDirection', '')}>Auto</button>
						<button type="button" class="seg-btn ${s.sortDirection === 'asc' ? 'is-active' : ''}"
							title="Sort values in ascending order (A→Z)"
							@click=${() => this._onAxisSetting('y', 'sortDirection', 'asc')}>Asc</button>
						<button type="button" class="seg-btn ${s.sortDirection === 'desc' ? 'is-active' : ''}"
							title="Sort values in descending order (Z→A)"
							@click=${() => this._onAxisSetting('y', 'sortDirection', 'desc')}>Desc</button>
					</div>
				</div>
				` : nothing}
				${!isHeatmap ? (() => {
					const isStacked100 = this._stackMode === 'stacked100' || this._legendSettings.stackMode === 'stacked100';
					return html`
					<div class="axis-popup-minmax" title=${isStacked100 ? 'Range is fixed at 0–100% in Stacked 100% mode' : 'Set custom minimum and maximum values for the Y axis'}>
						<label style=${isStacked100 ? 'opacity: 0.4' : ''}>Range</label>
						<input type="text" class="axis-popup-minmax-input" inputmode="decimal"
							.value=${s.min || ''} placeholder="Min"
							title=${isStacked100 ? 'Range is fixed at 0–100% in Stacked 100% mode' : 'Minimum Y-axis value (leave empty for auto)'}
							?disabled=${isStacked100}
							@change=${(e: Event) => this._onAxisSetting('y', 'min', (e.target as HTMLInputElement).value)}>
						<span class="axis-popup-minmax-sep">–</span>
						<input type="text" class="axis-popup-minmax-input" inputmode="decimal"
							.value=${s.max || ''} placeholder="Max"
							title=${isStacked100 ? 'Range is fixed at 0–100% in Stacked 100% mode' : 'Maximum Y-axis value (leave empty for auto)'}
							?disabled=${isStacked100}
							@change=${(e: Event) => this._onAxisSetting('y', 'max', (e.target as HTMLInputElement).value)}>
					</div>`;
				})() : nothing}
				${!isHeatmap ? (() => {
					const legendVals = this._legendColumn ? this._getLegendValues() : [];
					const seriesNames = legendVals.length > 0 ? legendVals : this._yColumns;
					return seriesNames.length > 0 ? html`
						<div title="Customize the color for each data series">
							<div class="axis-popup-colors-header">Series Colors</div>
							<div class="axis-popup-colors-grid">
								${seriesNames.map((col, i) => {
									const custom = s.seriesColors?.[col] || '';
									const def = defColors[i % defColors.length];
									return html`
										<div class="axis-popup-color-chip">
											<input type="color" .value=${custom || def}
												@change=${(e: Event) => this._onSeriesColorChanged(col, (e.target as HTMLInputElement).value, def)}>
											<span class="axis-popup-color-label" title=${col}>${col}</span>
										</div>
									`;
								})}
							</div>
						</div>
					` : nothing;
				})() : nothing}
				<button slot="header-actions" class="axis-popup-reset-icon" @click=${() => this._resetAxisSettings('y')} title="Reset to defaults">
					${ICONS.discard}
				</button>
			</kw-popover>
		`;
	}

	private _renderLabelSettingsPopup(): TemplateResult {
		const densMax = this._effectiveMax('labels:labelDensity', 100);
		return html`
			<kw-popover
				.open=${this._openAxisPopup === 'labels'}
				.anchorRect=${this._popoverAnchorRect}
				.title=${'Label Settings'}
				@popover-close=${() => this._closeAxisPopup()}
			>
				<div class="axis-popup-inline">
					<label>Display</label>
					<div class="seg-control">
						<button type="button" class="seg-btn ${this._labelMode === 'auto' ? 'is-active' : ''}"
							@click=${() => { this._labelMode = 'auto'; this._schedulePersist(); }}>Auto</button>
						<button type="button" class="seg-btn ${this._labelMode === 'all' ? 'is-active' : ''}"
							@click=${() => { this._labelMode = 'all'; this._schedulePersist(); }}>All</button>
						<button type="button" class="seg-btn ${this._labelMode === 'top5' ? 'is-active' : ''}"
							@click=${() => { this._labelMode = 'top5'; this._schedulePersist(); }}>Top 5</button>
						<button type="button" class="seg-btn ${this._labelMode === 'top10' ? 'is-active' : ''}"
							@click=${() => { this._labelMode = 'top10'; this._schedulePersist(); }}>Top 10</button>
						<button type="button" class="seg-btn ${this._labelMode === 'topPercent' ? 'is-active' : ''}"
							@click=${() => { this._labelMode = 'topPercent'; this._schedulePersist(); }}>≥5%</button>
					</div>
				</div>
				${this._labelMode === 'auto' ? html`
					<div class="compact-slider-row">
						<label>Density</label>
						${this._renderSlider({
							min: 0, max: densMax, value: this._labelDensity,
							label: `${this._labelDensity}%`,
							onInput: (e: Event) => this._onSliderInput('labels', 'labelDensity', e),
						})}
					</div>
				` : nothing}
			</kw-popover>
		`;
	}

	private _renderLegendPopup(): TemplateResult {
		const ls = this._legendSettings;
		const titlePlaceholder = this._legendColumn || 'Column name';
		const gapMax = this._effectiveMax('legend:gap', 80);
		return html`
			<kw-popover
				.open=${this._openAxisPopup === 'legend'}
				.anchorRect=${this._popoverAnchorRect}
				.title=${'Legend Settings'}
				@popover-close=${() => this._closeAxisPopup()}
			>
				<div class="axis-popup-inline" title="Where the legend is placed relative to the chart">
					<label>Position</label>
					<div class="seg-control seg-control--compact">
						${(['top', 'right', 'bottom', 'left'] as const).map(p => html`
							<button type="button" class="seg-btn seg-btn--icon-only ${ls.position === p ? 'is-active' : ''}"
								title=${'Place legend at the ' + p + ' of the chart'}
								@click=${() => this._onLegendSetting('position', p)}>
								<span .innerHTML=${LEGEND_POSITION_ICONS[p]}></span>
							</button>
						`)}
					</div>
				</div>
				<div class="axis-popup-inline" title="How series data is combined — normal (overlapping), stacked, or stacked as percentages">
					<label>Mode</label>
					<div class="seg-control seg-control--compact">
						${(['normal', 'stacked', 'stacked100'] as const).map(m => html`
							<button type="button" class="seg-btn seg-btn--icon-only ${ls.stackMode === m ? 'is-active' : ''}"
								title=${STACK_MODE_LABELS[m] + (m === 'normal' ? ' — each series drawn independently' : m === 'stacked' ? ' — series stacked on top of each other' : ' — series stacked and normalized to 100%')}
								@click=${() => this._onLegendSetting('stackMode', m)}>
								<span .innerHTML=${STACK_MODE_ICONS[m]}></span>
							</button>
						`)}
					</div>
				</div>
				<div class="axis-popup-inline" title="Custom legend heading (leave empty to use the legend column name)">
					<label>Title</label>
					<input type="text" .value=${ls.title || ''} placeholder=${titlePlaceholder}
						title="Custom legend heading (leave empty to use the legend column name)"
						@input=${(e: Event) => this._onLegendSetting('title', (e.target as HTMLInputElement).value)}>
				</div>
				<div class="compact-slider-row" title="Space in pixels between the legend and the chart area">
					<label>Gap</label>
					${this._renderSlider({
						min: 0, max: gapMax, value: ls.gap,
						label: `${ls.gap}px`,
						onInput: (e: Event) => this._onSliderInput('legend', 'gap', e),
					})}
					<input type="number" class="slider-value-input" min="0"
						title="Space in pixels between the legend and the chart area"
						.value=${String(ls.gap)}
						@change=${(e: Event) => this._onSliderValueInput('legend', 'gap', (e.target as HTMLInputElement).value, 0, 80)}>
				</div>
				<div class="axis-popup-inline" title="Order in which legend entries appear">
					<label>Sort</label>
					<select title="Order in which legend entries appear" @change=${(e: Event) => this._onLegendSetting('sortMode', (e.target as HTMLSelectElement).value)}>
						<option value="" ?selected=${!ls.sortMode}>Default (data order)</option>
						<option value="alpha-asc" ?selected=${ls.sortMode === 'alpha-asc'}>Name A → Z</option>
						<option value="alpha-desc" ?selected=${ls.sortMode === 'alpha-desc'}>Name Z → A</option>
						<option value="value-asc" ?selected=${ls.sortMode === 'value-asc'}>Value ascending</option>
						<option value="value-desc" ?selected=${ls.sortMode === 'value-desc'}>Value descending</option>
					</select>
				</div>
				<div class="axis-popup-inline" title="Limit the number of legend entries shown — remaining series are grouped into 'Other'">
					<label>Top N</label>
					<select title="Limit the number of legend entries shown" @change=${(e: Event) => this._onLegendSetting('topN', parseInt((e.target as HTMLSelectElement).value, 10))}>
						<option value="0" ?selected=${!ls.topN}>All (no limit)</option>
						<option value="5" ?selected=${ls.topN === 5}>Top 5 + Other</option>
						<option value="10" ?selected=${ls.topN === 10}>Top 10 + Other</option>
						<option value="15" ?selected=${ls.topN === 15}>Top 15 + Other</option>
						<option value="20" ?selected=${ls.topN === 20}>Top 20 + Other</option>
					</select>
				</div>
				${this._chartType === 'line' || this._chartType === 'area' ? html`
					<div class="axis-popup-inline" title="Display the series name at the end of each line">
						<label>End labels</label>
						<label class="toggle-switch" title="Show the series name label at the end of each line">
							<input type="checkbox" .checked=${!!ls.showEndLabels}
								@change=${(e: Event) => this._onLegendSetting('showEndLabels', (e.target as HTMLInputElement).checked)}>
							<span class="toggle-switch-track"></span>
						</label>
					</div>
				` : nothing}
				<button slot="header-actions" class="axis-popup-reset-icon" @click=${() => this._resetLegendSettings()} title="Reset to defaults">
					${ICONS.discard}
				</button>
			</kw-popover>
		`;
	}

	private _renderHeatmapLabelsPopup(): TemplateResult {
		const hs = this._heatmapSettings;
		return html`
			<kw-popover
				.open=${this._openAxisPopup === 'heatmap-labels'}
				.anchorRect=${this._popoverAnchorRect}
				.title=${'Cell Label Settings'}
				@popover-close=${() => this._closeAxisPopup()}
			>
				<div class="axis-popup-inline" title="Which cells to label">
					<label>Show</label>
					<select class="chart-select" @change=${(e: Event) => this._onHeatmapSetting('cellLabelMode', (e.target as HTMLSelectElement).value)}>
						<option value="all" ?selected=${hs.cellLabelMode === 'all'}>All labels</option>
						<option value="lowest" ?selected=${hs.cellLabelMode === 'lowest'}>Only bottom N</option>
						<option value="highest" ?selected=${hs.cellLabelMode === 'highest'}>Only top N</option>
						<option value="both" ?selected=${hs.cellLabelMode === 'both'}>Both top and bottom N</option>
					</select>
				</div>
				${hs.cellLabelMode !== 'all' ? html`
					<div class="compact-slider-row" title="Number of lowest/highest values to label">
						<label>N</label>
						${this._renderSlider({
							min: 1, max: this._effectiveMax('heatmap:cellLabelN', 50), value: hs.cellLabelN,
							label: String(hs.cellLabelN),
							onInput: (e: Event) => {
								const v = parseInt((e.target as HTMLInputElement).value, 10);
								this._onHeatmapSetting('cellLabelN', v);
							},
						})}
					</div>
				` : nothing}
				<button slot="header-actions" class="axis-popup-reset-icon" @click=${() => this._resetHeatmapLabelSettings()} title="Reset to defaults">
					${ICONS.discard}
				</button>
			</kw-popover>
		`;
	}

	private _renderHeatmapSlicerPopup(): TemplateResult {
		const hs = this._heatmapSettings;
		const gapMax = this._effectiveMax('heatmap:visualMapGap', 200);
		return html`
			<kw-popover
				.open=${this._openAxisPopup === 'heatmap-slicer'}
				.anchorRect=${this._popoverAnchorRect}
				.title=${'Slicer Settings'}
				@popover-close=${() => this._closeAxisPopup()}
			>
				<div class="compact-slider-row" title="Space in pixels between the chart area and the slicer">
					<label>Gap</label>
					${this._renderSlider({
						min: 0, max: gapMax, value: hs.visualMapGap,
						label: `${hs.visualMapGap}px`,
						onInput: (e: Event) => {
							const v = parseInt((e.target as HTMLInputElement).value, 10);
							this._onHeatmapSetting('visualMapGap', v);
						},
					})}
				</div>
				<button slot="header-actions" class="axis-popup-reset-icon" @click=${() => this._resetHeatmapSlicerSettings()} title="Reset to defaults">
					${ICONS.discard}
				</button>
			</kw-popover>
		`;
	}

	private _renderSankeyOrientPopup(): TemplateResult {
		return html`
			<kw-popover
				.open=${this._openAxisPopup === 'sankey-orient'}
				.anchorRect=${this._popoverAnchorRect}
				.title=${'Layout Settings'}
				@popover-close=${() => this._closeAxisPopup()}
			>
				<div class="compact-slider-row" title="Margin of the sankey chart in pixels">
					<label>Margin</label>
					${this._renderSlider({
						min: 0, max: this._effectiveMax('sankey:leftMargin', 500), value: this._sankeyLeftMargin,
						label: `${this._sankeyLeftMargin}px`,
						onInput: (e: Event) => {
							this._sankeyLeftMargin = parseInt((e.target as HTMLInputElement).value, 10);
							this._schedulePersist();
						},
					})}
				</div>
				<button slot="header-actions" class="axis-popup-reset-icon" @click=${() => { this._sankeyLeftMargin = 100; this._sliderMaxOverrides.delete('sankey:leftMargin'); this._schedulePersist(); }} title="Reset to defaults">
					${ICONS.discard}
				</button>
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
		} else if (dropdownId === 'tooltip' || dropdownId === 'tooltip-pie' || dropdownId === 'tooltip-heatmap') {
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

	private _onHeatmapYColumnChanged(e: Event): void {
		const val = (e.target as HTMLSelectElement).value;
		this._yColumns = val ? [val] : [];
		this._schedulePersist();
	}

	private _onLegendColumnChanged(e: Event): void {
		this._legendColumn = (e.target as HTMLSelectElement).value;
		if (!this._legendColumn) {
			this._resetLegendSettings();
		}
		this._schedulePersist();
	}

	private _cycleLegendPosition(): void {
		const idx = LEGEND_CYCLE.indexOf(this._legendPosition);
		this._legendPosition = LEGEND_CYCLE[(idx + 1) % LEGEND_CYCLE.length];
		this._legendSettings = { ...this._legendSettings, position: this._legendPosition };
		this._schedulePersist();
	}

	private _cycleStackMode(): void {
		const idx = STACK_MODE_CYCLE.indexOf(this._stackMode);
		this._stackMode = STACK_MODE_CYCLE[(idx + 1) % STACK_MODE_CYCLE.length];
		this._legendSettings = { ...this._legendSettings, stackMode: this._stackMode };
		this._schedulePersist();
	}

	private _onLegendSetting(key: string, value: unknown): void {
		this._legendSettings = { ...this._legendSettings, [key]: value };
		// Keep top-level properties in sync with legendSettings
		if (key === 'position') this._legendPosition = normalizeLegendPosition(value);
		if (key === 'stackMode') this._stackMode = normalizeStackMode(value);
		this._schedulePersist();
	}

	private _resetLegendSettings(): void {
		this._legendSettings = getDefaultLegendSettings();
		this._legendPosition = this._legendSettings.position;
		this._stackMode = this._legendSettings.stackMode;
		this._sliderMaxOverrides.delete('legend:gap');
		this._schedulePersist();
	}

	private _hasCustomLegendSettings(): boolean {
		return hasCustomLegendSettings(this._legendSettings);
	}

	// ── Heatmap settings handlers ─────────────────────────────────────────────

	private _onHeatmapSetting(key: string, value: unknown): void {
		this._heatmapSettings = { ...this._heatmapSettings, [key]: value };
		this._schedulePersist();
	}

	private _resetHeatmapLabelSettings(): void {
		const d = getDefaultHeatmapSettings();
		this._heatmapSettings = {
			...this._heatmapSettings,
			showCellLabels: d.showCellLabels,
			cellLabelMode: d.cellLabelMode,
			cellLabelN: d.cellLabelN,
		};
		this._sliderMaxOverrides.delete('heatmap:cellLabelN');
		this._schedulePersist();
	}

	private _resetHeatmapSlicerSettings(): void {
		const d = getDefaultHeatmapSettings();
		this._heatmapSettings = {
			...this._heatmapSettings,
			visualMapGap: d.visualMapGap,
		};
		this._sliderMaxOverrides.delete('heatmap:visualMapGap');
		this._schedulePersist();
	}

	private _hasCustomHeatmapLabelSettings(): boolean {
		const hs = this._heatmapSettings;
		const d = getDefaultHeatmapSettings();
		return hs.showCellLabels !== d.showCellLabels || hs.cellLabelMode !== d.cellLabelMode || hs.cellLabelN !== d.cellLabelN;
	}

	private _hasCustomHeatmapSlicerSettings(): boolean {
		const hs = this._heatmapSettings;
		const d = getDefaultHeatmapSettings();
		return hs.visualMapGap !== d.visualMapGap;
	}

	private _toggleDataLabels(): void {
		this._showDataLabels = !this._showDataLabels;
		if (this._showDataLabels && this._labelDensity <= 0) {
			this._labelDensity = 50;
		}
		if (!this._showDataLabels) {
			this._labelDensity = 0;
		}
		this._schedulePersist();
	}

	/** Handle the combined labels density slider — 0 = off, >0 = on with density. */
	private _onLabelDensitySlider(e: Event): void {
		const value = parseInt((e.target as HTMLInputElement).value, 10);
		this._labelDensity = value;
		this._showDataLabels = value > 0;
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

	private _onSourceColumnChanged(e: Event): void {
		this._sourceColumn = (e.target as HTMLSelectElement).value;
		this._schedulePersist();
	}

	private _onTargetColumnChanged(e: Event): void {
		this._targetColumn = (e.target as HTMLSelectElement).value;
		this._schedulePersist();
	}

	private _onOrientChanged(e: Event): void {
		this._orient = (e.target as HTMLSelectElement).value as 'LR' | 'RL' | 'TB' | 'BT';
		this._schedulePersist();
	}

	// ── Axis settings handlers ────────────────────────────────────────────────

	private _toggleAxisPopup(axis: 'x' | 'y' | 'labels' | 'legend' | 'heatmap-labels' | 'heatmap-slicer' | 'sankey-orient', e: Event): void {
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

	private _onSeriesColorChangeFromTooltip(e: Event): void {
		const detail = (e as CustomEvent).detail;
		if (!detail?.seriesName || !detail?.color) return;
		const colors = { ...(this._yAxisSettings.seriesColors || {}) };
		colors[detail.seriesName] = detail.color;
		this._yAxisSettings = { ...this._yAxisSettings, seriesColors: colors };
		this._schedulePersist();
	}

	private _resetAxisSettings(axis: 'x' | 'y'): void {
		if (axis === 'x') {
			this._xAxisSettings = defaultXAxisSettings();
			this._sliderMaxOverrides.delete('x:titleGap');
			this._sliderMaxOverrides.delete('x:labelDensity');
		} else {
			this._yAxisSettings = defaultYAxisSettings();
			this._sliderMaxOverrides.delete('y:titleGap');
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

	// ── Compact slider / segmented control helpers ─────────────────────────────

	/** CSS custom property for slider accent fill. */
	private _sliderPct(value: number, min: number, max: number): string {
		const pct = max > min ? ((value - min) / (max - min)) * 100 : 0;
		return `--slider-pct: ${Math.round(Math.max(0, Math.min(100, pct)))}%`;
	}

	/** Render a compact slider bar with ghost text overlay. */
	private _renderSlider(opts: {
		min: number; max: number; value: number; label: string;
		onInput: (e: Event) => void;
		onMousedown?: (e: Event) => void;
	}): TemplateResult {
		return html`
			<div class="slider-wrap">
				<input type="range" class="compact-slider"
					min=${opts.min} .max=${String(opts.max)}
					style=${this._sliderPct(opts.value, opts.min, opts.max)}
					.value=${String(opts.value)}
					@mousedown=${opts.onMousedown || nothing}
					@input=${opts.onInput}
					title=${opts.label}>
				<span class="slider-ghost-text">${opts.label}</span>
			</div>
		`;
	}

	/** Effective slider max — uses sticky override if the user typed a custom max, otherwise defaultMax. */
	private _effectiveMax(sliderKey: string, defaultMax: number): number {
		const override = this._sliderMaxOverrides.get(sliderKey);
		return override !== undefined ? Math.max(defaultMax, override) : defaultMax;
	}

	/** Handle the editable number input next to a slider — sets value and stretches max if needed. */
	private _onSliderValueInput(axis: 'x' | 'y' | 'legend' | 'labels' | 'heatmap', key: string, rawStr: string, min: number, defaultMax: number): void {
		const parsed = parseInt(rawStr, 10);
		if (!Number.isFinite(parsed)) return;
		const clamped = Math.max(min, parsed);
		// Store a sticky max override if the typed value exceeds the default max
		const sliderKey = `${axis}:${key}`;
		if (clamped > defaultMax) {
			this._sliderMaxOverrides.set(sliderKey, clamped);
		}
		if (axis === 'x' || axis === 'y') {
			this._onAxisSetting(axis, key, clamped);
		} else if (axis === 'legend') {
			this._onLegendSetting(key, clamped);
		} else if (axis === 'labels') {
			this._labelDensity = clamped;
			this._schedulePersist();
		} else if (axis === 'heatmap') {
			this._onHeatmapSetting(key, clamped);
		}
	}

	/** Handle slider range input — sync both the setting and the CSS fill. */
	private _onSliderInput(axis: 'x' | 'y' | 'legend' | 'labels', key: string, e: Event): void {
		const value = parseInt((e.target as HTMLInputElement).value, 10);
		if (axis === 'x' || axis === 'y') {
			this._onAxisSetting(axis, key, value);
		} else if (axis === 'legend') {
			this._onLegendSetting(key, value);
		} else if (axis === 'labels') {
			this._labelDensity = value;
			this._schedulePersist();
		}
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
			if (typeof config.stackMode === 'string') this._stackMode = normalizeStackMode(config.stackMode);
			if (typeof config.sortColumn === 'string') this._sortColumn = config.sortColumn;
			if (typeof config.sortDirection === 'string') this._sortDirection = config.sortDirection as SortDirection;
			if (typeof config.sourceColumn === 'string') this._sourceColumn = config.sourceColumn;
			if (typeof config.targetColumn === 'string') this._targetColumn = config.targetColumn;
			if (typeof config.orient === 'string') this._orient = this._normalizeOrient(config.orient);
			if (typeof config.sankeyLeftMargin === 'number') this._sankeyLeftMargin = config.sankeyLeftMargin;
			if (typeof config.labelMode === 'string') this._labelMode = config.labelMode as LabelMode;
			if (typeof config.labelDensity === 'number') this._labelDensity = config.labelDensity;
			if (typeof config.chartTitle === 'string') this._chartTitle = config.chartTitle;
			if (typeof config.chartSubtitle === 'string') this._chartSubtitle = config.chartSubtitle;
			if (typeof config.chartTitleAlign === 'string') this._chartTitleAlign = config.chartTitleAlign as 'left' | 'center' | 'right';
			if (config.xAxisSettings && typeof config.xAxisSettings === 'object') {
				this._xAxisSettings = { ...this._xAxisSettings, ...(config.xAxisSettings as Partial<XAxisSettings>) };
			}
			if (config.yAxisSettings && typeof config.yAxisSettings === 'object') {
				this._yAxisSettings = { ...this._yAxisSettings, ...(config.yAxisSettings as Partial<YAxisSettings>) };
			}
			if (config.legendSettings && typeof config.legendSettings === 'object') {
				this._legendSettings = { ...this._legendSettings, ...(config.legendSettings as Partial<LegendSettings>) };
				this._legendPosition = normalizeLegendPosition(this._legendSettings.position);
				this._stackMode = normalizeStackMode(this._legendSettings.stackMode);
			}
			if (config.heatmapSettings && typeof config.heatmapSettings === 'object') {
				this._heatmapSettings = { ...this._heatmapSettings, ...(config.heatmapSettings as Partial<HeatmapSettings>) };
			}
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
		if (typeof st.sourceColumn === 'string') this._sourceColumn = st.sourceColumn;
		if (typeof st.targetColumn === 'string') this._targetColumn = st.targetColumn;
		if (typeof st.orient === 'string') this._orient = this._normalizeOrient(st.orient);
		if (typeof st.sankeyLeftMargin === 'number') this._sankeyLeftMargin = st.sankeyLeftMargin;
		if (st.xAxisSettings && typeof st.xAxisSettings === 'object') {
			this._xAxisSettings = { ...defaultXAxisSettings(), ...st.xAxisSettings };
		}
		if (st.yAxisSettings && typeof st.yAxisSettings === 'object') {
			this._yAxisSettings = { ...defaultYAxisSettings(), ...st.yAxisSettings };
		}
		if (st.legendSettings && typeof st.legendSettings === 'object') {
			this._legendSettings = { ...getDefaultLegendSettings(), ...st.legendSettings };
			this._legendPosition = normalizeLegendPosition(this._legendSettings.position);
			this._stackMode = normalizeStackMode(this._legendSettings.stackMode);
		}
		if (st.heatmapSettings && typeof st.heatmapSettings === 'object') {
			this._heatmapSettings = { ...getDefaultHeatmapSettings(), ...st.heatmapSettings };
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
		st.sourceColumn = this._sourceColumn;
		st.targetColumn = this._targetColumn;
		st.orient = this._orient;
		st.sankeyLeftMargin = this._sankeyLeftMargin;
		st.chartTitle = this._chartTitle;
		st.chartSubtitle = this._chartSubtitle;
		st.chartTitleAlign = this._chartTitleAlign;
		st.xAxisSettings = { ...this._xAxisSettings };
		st.yAxisSettings = { ...this._yAxisSettings };
		st.legendSettings = { ...this._legendSettings };
		st.heatmapSettings = { ...this._heatmapSettings };

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

	/** Get unique values of the legend column from the current dataset, respecting topN. */
	private _getLegendValues(): string[] {
		if (!this._legendColumn || !this._dataSourceId) return [];
		const ds = this._datasets.find(d => d.id === this._dataSourceId);
		if (!ds || !Array.isArray(ds.columns) || !Array.isArray(ds.rows)) return [];
		const colNames = ds.columns.map((c: unknown) => {
			if (typeof c === 'string') return c;
			if (c && typeof c === 'object') return (c as Record<string, string>).name || (c as Record<string, string>).columnName || '';
			return '';
		});
		const colIdx = colNames.indexOf(this._legendColumn);
		if (colIdx < 0) return [];

		// Find Y column index for topN ranking
		const yCol = this._yColumns.length > 0 ? this._yColumns[0] : '';
		const yIdx = yCol ? colNames.indexOf(yCol) : -1;

		// Collect unique legend values and their aggregate Y sums
		const order: string[] = [];
		const sums: Record<string, number> = {};
		const seen = new Set<string>();
		for (const row of ds.rows) {
			if (!Array.isArray(row) || row.length <= colIdx) continue;
			const val = cellToChartString(row[colIdx]);
			if (!val) continue;
			if (!seen.has(val)) {
				seen.add(val);
				order.push(val);
				sums[val] = 0;
			}
			if (yIdx >= 0 && row.length > yIdx) {
				const raw = cellToChartString(row[yIdx]);
				const num = parseFloat(raw);
				if (Number.isFinite(num)) sums[val] += Math.abs(num);
			}
		}

		// Apply topN filtering
		const topN = this._legendSettings.topN || 0;
		if (topN > 0 && order.length > topN) {
			const ranked = [...order].sort((a, b) => (sums[b] || 0) - (sums[a] || 0));
			const topSet = new Set(ranked.slice(0, topN));
			const filtered = order.filter(n => topSet.has(n));
			if (order.length > topN) filtered.push('Other');
			return filtered;
		}

		return order;
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
		this._syncRenderingState();
	}

	/** Sync _isChartRendering from the chart renderer's __wasRendering flag. */
	private _syncRenderingState(): void {
		const st = (window as any).chartStateByBoxId?.[this.boxId];
		const rendering = !!(st && st.__wasRendering);
		if (this._isChartRendering !== rendering) {
			this._isChartRendering = rendering;
		}
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
		if (this._sourceColumn) data.sourceColumn = this._sourceColumn;
		if (this._targetColumn) data.targetColumn = this._targetColumn;
		if (this._orient !== 'LR') data.orient = this._orient;
		if (this._sankeyLeftMargin !== 100) data.sankeyLeftMargin = this._sankeyLeftMargin;
		if (this._chartTitle) data.chartTitle = this._chartTitle;
		if (this._chartSubtitle) data.chartSubtitle = this._chartSubtitle;
		if (this._chartTitleAlign !== 'center') data.chartTitleAlign = this._chartTitleAlign;

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

		if (hasCustomLegendSettings(this._legendSettings)) {
			data.legendSettings = { ...this._legendSettings };
		}

		if (hasCustomHeatmapSettings(this._heatmapSettings)) {
			data.heatmapSettings = { ...this._heatmapSettings };
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
		if (typeof options.sourceColumn === 'string') this._sourceColumn = options.sourceColumn;
		if (typeof options.targetColumn === 'string') this._targetColumn = options.targetColumn;
		if (typeof options.orient === 'string') this._orient = this._normalizeOrient(options.orient as string);
		if (typeof options.sankeyLeftMargin === 'number') this._sankeyLeftMargin = options.sankeyLeftMargin;
		if (typeof options.chartTitle === 'string') this._chartTitle = options.chartTitle;
		if (typeof options.chartSubtitle === 'string') this._chartSubtitle = options.chartSubtitle;
		if (typeof options.chartTitleAlign === 'string') this._chartTitleAlign = (options.chartTitleAlign as 'left' | 'center' | 'right') || 'center';
		if (options.xAxisSettings && typeof options.xAxisSettings === 'object') {
			this._xAxisSettings = { ...defaultXAxisSettings(), ...this._xAxisSettings, ...(options.xAxisSettings as Partial<XAxisSettings>) };
		}
		if (options.yAxisSettings && typeof options.yAxisSettings === 'object') {
			this._yAxisSettings = { ...defaultYAxisSettings(), ...this._yAxisSettings, ...(options.yAxisSettings as Partial<YAxisSettings>) };
		}
		if (options.legendSettings && typeof options.legendSettings === 'object') {
			this._legendSettings = { ...getDefaultLegendSettings(), ...this._legendSettings, ...(options.legendSettings as Partial<LegendSettings>) };
			this._legendPosition = normalizeLegendPosition(this._legendSettings.position);
			this._stackMode = normalizeStackMode(this._legendSettings.stackMode);
		}
		if (options.heatmapSettings && typeof options.heatmapSettings === 'object') {
			this._heatmapSettings = { ...getDefaultHeatmapSettings(), ...this._heatmapSettings, ...(options.heatmapSettings as Partial<HeatmapSettings>) };
		}
	}

	// ── Private helpers ───────────────────────────────────────────────────────

	/** Normalize orient values, including back-compat with old 'horizontal'/'vertical'. */
	private _normalizeOrient(v: string): 'LR' | 'RL' | 'TB' | 'BT' {
		if (v === 'RL' || v === 'TB' || v === 'BT') return v;
		if (v === 'vertical') return 'TB';
		return 'LR';
	}

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

	/** Set section name programmatically (used by agent tools). */
	public setName(name: string): void {
		this._name = name;
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
