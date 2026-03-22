// Chart box factory — creates Lit elements and light-DOM chart containers.
// ECharts rendering engine lives in shared/chart-renderer.ts.
// Window bridge exports at bottom for remaining legacy callers.
import { schedulePersist } from './persistence';
import { getScrollY, maybeAutoScrollWhileDragging } from './utils';
import { __kustoCleanupSectionModeResizeObserver } from './extraBoxes';
import { getDefaultXAxisSettings, getDefaultYAxisSettings } from '../shared/chart-utils.js';
import {
getChartState,
renderChart,
disposeChartEcharts,
maximizeChartBox,
getChartMinResizeHeight,
} from '../shared/chart-renderer.js';

// Re-export rendering functions for existing consumers (preserving __kusto prefix).
export {
getChartState as __kustoGetChartState,
renderChart as __kustoRenderChart,
disposeChartEcharts as __kustoDisposeChartEcharts,
maximizeChartBox as __kustoMaximizeChartBox,
getChartMinResizeHeight as __kustoGetChartMinResizeHeight,
};

// ── UI sync helper (consumed by extraBoxes.ts) ────────────────────────────────

export function __kustoUpdateChartBuilderUI(boxId: any) {
const id = String(boxId || '');
if (!id) return;
try {
const el = document.getElementById(id) as any;
if (el && typeof el.refreshDatasets === 'function') {
if (typeof el.syncFromGlobalState === 'function') el.syncFromGlobalState();
el.refreshDatasets();
return;
}
} catch (e) { console.error('[kusto]', e); }
}

// ── State access (shared global arrays) ───────────────────────────────────────

window.chartStateByBoxId = window.chartStateByBoxId || {};
const chartStateByBoxId = window.chartStateByBoxId;
window.__kustoChartBoxes = window.__kustoChartBoxes || [];
export let chartBoxes: any[] = window.__kustoChartBoxes;

// ── Factory ───────────────────────────────────────────────────────────────────

export function addChartBox( options: any) {
const id = (options && options.id) ? String(options.id) : ('chart_' + Date.now());
chartBoxes.push(id);
const st = getChartState(id);
st.mode = (options && typeof options.mode === 'string' && String(options.mode).toLowerCase() === 'preview') ? 'preview' : 'edit';
st.expanded = (options && typeof options.expanded === 'boolean') ? !!options.expanded : true;
st.dataSourceId = (options && typeof options.dataSourceId === 'string') ? String(options.dataSourceId) : (st.dataSourceId || '');
st.chartType = (options && typeof options.chartType === 'string') ? String(options.chartType) : (st.chartType || 'area');
st.xColumn = (options && typeof options.xColumn === 'string') ? String(options.xColumn) : (st.xColumn || '');
st.yColumn = (options && typeof options.yColumn === 'string') ? String(options.yColumn) : (st.yColumn || '');
st.yColumns = (options && Array.isArray(options.yColumns)) ? options.yColumns.filter((c: any) => c) : (st.yColumns || (st.yColumn ? [st.yColumn] : []));
st.legendColumn = (options && typeof options.legendColumn === 'string') ? String(options.legendColumn) : (st.legendColumn || '');
st.legendPosition = (options && typeof options.legendPosition === 'string') ? String(options.legendPosition) : (st.legendPosition || 'top');
st.labelColumn = (options && typeof options.labelColumn === 'string') ? String(options.labelColumn) : (st.labelColumn || '');
st.valueColumn = (options && typeof options.valueColumn === 'string') ? String(options.valueColumn) : (st.valueColumn || '');
st.showDataLabels = (options && typeof options.showDataLabels === 'boolean') ? !!options.showDataLabels : (st.showDataLabels || false);
st.labelMode = (options && typeof options.labelMode === 'string') ? String(options.labelMode) : (st.labelMode || 'auto');
st.labelDensity = (options && typeof options.labelDensity === 'number') ? options.labelDensity : (typeof st.labelDensity === 'number' ? st.labelDensity : 50);
st.tooltipColumns = (options && Array.isArray(options.tooltipColumns)) ? options.tooltipColumns.filter((c: any) => c) : (Array.isArray(st.tooltipColumns) ? st.tooltipColumns : []);
st.sortColumn = (options && typeof options.sortColumn === 'string') ? String(options.sortColumn) : (st.sortColumn || '');
st.sortDirection = (options && typeof options.sortDirection === 'string') ? String(options.sortDirection) : (st.sortDirection || '');
if (options && options.xAxisSettings && typeof options.xAxisSettings === 'object') {
st.xAxisSettings = { ...getDefaultXAxisSettings(), ...st.xAxisSettings, ...options.xAxisSettings };
}
if (options && options.yAxisSettings && typeof options.yAxisSettings === 'object') {
st.yAxisSettings = { ...getDefaultYAxisSettings(), ...st.yAxisSettings, ...options.yAxisSettings };
}

const container = document.getElementById('queries-container');
if (!container) return;

// ── Create Lit element as primary ──
const litEl = document.createElement('kw-chart-section');
litEl.id = id;
litEl.setAttribute('box-id', id);
if (options && typeof options.editorHeightPx === 'number') {
litEl.setAttribute('editor-height-px', String(options.editorHeightPx));
}

// Create light-DOM wrapper + canvas elements for ECharts (cannot render in shadow DOM).
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
resizerEl.className = 'query-editor-resizer';
resizerEl.title = 'Drag to resize\nDouble-click to fit to contents';
chartWrapper.appendChild(resizerEl);

litEl.appendChild(chartWrapper);

// Apply resolved state to the Lit element (st has defaults applied)
if (typeof litEl.applyOptions === 'function') {
litEl.applyOptions(st);
}

// Listen for section-remove event
litEl.addEventListener('section-remove', (e: any) => {
try {
const detail = e && e.detail ? e.detail : {};
const removeId = detail.boxId || id;
removeChartBox(removeId);
} catch (e) { console.error('[kusto]', e); }
});

container.insertAdjacentElement('beforeend', litEl);

// Set up drag-resize on the light-DOM resizer
try {
if (chartWrapper && resizerEl) {
resizerEl.addEventListener('dblclick', () => {
try { maximizeChartBox(id); } catch (e) { console.error('[kusto]', e); }
});
resizerEl.addEventListener('mousedown', (e: any) => {
try { e.preventDefault(); e.stopPropagation(); } catch (e) { console.error('[kusto]', e); }
try { chartWrapper.dataset.kustoUserResized = 'true'; } catch (e) { console.error('[kusto]', e); }
resizerEl.classList.add('is-dragging');
const prevCursor = document.body.style.cursor;
const prevUserSelect = document.body.style.userSelect;
document.body.style.cursor = 'ns-resize';
document.body.style.userSelect = 'none';
const startPageY = e.clientY + getScrollY();
const startHeight = chartWrapper.getBoundingClientRect().height;
try { chartWrapper.style.height = Math.max(0, Math.ceil(startHeight)) + 'px'; } catch (e) { console.error('[kusto]', e); }
const minH = getChartMinResizeHeight(id);
const maxH = 900;
const onMove = (moveEvent: any) => {
try {
maybeAutoScrollWhileDragging(moveEvent.clientY);
} catch (e) { console.error('[kusto]', e); }
const pageY = moveEvent.clientY + getScrollY();
const delta = pageY - startPageY;
const currentMinH = getChartMinResizeHeight(id);
const nextHeight = Math.max(currentMinH, Math.min(maxH, startHeight + delta));
chartWrapper.style.height = nextHeight + 'px';
try { renderChart(id); } catch (e) { console.error('[kusto]', e); }
};
const onUp = () => {
document.removeEventListener('mousemove', onMove, true);
document.removeEventListener('mouseup', onUp, true);
resizerEl.classList.remove('is-dragging');
document.body.style.cursor = prevCursor;
document.body.style.userSelect = prevUserSelect;
try { schedulePersist(); } catch (e) { console.error('[kusto]', e); }
try { renderChart(id); } catch (e) { console.error('[kusto]', e); }
};
document.addEventListener('mousemove', onMove, true);
document.addEventListener('mouseup', onUp, true);
});
}
} catch (e) { console.error('[kusto]', e); }

try { schedulePersist(); } catch (e) { console.error('[kusto]', e); }
try {
const controls = document.querySelector('.add-controls');
if (controls && typeof controls.scrollIntoView === 'function') {
controls.scrollIntoView({ block: 'end' });
}
} catch (e) { console.error('[kusto]', e); }
return id;
}

export function removeChartBox( boxId: any) {
try { disposeChartEcharts(boxId); } catch (e) { console.error('[kusto]', e); }
try { delete chartStateByBoxId[boxId]; } catch (e) { console.error('[kusto]', e); }
try { __kustoCleanupSectionModeResizeObserver(boxId); } catch (e) { console.error('[kusto]', e); }
chartBoxes = (chartBoxes || []).filter((id: any) => id !== boxId);
const box = document.getElementById(boxId) as any;
if (box && box.parentNode) {
box.parentNode.removeChild(box);
}
try { schedulePersist(); } catch (e) { console.error('[kusto]', e); }
}

// ── Window bridges ──────────────────────────────────────────────────────────
window.addChartBox = addChartBox;
window.removeChartBox = removeChartBox;
