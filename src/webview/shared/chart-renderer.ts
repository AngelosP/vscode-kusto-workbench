// ECharts rendering engine — extracted from modules/extraBoxes-chart.ts.
// Handles chart rendering, disposal, theme observation, resizing.
// No window bridge assignments — pure ES module exports.
import { schedulePersist } from '../core/persistence';
import { isDarkTheme } from '../monaco/theme';
import { escapeHtml } from '../core/utils';
import { getResultsState } from '../core/results-state';
import { ensureEchartsLoaded } from './lazy-vendor.js';
import {
	handleTooltipFormatter,
	handleTooltipPosition,
	scheduleHideTooltip,
	dismissHoverTooltip,
} from './chart-pinned-tooltip.js';
import {
	getRawCellValue,
	cellToChartString,
	inferTimeXAxisFromRows,
	normalizeResultsColumnName,
} from './data-utils.js';
import { tryParseFiniteNumber, tryParseDate } from './transform-expr.js';
import {
	formatNumber,
	computeAxisFontSize,
	normalizeLegendPosition,
	normalizeStackMode,
	getDefaultXAxisSettings,
	getDefaultYAxisSettings,
	formatUtcDateTime,
	computeTimePeriodGranularity,
	formatTimePeriodLabel,
	generateContinuousTimeLabels,
	shouldShowTimeForUtcAxis,
	computeTimeAxisLabelRotation,
	computeCategoryLabelRotation,
	measureLabelChars,
} from './chart-utils.js';

// ── State ─────────────────────────────────────────────────────────────────────

// Access shared chart state from window (set by extraBoxes-chart.ts factory).
// Initialize on window if not already present, so load order doesn't matter.
window.chartStateByBoxId = window.chartStateByBoxId || {};
let chartStateByBoxId = window.chartStateByBoxId;
window.__kustoChartBoxes = window.__kustoChartBoxes || [];
let chartBoxes: any[] = window.__kustoChartBoxes;

export function getChartState(boxId: any) {
	try {
		const id = String(boxId || '');
		if (!id) return { mode: 'edit', expanded: true };
		if (!chartStateByBoxId || typeof chartStateByBoxId !== 'object') {
			chartStateByBoxId = {};
		}
		if (!chartStateByBoxId[id] || typeof chartStateByBoxId[id] !== 'object') {
			chartStateByBoxId[id] = { mode: 'edit', expanded: true, legendPosition: 'top' };
		}
		// Back-compat: older state objects may be missing newer fields.
		try {
			if (typeof chartStateByBoxId[id].legendPosition !== 'string' || !chartStateByBoxId[id].legendPosition) {
				chartStateByBoxId[id].legendPosition = 'top';
			}
		} catch (e) { console.error('[kusto]', e); }
		try {
			if (typeof chartStateByBoxId[id].stackMode !== 'string' || !chartStateByBoxId[id].stackMode) {
				chartStateByBoxId[id].stackMode = 'normal';
			}
		} catch (e) { console.error('[kusto]', e); }
		// Ensure xAxisSettings exists with defaults
		try {
			if (!chartStateByBoxId[id].xAxisSettings || typeof chartStateByBoxId[id].xAxisSettings !== 'object') {
				chartStateByBoxId[id].xAxisSettings = getDefaultXAxisSettings();
			}
		} catch (e) { console.error('[kusto]', e); }
		// Ensure yAxisSettings exists with defaults
		try {
			if (!chartStateByBoxId[id].yAxisSettings || typeof chartStateByBoxId[id].yAxisSettings !== 'object') {
				chartStateByBoxId[id].yAxisSettings = getDefaultYAxisSettings();
			}
		} catch (e) { console.error('[kusto]', e); }
		return chartStateByBoxId[id];
	} catch {
		return { mode: 'edit', expanded: true };
	}
}

// ── Data cell helpers ─────────────────────────────────────────────────────────
// These reproduce the extraBoxes.ts wrappers, using the same underlying parsers.

function cellValueForChart(cell: any) {
	return getRawCellValue(cell);
}

function cellToNumber(cell: any): number | null {
	try {
		const raw = cellValueForChart(cell);
		return tryParseFiniteNumber(raw);
	} catch {
		return null;
	}
}

function cellToTimeMs(cell: any): number | null {
	try {
		const raw = cellValueForChart(cell);
		const d = tryParseDate(raw);
		return d ? d.getTime() : null;
	} catch {
		return null;
	}
}

// ── Utility helpers ───────────────────────────────────────────────────────────

export const legendPositionIcons = {
	top:
		'<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">' +
		'<rect x="3" y="5" width="10" height="8" rx="1" />' +
		'<path d="M3 3h10" />' +
		'</svg>',
	bottom:
		'<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">' +
		'<rect x="3" y="3" width="10" height="8" rx="1" />' +
		'<path d="M3 13h10" />' +
		'</svg>',
	left:
		'<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">' +
		'<rect x="5" y="3" width="8" height="10" rx="1" />' +
		'<path d="M3 3v10" />' +
		'</svg>',
	right:
		'<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">' +
		'<rect x="3" y="3" width="8" height="10" rx="1" />' +
		'<path d="M13 3v10" />' +
		'</svg>'
};

export function updateLegendPositionButtonUI(boxId: any) {
	try {
		const id = String(boxId || '');
		if (!id) return;
		const st = getChartState(id);
		const chartType = (st && typeof st.chartType === 'string') ? String(st.chartType) : '';
		const btn = document.getElementById(id + '_chart_legend_pos_btn') as any;
		const legendWrapper = document.getElementById(id + '_chart_legend_wrapper') as any;
		if (!btn) return;

		const isValidChartType = (chartType === 'line' || chartType === 'area' || chartType === 'bar');
		const hasLegendColumn = (st && typeof st.legendColumn === 'string' && st.legendColumn !== '');
		const show = isValidChartType && hasLegendColumn;
		btn.style.display = show ? '' : 'none';
		if (legendWrapper) {
			legendWrapper.style.flex = show ? '1 1 auto' : '1 1 100%';
		}
		if (!show) return;

		const pos = normalizeLegendPosition(st && st.legendPosition);
		try { st.legendPosition = pos; } catch (e) { console.error('[kusto]', e); }
		btn.innerHTML = (legendPositionIcons as any)[pos] || legendPositionIcons.top;
		const title = 'Legend position: ' + (pos.charAt(0).toUpperCase() + pos.slice(1));
		btn.title = title;
		btn.setAttribute('aria-label', title);
	} catch (e) { console.error('[kusto]', e); }
}

export function getChartActiveCanvasElementId(boxId: any) {
	const st = getChartState(boxId);
	const mode = st && st.mode ? String(st.mode) : 'edit';
	return (mode === 'preview') ? (boxId + '_chart_canvas_preview') : (boxId + '_chart_canvas_edit');
}

function getIsDarkThemeForEcharts() {
	try {
		return isDarkTheme();
	} catch (e) { console.error('[kusto]', e); }
	return true;
}

export function getChartMinResizeHeight(boxId: any) {
	const CHART_CANVAS_RENDERING_MIN_HEIGHT = 140;
	const CHART_CANVAS_PLACEHOLDER_MIN_HEIGHT = 60;
	const CONTROLS_MARGIN_BOTTOM = 20;
	const FALLBACK_MIN = 80;
	try {
		const id = String(boxId || '');
		if (!id) return FALLBACK_MIN;
		const st = getChartState(id);
		const isEditMode = st.mode === 'edit';
		const isChartRendering = st.__wasRendering || false;
		const canvasMinH = isChartRendering ? CHART_CANVAS_RENDERING_MIN_HEIGHT : CHART_CANVAS_PLACEHOLDER_MIN_HEIGHT;
		if (!isEditMode) {
			return canvasMinH;
		}
		const editContainer = document.getElementById(id + '_chart_edit') as any;
		const controlsEl = editContainer ? editContainer.querySelector('.kusto-chart-controls') : null;
		const controlsH = controlsEl && controlsEl.getBoundingClientRect
			? Math.ceil(controlsEl.getBoundingClientRect().height || 0)
			: 0;
		return Math.max(FALLBACK_MIN, controlsH + CONTROLS_MARGIN_BOTTOM + canvasMinH);
	} catch {
		return FALLBACK_MIN;
	}
}

// ── Theme observer ────────────────────────────────────────────────────────────

let __echartsThemeObserverStarted = false;
let __lastAppliedEchartsIsDarkTheme: any = null;

export function refreshChartsForThemeChange() {
	let dark = true;
	try { dark = getIsDarkThemeForEcharts(); } catch { dark = true; }
	if (__lastAppliedEchartsIsDarkTheme === dark) return;
	__lastAppliedEchartsIsDarkTheme = dark;
	try {
		for (const id of (chartBoxes || [])) {
			try { disposeChartEcharts(id); } catch (e) { console.error('[kusto]', e); }
			try { renderChart(id); } catch (e) { console.error('[kusto]', e); }
			try { updateLegendPositionButtonUI(id); } catch (e) { console.error('[kusto]', e); }
		}
	} catch (e) { console.error('[kusto]', e); }
}

export function startEchartsThemeObserver() {
	if (__echartsThemeObserverStarted) return;
	__echartsThemeObserverStarted = true;
	try { refreshChartsForThemeChange(); } catch (e) { console.error('[kusto]', e); }

	let pending = false;
	const schedule = () => {
		if (pending) return;
		pending = true;
		setTimeout(() => {
			pending = false;
			try { refreshChartsForThemeChange(); } catch (e) { console.error('[kusto]', e); }
		}, 0);
	};

	try {
		const observer = new MutationObserver(() => schedule());
		if (document && document.body) {
			observer.observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });
		}
		if (document && document.documentElement) {
			observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] });
		}
	} catch (e) { console.error('[kusto]', e); }
}

// ── Dispose ───────────────────────────────────────────────────────────────────

export function disposeChartEcharts(boxId: any) {
	try {
		const st = getChartState(boxId);
		if (st && st.__echarts && st.__echarts.instance) {
			try { st.__echarts.instance.dispose(); } catch (e) { console.error('[kusto]', e); }
		}
		if (st) {
			try {
				if (st.__resizeObserver && typeof st.__resizeObserver.disconnect === 'function') {
					st.__resizeObserver.disconnect();
				}
			} catch (e) { console.error('[kusto]', e); }
			try { delete st.__lastTimeAxis; } catch (e) { console.error('[kusto]', e); }
			try { delete st.__echarts; } catch (e) { console.error('[kusto]', e); }
			try { delete st.__resizeObserver; } catch (e) { console.error('[kusto]', e); }
			try { delete st.__axisTitleClickHandler; } catch (e) { console.error('[kusto]', e); }
			try { delete st.__hoverTooltipGlobalout; } catch (e) { console.error('[kusto]', e); }
		}
		try { dismissHoverTooltip(String(boxId)); } catch (e) { console.error('[kusto]', e); }
	} catch (e) { console.error('[kusto]', e); }
}

// ── Render ─────────────────────────────────────────────────────────────────────

// Per-box mouse-hover tracking.  When the mouse is over a chart canvas we must
// NOT call setOption — ECharts processes mousemove synchronously and replacing
// the internal data mid-event causes "Cannot read properties of undefined
// (reading 'getRawIndex')" crashes.  Instead we defer the render until the
// mouse leaves the canvas.
const _chartMouseOverBoxes: Set<string> = new Set();
const _chartDeferredRenders: Set<string> = new Set();

function _installChartMouseGuard(boxId: string, canvas: HTMLElement) {
	const key = '__kustoMouseGuard';
	if ((canvas as any)[key]) return;
	(canvas as any)[key] = true;
	canvas.addEventListener('mouseenter', () => { _chartMouseOverBoxes.add(boxId); }, { passive: true });
	canvas.addEventListener('mouseleave', () => {
		_chartMouseOverBoxes.delete(boxId);
		if (_chartDeferredRenders.has(boxId)) {
			_chartDeferredRenders.delete(boxId);
			try { renderChart(boxId); } catch (e) { console.error('[kusto]', e); }
		}
	}, { passive: true });
}

export function renderChart(boxId: any) {
	const id = String(boxId || '');
	if (!id) return;

	// Defer if the mouse is currently over this chart canvas to avoid
	// ECharts internal crash from data replacement during mousemove.
	if (_chartMouseOverBoxes.has(id)) {
		_chartDeferredRenders.add(id);
		return;
	}

	try { startEchartsThemeObserver(); } catch (e) { console.error('[kusto]', e); }
	const st = getChartState(id);

	// Track previous rendering state to detect transitions
	const wasRendering = st.__wasRendering || false;

	// Defensive: ensure dataSourceId is synced from the DOM dropdown in case state became stale.
	try {
		const dsEl = document.getElementById(id + '_chart_ds') as any;
		if (dsEl && dsEl.value) {
			st.dataSourceId = String(dsEl.value || '');
		}
	} catch (e) { console.error('[kusto]', e); }

	try {
		const wrapper = document.getElementById(id + '_chart_wrapper') as any;
		if (wrapper && wrapper.style && String(wrapper.style.display || '').toLowerCase() === 'none') {
			return;
		}
	} catch (e) { console.error('[kusto]', e); }
	const canvasId = getChartActiveCanvasElementId(id);
	const canvas = document.getElementById(canvasId) as any;
	if (!canvas) return;

	// If ECharts isn't loaded yet, show a placeholder and trigger lazy load.
	if (!window.echarts || typeof window.echarts.init !== 'function') {
		try { canvas.textContent = 'Loading chart…'; } catch (e) { console.error('[kusto]', e); }
		ensureEchartsLoaded().then(() => {
			for (const cid of (chartBoxes || [])) {
				try { renderChart(cid); } catch (e) { console.error('[kusto]', e); }
			}
		}).catch((e) => { console.error('[kusto] ECharts lazy load failed:', e); });
		return;
	}

	// Find dataset.
	let dsState = null;
	try {
		if (typeof st.dataSourceId === 'string' && st.dataSourceId) {
			dsState = getResultsState(st.dataSourceId);
		}
	} catch (e) { console.error('[kusto]', e); }
	const cols = dsState && Array.isArray(dsState.columns) ? dsState.columns : [];
	const rawRows = dsState && Array.isArray(dsState.rows) ? dsState.rows : [];
	const colNames = cols.map(normalizeResultsColumnName);
	const indexOf = (name: any) => {
		const n = String(name || '');
		if (!n) return -1;
		return colNames.findIndex((cn: any) => String(cn) === n);
	};

	// Apply sorting if configured
	const sortColumn = (typeof st.sortColumn === 'string') ? st.sortColumn : '';
	const sortDirection = (typeof st.sortDirection === 'string') ? st.sortDirection : '';
	const sortColIndex = sortColumn ? indexOf(sortColumn) : -1;
	let rows = rawRows;
	if (sortColIndex >= 0 && (sortDirection === 'asc' || sortDirection === 'desc')) {
		try {
			rows = [...rawRows].sort((a: any, b: any) => {
				const aVal = (a && a.length > sortColIndex) ? cellValueForChart(a[sortColIndex]) : null;
				const bVal = (b && b.length > sortColIndex) ? cellValueForChart(b[sortColIndex]) : null;
				if (aVal === null && bVal === null) return 0;
				if (aVal === null) return 1;
				if (bVal === null) return -1;
				const aNum = typeof aVal === 'number' ? aVal : (typeof aVal === 'string' ? parseFloat(aVal) : NaN);
				const bNum = typeof bVal === 'number' ? bVal : (typeof bVal === 'string' ? parseFloat(bVal) : NaN);
				if (!isNaN(aNum) && !isNaN(bNum)) {
					return sortDirection === 'asc' ? (aNum - bNum) : (bNum - aNum);
				}
				const aStr = String(aVal ?? '');
				const bStr = String(bVal ?? '');
				const cmp = aStr.localeCompare(bStr);
				return sortDirection === 'asc' ? cmp : -cmp;
			});
		} catch (e) { console.error('[kusto]', e); }
	}

	// Apply X-axis sorting if configured (and no other sort is active)
	const xAxisSettings = st.xAxisSettings || getDefaultXAxisSettings();
	const yAxisSettings = st.yAxisSettings || getDefaultYAxisSettings();
	const xAxisSortDir = xAxisSettings.sortDirection || '';

	// Helper to sort rows by a specific column
	const sortRowsByColumn = (rowsToSort: any, colIndex: any, direction: any) => {
		if (colIndex < 0 || !direction) return rowsToSort;
		try {
			return [...rowsToSort].sort((a: any, b: any) => {
				const aVal = (a && a.length > colIndex) ? cellValueForChart(a[colIndex]) : null;
				const bVal = (b && b.length > colIndex) ? cellValueForChart(b[colIndex]) : null;
				if (aVal === null && bVal === null) return 0;
				if (aVal === null) return 1;
				if (bVal === null) return -1;
				const aTime = cellToTimeMs(aVal);
				const bTime = cellToTimeMs(bVal);
				if (typeof aTime === 'number' && typeof bTime === 'number' && Number.isFinite(aTime) && Number.isFinite(bTime)) {
					return direction === 'asc' ? (aTime - bTime) : (bTime - aTime);
				}
				const aNum = typeof aVal === 'number' ? aVal : (typeof aVal === 'string' ? parseFloat(aVal) : NaN);
				const bNum = typeof bVal === 'number' ? bVal : (typeof bVal === 'string' ? parseFloat(bVal) : NaN);
				if (!isNaN(aNum) && !isNaN(bNum)) {
					return direction === 'asc' ? (aNum - bNum) : (bNum - aNum);
				}
				const aStr = String(aVal ?? '');
				const bStr = String(bVal ?? '');
				const cmp = aStr.localeCompare(bStr);
				return direction === 'asc' ? cmp : -cmp;
			});
		} catch {
			return rowsToSort;
		}
	};

	// Helper to dispose ECharts instance before showing error text.
	const showErrorAndReturn = (msg: any) => {
		try {
			if (st.__echarts && st.__echarts.instance) {
				st.__echarts.instance.dispose();
				delete st.__echarts;
			}
		} catch (e) { console.error('[kusto]', e); }
		try {
			canvas.innerHTML = '<div class="error-message" style="white-space:pre-wrap">' + escapeHtml(String(msg || '')) + '</div>';
		} catch (e) { console.error('[kusto]', e); }
		try { canvas.style.minHeight = '60px'; } catch (e) { console.error('[kusto]', e); }
		const isNowRendering = false;
		st.__wasRendering = isNowRendering;
		if (wasRendering !== isNowRendering) {
			try { maximizeChartBox(id); } catch (e) { console.error('[kusto]', e); }
		}
	};

	const chartType = (typeof st.chartType === 'string') ? String(st.chartType) : '';
	if (!st.dataSourceId) {
		showErrorAndReturn('Select a data source (a query, CSV URL, or transformation section with results).');
		return;
	}
	if (!chartType) {
		showErrorAndReturn('Select a chart type.');
		return;
	}
	if (!cols.length) {
		showErrorAndReturn('No data available yet.');
		return;
	}

	// Ensure we have an instance bound to the active element.
	// Guard: defer init if the canvas hasn't been laid out yet (zero dimensions)
	// to avoid the ECharts "Can't get DOM width or height" warning.
	try { canvas.style.minHeight = '140px'; } catch (e) { console.error('[kusto]', e); }
	if (!canvas.clientWidth || !canvas.clientHeight) {
		requestAnimationFrame(() => { try { renderChart(id); } catch (e) { console.error('[kusto]', e); } });
		return;
	}
	try {
		const isDark = getIsDarkThemeForEcharts();
		const themeName = isDark ? 'dark' : undefined;
		const prev = st.__echarts && st.__echarts.instance ? st.__echarts : null;
		if (!prev || prev.canvasId !== canvasId || prev.isDark !== isDark) {
			try { if (prev && prev.instance) prev.instance.dispose(); } catch (e) { console.error('[kusto]', e); }
			st.__echarts = { instance: window.echarts.init(canvas, themeName), canvasId, isDark };
			try {
				if (st.__resizeObserver && typeof st.__resizeObserver.disconnect === 'function') {
					st.__resizeObserver.disconnect();
				}
			} catch (e) { console.error('[kusto]', e); }
			try { delete st.__resizeObserver; } catch (e) { console.error('[kusto]', e); }
		}
	} catch (e) { console.error('[kusto]', e); }

	const inst = st.__echarts && st.__echarts.instance ? st.__echarts.instance : null;
	if (!inst) return;

	// Forward X/Y axis click interactions from the rendered chart back to the
	// owning chart section so it can open the corresponding axis settings popup.
	try {
		if (st.__axisTitleClickHandler) {
			try { inst.off('click', st.__axisTitleClickHandler); } catch (e) { console.error('[kusto]', e); }
		}
		st.__axisTitleClickHandler = (params: any) => {
			try {
				const componentType = params && params.componentType ? String(params.componentType) : '';
				const axis = componentType === 'xAxis' ? 'x' : (componentType === 'yAxis' ? 'y' : '');
				if (!axis) return;

				const nativeEvent = params && params.event && params.event.event ? params.event.event : null;
				const clientX = nativeEvent && typeof nativeEvent.clientX === 'number' ? nativeEvent.clientX : 0;
				const clientY = nativeEvent && typeof nativeEvent.clientY === 'number' ? nativeEvent.clientY : 0;

				const host = document.getElementById(id);
				if (!host) return;
				host.dispatchEvent(new CustomEvent('kusto-axis-title-click', {
					detail: { axis, clientX, clientY },
				}));
			} catch (e) { console.error('[kusto]', e); }
		};
		inst.on('click', st.__axisTitleClickHandler);
	} catch (e) { console.error('[kusto]', e); }

	// Hover tooltip dismiss — hide the custom tooltip when the mouse leaves the chart.
	try {
		if (st.__hoverTooltipGlobalout) {
			try { inst.off('globalout', st.__hoverTooltipGlobalout); } catch (e) { console.error('[kusto]', e); }
		}
		const currentChartType = (typeof st.chartType === 'string') ? st.chartType : '';
		if (currentChartType === 'line' || currentChartType === 'area' || currentChartType === 'bar') {
			st.__hoverTooltipGlobalout = () => {
				try { scheduleHideTooltip(id); } catch (e) { console.error('[kusto]', e); }
			};
			inst.on('globalout', st.__hoverTooltipGlobalout);
		}
	} catch (e) { console.error('[kusto]', e); }

	let canvasWidthPx = 0;
	try {
		const r = canvas.getBoundingClientRect();
		canvasWidthPx = r && typeof r.width === 'number' ? r.width : 0;
	} catch (e) { console.error('[kusto]', e); }
	if (!canvasWidthPx) {
		try { canvasWidthPx = canvas && typeof canvas.clientWidth === 'number' ? canvas.clientWidth : 0; } catch (e) { console.error('[kusto]', e); }
	}

	let option = null;
	try {
		const tooltipCss = 'max-width:520px; max-height:320px; overflow:auto; padding:8px 12px; line-height:1.6; font-size:12px; border-radius:4px;';
		// Item tooltips (pie, funnel, scatter): enterable so user can select text.
		const tooltipCommon = {
			confine: true,
			enterable: true,
			hideDelay: 200,
			transitionDuration: 0,
			extraCssText: tooltipCss + ' pointer-events:auto;'
		};
		// Axis tooltips (line, area, bar): NOT enterable — the tooltip follows the
		// crosshair, so "entering" it just causes jitter as the axis position shifts.
		// NOTE: Do NOT use showDelay here — it creates an internal setTimeout that
		// survives past setOption({ notMerge: true }) and crashes when the timer
		// fires after the tooltip DOM has been destroyed.
		const tooltipAxis = {
			confine: true,
			enterable: false,
			hideDelay: 120,
			transitionDuration: 0.15,
			extraCssText: tooltipCss
		};

		const escHtml = (v: any) => {
			try {
				return escapeHtml(String(v ?? ''));
			} catch (e) { console.error('[kusto]', e); }
			try {
				return String(v ?? '')
					.replace(/&/g, '&amp;')
					.replace(/</g, '&lt;')
					.replace(/>/g, '&gt;')
					.replace(/\"/g, '&quot;')
					.replace(/'/g, '&#39;');
			} catch {
				return '';
			}
		};

		const tooltipColNames = (() => {
			try {
				const desired = Array.isArray(st.tooltipColumns) ? st.tooltipColumns : [];
				const normalized = desired.map((c: any) => String(c || '')).filter(Boolean);
				const available = new Set(colNames);
				return normalized.filter((c: any) => available.has(c));
			} catch {
				return [];
			}
		})();

		// Format ISO 8601 date-time strings the same way the data table does:
		// "2026-03-22T14:30:00.000Z" → "2026-03-22 14:30:00"
		const fmtDateForTooltip = (s: string): string | null => {
			if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(s)) {
				if (!Number.isFinite(Date.parse(s))) return null;
				return s.replace('T', ' ').replace(/\.\d+Z?$/, '').replace(/Z$/, '');
			}
			if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) return s;
			return null;
		};

		const getTooltipPayloadForRow = (row: any) => {
			try {
				if (!tooltipColNames.length) return null;
				const out: any = {};
				for (const colName of tooltipColNames) {
					const ci = indexOf(colName);
					if (ci < 0) continue;
					const cell = (row && row.length > ci) ? row[ci] : null;
					const raw = cellValueForChart(cell);
					if (raw === null || raw === undefined) {
						out[colName] = '';
						continue;
					}
					if (typeof raw === 'number' && Number.isFinite(raw)) {
						out[colName] = formatNumber(raw);
						continue;
					}
					const str = cellToChartString(cell);
					const dateFmt = fmtDateForTooltip(str);
					out[colName] = dateFmt !== null ? dateFmt : str;
				}
				return out;
			} catch {
				return null;
			}
		};

		const appendTooltipColumnsHtmlLines = (lines: any, payload: any, _indentPx: any) => {
			try {
				if (!payload || !tooltipColNames.length) return;
				lines.push('<div style="border-top:1px solid rgba(128,128,128,0.25); margin:4px 0 2px; padding-top:4px">');
				for (const colName of tooltipColNames) {
					const rawVal = payload && Object.prototype.hasOwnProperty.call(payload, colName) ? payload[colName] : '';
					const s = String(rawVal ?? '');
					if (!s) continue;
					lines.push(
						`<div style="display:block; opacity:0.85; font-size:11px; padding:1px 0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis">` +
						`<span style="opacity:0.6">${escHtml(colName)}:</span> ${escHtml(s)}</div>`
					);
				}
				lines.push('</div>');
			} catch (e) { console.error('[kusto]', e); }
		};

		const legendPosition = normalizeLegendPosition(st && st.legendPosition);
		const SIDE_LEGEND_TEXT_WIDTH = 120;
		const SIDE_LEGEND_TOTAL = SIDE_LEGEND_TEXT_WIDTH + 30;   // text + icon + padding
		const SIDE_LEGEND_GAP = 15;                              // breathing room before axis title
		const buildLegendOption = (pos: any) => {
			const p = normalizeLegendPosition(pos);
			if (p === 'bottom') return { type: 'scroll', bottom: 0, left: 'center', orient: 'horizontal' };
			if (p === 'left') return { type: 'scroll', left: 0, top: 20, orient: 'vertical', textStyle: { width: SIDE_LEGEND_TEXT_WIDTH, overflow: 'truncate' } };
			if (p === 'right') return { type: 'scroll', right: 0, top: 20, orient: 'vertical', textStyle: { width: SIDE_LEGEND_TEXT_WIDTH, overflow: 'truncate' } };
			return { type: 'scroll', top: 0, left: 'center', orient: 'horizontal' };
		};

		if (chartType === 'pie') {
			const li = indexOf(st.labelColumn);
			const vi = indexOf(st.valueColumn);
			const valueColName = st.valueColumn || 'Value';
			if (li < 0 || vi < 0) {
				showErrorAndReturn('Select columns.');
				return;
			} else {
				const data = (rows || []).map((r: any) => {
					const label = (r && r.length > li) ? cellToChartString(r[li]) : '';
					const value = (r && r.length > vi) ? cellToNumber(r[vi]) : null;
					const tooltipPayload = getTooltipPayloadForRow(r);
					return { name: label, value: (typeof value === 'number' && Number.isFinite(value)) ? value : 0, __kustoTooltip: tooltipPayload };
				});

				const labelMode = st.labelMode || 'auto';
				const labelDensity = typeof st.labelDensity === 'number' ? st.labelDensity : 50;
				const showLabels = !!st.showDataLabels;
				const sliceCount = data.length;
				const totalValue = data.reduce((sum: any, d: any) => sum + (d.value || 0), 0);

				const slicesWithPercent = data.map((d: any, i: any) => ({
					index: i,
					percent: totalValue > 0 ? (d.value / totalValue) * 100 : 0,
					value: d.value,
					name: d.name
				}));

				const sortedByPercent = [...slicesWithPercent].sort((a: any, b: any) => b.percent - a.percent);
				const labelEligibleIndices = new Set();

				if (labelMode === 'all') {
					slicesWithPercent.forEach((s: any) => labelEligibleIndices.add(s.index));
				} else if (labelMode === 'top5') {
					sortedByPercent.slice(0, 5).forEach((s: any) => labelEligibleIndices.add(s.index));
				} else if (labelMode === 'top10') {
					sortedByPercent.slice(0, 10).forEach((s: any) => labelEligibleIndices.add(s.index));
				} else if (labelMode === 'topPercent') {
					slicesWithPercent.filter((s: any) => s.percent >= 5).forEach((s: any) => labelEligibleIndices.add(s.index));
				} else {
					let baseMinPercent = 0;
					if (sliceCount <= 4) {
						baseMinPercent = 0;
					} else if (sliceCount <= 8) {
						baseMinPercent = 1;
					} else if (sliceCount <= 15) {
						baseMinPercent = 2;
					} else if (sliceCount <= 30) {
						baseMinPercent = 4;
					} else {
						baseMinPercent = 6;
					}
					const densityFactor = (100 - labelDensity) / 50;
					const minPercent = baseMinPercent * densityFactor;
					slicesWithPercent.filter((s: any) => s.percent >= minPercent).forEach((s: any) => labelEligibleIndices.add(s.index));
				}

				data.forEach((d: any, idx: any) => {
					if (!labelEligibleIndices.has(idx)) {
						d.label = { show: false };
						d.labelLine = { show: false };
					}
				});

				let pieRadius = '48%';
				let fontSize = 11;
				if (sliceCount > 20) {
					pieRadius = '38%';
					fontSize = 10;
				} else if (sliceCount > 10) {
					pieRadius = '42%';
					fontSize = 10;
				} else if (sliceCount > 6) {
					pieRadius = '45%';
				}

				const maxLabelLength = sliceCount > 15 ? 18 : (sliceCount > 8 ? 25 : 35);
				const truncateName = (name: any, maxLen: any) => {
					if (!name || name.length <= maxLen) return name;
					return name.substring(0, maxLen - 1) + '…';
				};

				const labelConfig = {
					show: showLabels,
					position: 'outside',
					fontFamily: 'monospace',
					fontSize: fontSize,
					formatter: (params: any) => {
						try {
							const percent = params && typeof params.percent === 'number' ? params.percent : 0;
							const name = params && params.name ? String(params.name) : '';
							const value = params && typeof params.value === 'number' ? formatNumber(params.value) : '';
							const pctStr = percent.toFixed(1) + '%';
							const displayName = truncateName(name, maxLabelLength);
							if (percent >= 5) {
								return displayName + '\n' + value + ' (' + pctStr + ')';
							}
							return displayName + ' (' + pctStr + ')';
						} catch {
							return '';
						}
					}
				};

				const labelLineConfig = {
					show: showLabels,
					length: 15,
					length2: 20,
					smooth: 0.2,
					minTurnAngle: 90
				};

				const placedLabels: any[] = [];
				const LABEL_PADDING = 4;
				const SHIFT_STEP = 2;
				const MAX_VERTICAL_SHIFT = 80;

				const labelLayoutFn = (params: any) => {
					try {
						const idx = params.dataIndex;
						const rect = params.labelRect;
						if (!rect || rect.width === 0) {
							return {};
						}
						const width = rect.width;
						const height = rect.height;
						const labelLinePoints = params.labelLinePoints;
						const pieCenter = labelLinePoints?.[0] || [0, 0];
						const labelEnd = labelLinePoints?.[2] || [rect.x, rect.y];
						const isRightSide = labelEnd[0] > pieCenter[0];
						let x = rect.x;
						let y = rect.y;

						const checkOverlap = (testX: any, testY: any) => {
							for (const placed of placedLabels) {
								const overlapX = testX < placed.x + placed.width + LABEL_PADDING &&
								                 testX + width + LABEL_PADDING > placed.x;
								const overlapY = testY < placed.y + placed.height + LABEL_PADDING &&
								                 testY + height + LABEL_PADDING > placed.y;
								if (overlapX && overlapY) {
									return placed;
								}
							}
							return null;
						};

						let overlappingLabel = checkOverlap(x, y);
						if (overlappingLabel) {
							const overlapCenterY = overlappingLabel.y + overlappingLabel.height / 2;
							const myPreferredDirection = y < overlapCenterY ? -1 : 1;
							let bestY = y;
							let foundClear = false;
							for (let shift = SHIFT_STEP; shift <= MAX_VERTICAL_SHIFT; shift += SHIFT_STEP) {
								const testY = y + (shift * myPreferredDirection);
								if (!checkOverlap(x, testY)) {
									bestY = testY;
									foundClear = true;
									break;
								}
							}
							if (!foundClear) {
								for (let shift = SHIFT_STEP; shift <= MAX_VERTICAL_SHIFT; shift += SHIFT_STEP) {
									const testY = y + (shift * -myPreferredDirection);
									if (!checkOverlap(x, testY)) {
										bestY = testY;
										foundClear = true;
										break;
									}
								}
							}
							y = bestY;
						}
						placedLabels.push({ x, y, width, height, dataIndex: idx, isRightSide });
						return { x, y };
					} catch {
						return {};
					}
				};

				option = {
					backgroundColor: 'transparent',
					tooltip: {
						...tooltipCommon,
						trigger: 'item',
						formatter: (params: any) => {
							try {
								const name = params && params.name ? params.name : '';
								const value = params && typeof params.value === 'number' ? formatNumber(params.value) : '';
								const percent = params && typeof params.percent === 'number' ? params.percent.toFixed(1) : '';
								const marker = params && params.marker ? params.marker : '';
								const lines = [
									`<div style="font-weight:600; margin-bottom:2px">${escHtml(name)}</div>`,
									`<div>${marker}<strong>${escHtml(valueColName)}</strong>: ${escHtml(value)} <span style="opacity:0.7">(${escHtml(percent)}%)</span></div>`
								];
								const payload = params && params.data && params.data.__kustoTooltip ? params.data.__kustoTooltip : null;
								appendTooltipColumnsHtmlLines(lines, payload, 0);
								return lines.join('');
							} catch {
								return '';
							}
						}
					},
					legend: buildLegendOption(legendPosition),
					series: [{
						type: 'pie',
						radius: pieRadius,
						center: ['50%', '50%'],
						avoidLabelOverlap: true,
						data,
						label: labelConfig,
						labelLine: labelLineConfig,
						labelLayout: labelLayoutFn
					}]
				};
			}
		} else if (chartType === 'funnel') {
			const li = indexOf(st.labelColumn);
			const vi = indexOf(st.valueColumn);
			const valueColName = st.valueColumn || 'Value';
			if (li < 0 || vi < 0) {
				showErrorAndReturn('Select columns.');
				return;
			} else {
				const sortCol = (typeof st.sortColumn === 'string') ? st.sortColumn : '';
				const sortDir = (typeof st.sortDirection === 'string') ? st.sortDirection : '';
				const si = sortCol ? indexOf(sortCol) : -1;

				let data = (rows || []).map((r: any, originalIndex: any) => {
					const label = (r && r.length > li) ? cellToChartString(r[li]) : '';
					const value = (r && r.length > vi) ? cellToNumber(r[vi]) : null;
					const tooltipPayload = getTooltipPayloadForRow(r);
					let sortValue = null;
					if (si >= 0 && r && r.length > si) {
						sortValue = r[si];
					}
					return {
						name: label,
						value: (typeof value === 'number' && Number.isFinite(value)) ? value : 0,
						__kustoTooltip: tooltipPayload,
						__kustoSortValue: sortValue,
						__kustoOriginalIndex: originalIndex
					};
				});

				if (si >= 0 && sortDir) {
					data.sort((a: any, b: any) => {
						const av = a.__kustoSortValue;
						const bv = b.__kustoSortValue;
						// eslint-disable-next-line eqeqeq
						if (av == null && bv == null) return 0;
						// eslint-disable-next-line eqeqeq
						if (av == null) return 1;
						// eslint-disable-next-line eqeqeq
						if (bv == null) return -1;
						let cmp = 0;
						if (typeof av === 'number' && typeof bv === 'number') {
							cmp = av - bv;
						} else if (typeof av === 'string' && typeof bv === 'string') {
							cmp = av.localeCompare(bv);
						} else if (av instanceof Date && bv instanceof Date) {
							cmp = av.getTime() - bv.getTime();
						} else {
							cmp = String(av).localeCompare(String(bv));
						}
						return sortDir === 'asc' ? cmp : -cmp;
					});
				}

				const maxValue = data.length > 0 ? Math.max(...data.map((d: any) => d.value)) : 1;
				const showLabels = !!st.showDataLabels;
				option = {
					backgroundColor: 'transparent',
					tooltip: {
						...tooltipCommon,
						trigger: 'item',
						formatter: (params: any) => {
							try {
								const name = params && params.name ? params.name : '';
								const value = params && typeof params.value === 'number' ? formatNumber(params.value) : '';
								const percent = maxValue > 0 && params && typeof params.value === 'number' ? ((params.value / maxValue) * 100).toFixed(1) : '0.0';
								const marker = params && params.marker ? params.marker : '';
								const lines = [
									`<div style="font-weight:600; margin-bottom:2px">${escHtml(name)}</div>`,
									`<div>${marker}<strong>${escHtml(valueColName)}</strong>: ${escHtml(value)} <span style="opacity:0.7">(${escHtml(percent)}%)</span></div>`
								];
								const payload = params && params.data && params.data.__kustoTooltip ? params.data.__kustoTooltip : null;
								appendTooltipColumnsHtmlLines(lines, payload, 0);
								return lines.join('');
							} catch {
								return '';
							}
						}
					},
					legend: buildLegendOption(legendPosition),
					series: [{
						type: 'funnel',
						left: '10%',
						top: 30,
						bottom: 30,
						width: '80%',
						minSize: '0%',
						maxSize: '100%',
						sort: 'none',
						gap: 2,
						data,
						label: {
							show: showLabels,
							position: 'inside',
							fontFamily: 'monospace',
							fontSize: 11,
							color: '#fff',
							textBorderColor: 'rgba(0, 0, 0, 0.7)',
							textBorderWidth: 3,
							textShadowColor: 'rgba(0, 0, 0, 0.5)',
							textShadowBlur: 4,
							formatter: (params: any) => {
								try {
									const name = params && params.name ? String(params.name) : '';
									const value = params && typeof params.value === 'number' ? formatNumber(params.value) : '';
									const percent = maxValue > 0 && params && typeof params.value === 'number' ? ((params.value / maxValue) * 100).toFixed(1) : '0.0';
									return name + ': ' + value + ' (' + percent + '%)';
								} catch {
									return '';
								}
							}
						},
						labelLine: {
							show: false
						},
						itemStyle: {
							borderColor: 'transparent',
							borderWidth: 1
						},
						emphasis: {
							label: {
								fontSize: 12
							}
						}
					}]
				};
			}
		} else if (chartType === 'scatter') {
			const xi = indexOf(st.xColumn);
			const yi = indexOf(st.yColumn);
			const xColName = st.xColumn || 'X';
			const yColName = st.yColumn || 'Y';
			const showLabels = !!st.showDataLabels;

			const xAxisTitleGap = typeof xAxisSettings.titleGap === 'number' ? xAxisSettings.titleGap : 30;

			const yAxisShowLabel = yAxisSettings.showAxisLabel !== false;
			const yAxisCustomLabel = yAxisSettings.customLabel || '';
			const yAxisName = yAxisShowLabel ? (yAxisCustomLabel || yColName) : '';
			const yAxisMin = yAxisSettings.min;
			const yAxisMax = yAxisSettings.max;
			const yAxisTitleGap = typeof yAxisSettings.titleGap === 'number' ? yAxisSettings.titleGap : 45;
			const yAxisMinValue = (yAxisMin !== '' && yAxisMin !== undefined) ? parseFloat(yAxisMin) : undefined;
			const yAxisMaxValue = (yAxisMax !== '' && yAxisMax !== undefined) ? parseFloat(yAxisMax) : undefined;

			if (xi < 0 || yi < 0) {
				showErrorAndReturn('Select columns.');
				return;
			} else {
				const useTime = inferTimeXAxisFromRows(rows, xi);
				const points = [];
				for (const r of (rows || [])) {
					const x = useTime
						? ((r && r.length > xi) ? cellToTimeMs(r[xi]) : null)
						: ((r && r.length > xi) ? cellToNumber(r[xi]) : null);
					const y = (r && r.length > yi) ? cellToNumber(r[yi]) : null;
					if (typeof x === 'number' && Number.isFinite(x) && typeof y === 'number' && Number.isFinite(y)) {
						points.push({ value: [x, y], __kustoTooltip: getTooltipPayloadForRow(r) });
					}
				}
				const userHasSort = sortColumn && (sortDirection === 'asc' || sortDirection === 'desc');
				if (!userHasSort) {
					try {
						points.sort((a: any, b: any) => {
							const av = a && a.value ? a.value : null;
							const bv = b && b.value ? b.value : null;
							const ax = av && av.length ? av[0] : 0;
							const bx = bv && bv.length ? bv[0] : 0;
							if (ax === bx) return 0;
							return ax < bx ? -1 : 1;
						});
					} catch (e) { console.error('[kusto]', e); }
				}
				const showTime = useTime ? shouldShowTimeForUtcAxis(points.map((p: any) => {
					try {
						const v = p && p.value ? p.value : null;
						return v && v.length ? v[0] : null;
					} catch { return null; }
				})) : false;
				const rotate = useTime ? computeTimeAxisLabelRotation(canvasWidthPx, points.length, showTime) : 0;
				const axisFontSize = computeAxisFontSize(points.length, canvasWidthPx, false);
				const bottomMargin = (rotate > 30 ? 45 : 25) + xAxisTitleGap;
				const leftMargin = 15 + yAxisTitleGap;
				option = {
					backgroundColor: 'transparent',
					grid: {
						left: leftMargin,
						right: 20,
						top: 20,
						bottom: bottomMargin,
						containLabel: false
					},
					tooltip: {
						...tooltipCommon,
						trigger: 'item',
						formatter: (params: any) => {
							try {
								const v = params && params.value ? params.value : null;
								const x = v && v.length ? v[0] : null;
								const y = v && v.length > 1 ? v[1] : null;
								const xStr = useTime ? formatUtcDateTime(x, showTime) : formatNumber(x);
								const yStr = formatNumber(y);
								const marker = params && params.marker ? params.marker : '';
								const lines = [
									`<div><strong>${escHtml(xColName)}</strong>: ${escHtml(xStr)}</div>`,
									`<div>${marker}<strong>${escHtml(yColName)}</strong>: ${escHtml(yStr)}</div>`
								];
								const payload = params && params.data && params.data.__kustoTooltip ? params.data.__kustoTooltip : null;
								appendTooltipColumnsHtmlLines(lines, payload, 0);
								return lines.join('');
							} catch {
								return '';
							}
						}
					},
					xAxis: useTime ? {
						type: 'time',
						name: xColName,
						nameLocation: 'middle',
						triggerEvent: true,
						nameGap: xAxisTitleGap,
						axisLabel: {
							rotate,
							fontSize: axisFontSize,
							fontFamily: 'monospace',
							formatter: (value: any) => formatUtcDateTime(value, showTime)
						},
						axisPointer: { label: { formatter: (p: any) => formatUtcDateTime(p && p.value, showTime) } }
					} : {
						type: 'value',
						name: xColName,
						nameLocation: 'middle',
						triggerEvent: true,
						nameGap: xAxisTitleGap,
						axisLabel: {
							fontSize: axisFontSize,
							fontFamily: 'monospace',
							formatter: (value: any) => formatNumber(value)
						}
					},
					yAxis: {
						type: 'value',
						name: yAxisName,
						nameLocation: 'middle',
						triggerEvent: true,
						nameGap: yAxisTitleGap,
						min: Number.isFinite(yAxisMinValue) ? yAxisMinValue : undefined,
						max: Number.isFinite(yAxisMaxValue) ? yAxisMaxValue : undefined,
						axisLabel: {
							fontSize: 11,
							fontFamily: 'monospace',
							formatter: (value: any) => formatNumber(value)
						}
					},
					series: [{
						type: 'scatter',
						name: yColName,
						data: points,
						label: {
							show: showLabels,
							position: 'top',
							fontSize: 10,
							fontFamily: 'monospace',
							formatter: (params: any) => {
								try {
									const idx = params && typeof params.dataIndex === 'number' ? params.dataIndex : 0;
									const total = points.length || 1;
									const interval = Math.max(1, Math.floor(total / 10));
									if (idx % interval !== 0) return '';
									const v = params && params.value ? params.value : null;
									const y = v && v.length > 1 ? v[1] : null;
									return formatNumber(y);
								} catch {
									return '';
								}
							}
						}
					}]
				};
				if (useTime) {
					st.__lastTimeAxis = { showTime, labelCount: points.length, rotate };
				} else {
					try { delete st.__lastTimeAxis; } catch (e) { console.error('[kusto]', e); }
				}
			}
		} else {
			// line / bar / area
			const xi = indexOf(st.xColumn);
			const xColName = st.xColumn || 'X';
			const showLabels = !!st.showDataLabels;
			const legendCol = st.legendColumn || '';
			const li = legendCol ? indexOf(legendCol) : -1;

			let yCols = Array.isArray(st.yColumns) && st.yColumns.length ? st.yColumns : (st.yColumn ? [st.yColumn] : []);
			yCols = yCols.filter((c: any) => indexOf(c) >= 0);

			if (xi < 0 || !yCols.length) {
				showErrorAndReturn('Select columns.');
				return;
			} else {
				const isArea = chartType === 'area';
				const stackMode = normalizeStackMode(st.stackMode);
				const legendSortMode = (st.legendSettings?.sortMode || '') as string;
				const legendTopN = (typeof st.legendSettings?.topN === 'number' && st.legendSettings.topN > 0) ? st.legendSettings.topN : 0;
				const legendGap = (typeof st.legendSettings?.gap === 'number') ? st.legendSettings.gap : 0;
				const legendTitle = (typeof st.legendSettings?.title === 'string' && st.legendSettings.title) ? st.legendSettings.title : '';
				const legendShowEndLabels = !!st.legendSettings?.showEndLabels;
				const useTime = inferTimeXAxisFromRows(rows, xi);

				const xAxisSortDirection = xAxisSettings.sortDirection || '';
				const xAxisScaleType = xAxisSettings.scaleType || '';
				const xAxisLabelDensity = xAxisSettings.labelDensity || '';
				const xAxisShowLabel = xAxisSettings.showAxisLabel !== false;
				const xAxisCustomLabel = xAxisSettings.customLabel || '';
				const xAxisName = xAxisShowLabel ? (xAxisCustomLabel || xColName) : '';
				const xAxisTitleGap = typeof xAxisSettings.titleGap === 'number' ? xAxisSettings.titleGap : 30;

				const yAxisShowLabel = yAxisSettings.showAxisLabel !== false;
				const yAxisCustomLabel = yAxisSettings.customLabel || '';
				const yAxisMin = yAxisSettings.min;
				const yAxisMax = yAxisSettings.max;
				const yAxisTitleGap = typeof yAxisSettings.titleGap === 'number' ? yAxisSettings.titleGap : 45;
				const yAxisMinValue = (yAxisMin !== '' && yAxisMin !== undefined) ? parseFloat(yAxisMin) : undefined;
				const yAxisMaxValue = (yAxisMax !== '' && yAxisMax !== undefined) ? parseFloat(yAxisMax) : undefined;
				const seriesColors = (yAxisSettings.seriesColors && typeof yAxisSettings.seriesColors === 'object') ? yAxisSettings.seriesColors : {};

				const useContinuousLabels = useTime && xAxisScaleType === 'continuous';
				const treatAsTime = useTime;

					let timeKeys: any[] = [];
					let timeLabels: any[] = [];
					let timeTooltipLabels: any[] = [];
					let timeShowTime = false;
					let timePeriodGranularity = 'day';
					if (treatAsTime) {
						try {
							const all = [];
							for (const r of (rows || [])) {
								const t = (r && r.length > xi) ? cellToTimeMs(r[xi]) : null;
								if (typeof t === 'number' && Number.isFinite(t)) all.push(t);
							}
							if (xAxisSortDirection === 'desc') {
								all.sort((a: any, b: any) => b - a);
							} else {
								all.sort((a: any, b: any) => a - b);
							}
							const seen = new Set();
							const uniq = [];
							for (const t of all) {
								const k = String(t);
								if (seen.has(k)) continue;
								seen.add(k);
								uniq.push(t);
							}
							timeKeys = uniq;
							timeShowTime = shouldShowTimeForUtcAxis(timeKeys);
							timeTooltipLabels = timeKeys.map((t: any) => formatUtcDateTime(t, timeShowTime));
							if (useContinuousLabels) {
								timePeriodGranularity = computeTimePeriodGranularity(timeKeys);
								timeLabels = generateContinuousTimeLabels(timeKeys, timePeriodGranularity);
							} else {
								timeLabels = timeTooltipLabels;
							}
						} catch (e) { console.error('[kusto]', e); }
					}

				let seriesData: any[] = [];
				let xLabelsSet = new Set();

				const getSeriesColor = (name: any, index: any) => {
					if (seriesColors[name]) return seriesColors[name];
					return undefined;
				};

				if (li >= 0 && yCols.length === 1) {
					const yi = indexOf(yCols[0]);
					const yColName = yCols[0] || 'Y';
					const groups: any = {};
					for (const r of (rows || [])) {
						const legendValue = (r && r.length > li) ? cellToChartString(r[li]) : '(empty)';
						const xVal = treatAsTime
							? ((r && r.length > xi) ? cellToTimeMs(r[xi]) : null)
							: ((r && r.length > xi) ? cellToChartString(r[xi]) : '');
						const yVal = (r && r.length > yi) ? cellToNumber(r[yi]) : null;
						const tt = getTooltipPayloadForRow(r);
						if (!groups[legendValue]) groups[legendValue] = [];
						groups[legendValue].push({ x: xVal, y: yVal, tt });
						if (!treatAsTime) {
							xLabelsSet.add(xVal);
						}
					}
					let legendNames = Object.keys(groups).sort();

					// ── Legend sort ───────────────────────────────────────
					if (legendSortMode === 'alpha-desc') {
						legendNames.sort((a, b) => b.localeCompare(a));
					} else if (legendSortMode === 'value-asc' || legendSortMode === 'value-desc') {
						// Sum the absolute values per legend group
						const sums: Record<string, number> = {};
						for (const name of legendNames) {
							let sum = 0;
							for (const p of (groups[name] || [])) {
								if (typeof p.y === 'number' && Number.isFinite(p.y)) sum += Math.abs(p.y);
							}
							sums[name] = sum;
						}
						legendNames.sort((a, b) => legendSortMode === 'value-asc'
							? (sums[a] || 0) - (sums[b] || 0)
							: (sums[b] || 0) - (sums[a] || 0)
						);
					}
					// alpha-asc is the default (.sort() above)

					// ── Top N ────────────────────────────────────────────
					if (legendTopN > 0 && legendNames.length > legendTopN) {
						// Sort by value descending for top-N selection, preserve display order after
						const sumsForTopN: Record<string, number> = {};
						for (const name of legendNames) {
							let sum = 0;
							for (const p of (groups[name] || [])) {
								if (typeof p.y === 'number' && Number.isFinite(p.y)) sum += Math.abs(p.y);
							}
							sumsForTopN[name] = sum;
						}
						const ranked = [...legendNames].sort((a, b) => (sumsForTopN[b] || 0) - (sumsForTopN[a] || 0));
						const topSet = new Set(ranked.slice(0, legendTopN));
						const otherNames = legendNames.filter(n => !topSet.has(n));
						// Merge the 'Other' entries into the groups
						if (otherNames.length) {
							const otherPts: any[] = [];
							for (const n of otherNames) {
								for (const p of (groups[n] || [])) otherPts.push(p);
								delete groups[n];
							}
							// Aggregate other by x-key
							const otherByX: Record<string, { x: any; y: number; tt: any }> = {};
							for (const p of otherPts) {
								const key = String(p.x);
								if (!otherByX[key]) {
									otherByX[key] = { x: p.x, y: 0, tt: p.tt };
								}
								otherByX[key].y += (typeof p.y === 'number' ? p.y : 0);
							}
							groups['Other'] = Object.values(otherByX);
						}
						legendNames = legendNames.filter(n => topSet.has(n));
						if (otherNames.length) legendNames.push('Other');
					}

					if (treatAsTime) {
						for (const legendName of legendNames) {
							const pts = groups[legendName] || [];
							pts.sort((a: any, b: any) => (a.x || 0) - (b.x || 0));
								const map: any = {};
								const tmap: any = {};
								for (const p of pts) {
									const tx = p && typeof p.x === 'number' && Number.isFinite(p.x) ? p.x : null;
									if (tx === null) continue;
									const key = String(tx);
									map[key] = p.y;
									if (!(key in tmap)) tmap[key] = p.tt;
								}
							seriesData.push({
								name: legendName,
								type: (chartType === 'bar') ? 'bar' : 'line',
								...(isArea ? { areaStyle: {} } : {}),
								...(getSeriesColor(legendName, seriesData.length) ? { itemStyle: { color: getSeriesColor(legendName, seriesData.length) }, lineStyle: { color: getSeriesColor(legendName, seriesData.length) }, areaStyle: isArea ? { color: getSeriesColor(legendName, seriesData.length) } : undefined } : {}),
								data: timeKeys.map((t: any, idx: any) => {
									const key = String(t);
									if (!(key in map)) return null;
									const v = map[key];
									const xLabel = timeTooltipLabels[idx] || timeLabels[idx];
									return { value: v, name: xLabel, __kustoTooltip: (key in tmap) ? tmap[key] : null };
								}),
								label: {
									show: showLabels,
									position: 'top',
									fontSize: 10,
									fontFamily: 'monospace',
									formatter: (params: any) => {
										try {
											const idx = params && typeof params.dataIndex === 'number' ? params.dataIndex : 0;
												const total = timeKeys.length || 1;
											const interval = Math.max(1, Math.floor(total / 10));
											if (idx % interval !== 0) return '';
											const v = params && params.value ? params.value : null;
												return formatNumber(v);
										} catch {
											return '';
										}
									}
								}
							});
						}
					} else {
						const xLabels = Array.from(xLabelsSet);
						for (const legendName of legendNames) {
							const pts = groups[legendName] || [];
							const dataMap: any = {};
							const ttMap: any = {};
							for (const p of pts) {
								dataMap[p.x] = p.y;
								if (!(p.x in ttMap)) ttMap[p.x] = p.tt;
							}
							seriesData.push({
								name: legendName,
								type: (chartType === 'bar') ? 'bar' : 'line',
								...(isArea ? { areaStyle: {} } : {}),
								...(getSeriesColor(legendName, seriesData.length) ? { itemStyle: { color: getSeriesColor(legendName, seriesData.length) }, lineStyle: { color: getSeriesColor(legendName, seriesData.length) }, areaStyle: isArea ? { color: getSeriesColor(legendName, seriesData.length) } : undefined } : {}),
								data: xLabels.map((xl: any) => {
									const v = (xl in dataMap) ? dataMap[xl] : null;
									if (v === null || v === undefined) return null;
									return { value: v, name: xl, __kustoTooltip: (xl in ttMap) ? ttMap[xl] : null };
								}),
								label: {
									show: showLabels,
									position: 'top',
									fontSize: 10,
									fontFamily: 'monospace',
									formatter: (params: any) => {
										try {
											const idx = params && typeof params.dataIndex === 'number' ? params.dataIndex : 0;
											const total = xLabels.length || 1;
											const interval = Math.max(1, Math.floor(total / 10));
											if (idx % interval !== 0) return '';
											const v = params && typeof params.value === 'number' ? params.value : (params && params.data);
											return (typeof v === 'number') ? formatNumber(v) : '';
										} catch {
											return '';
										}
									}
								}
							});
						}
					}
				} else {
					for (const yCol of yCols) {
						const yi = indexOf(yCol);
						if (yi < 0) continue;

						if (treatAsTime) {
								const map: any = {};
								const tmap: any = {};
								for (const r of (rows || [])) {
									const x = (r && r.length > xi) ? cellToTimeMs(r[xi]) : null;
									const y = (r && r.length > yi) ? cellToNumber(r[yi]) : null;
									if (typeof x === 'number' && Number.isFinite(x)) {
										const key = String(x);
										map[key] = y;
										if (!(key in tmap)) tmap[key] = getTooltipPayloadForRow(r);
									}
								}
							seriesData.push({
								name: yCol,
								type: (chartType === 'bar') ? 'bar' : 'line',
								...(isArea ? { areaStyle: {} } : {}),
								...(getSeriesColor(yCol, seriesData.length) ? { itemStyle: { color: getSeriesColor(yCol, seriesData.length) }, lineStyle: { color: getSeriesColor(yCol, seriesData.length) }, areaStyle: isArea ? { color: getSeriesColor(yCol, seriesData.length) } : undefined } : {}),
								data: timeKeys.map((t: any, idx: any) => {
									const key = String(t);
									if (!(key in map)) return null;
									const v = map[key];
									const xLabel = timeTooltipLabels[idx] || timeLabels[idx];
									return { value: v, name: xLabel, __kustoTooltip: (key in tmap) ? tmap[key] : null };
								}),
								label: {
									show: showLabels,
									position: 'top',
									fontSize: 10,
									fontFamily: 'monospace',
									formatter: (params: any) => {
										try {
											const idx = params && typeof params.dataIndex === 'number' ? params.dataIndex : 0;
												const total = timeKeys.length || 1;
											const interval = Math.max(1, Math.floor(total / 10));
											if (idx % interval !== 0) return '';
												const v = params && params.value ? params.value : null;
												return formatNumber(v);
										} catch {
											return '';
										}
									}
								}
							});
						} else {
							for (const r of (rows || [])) {
								const xVal = (r && r.length > xi) ? cellToChartString(r[xi]) : '';
								xLabelsSet.add(xVal);
							}
							const xLabels = Array.from(xLabelsSet);
							const yData = (rows || []).map((r: any) => (r && r.length > yi) ? cellToNumber(r[yi]) : null);
							const ttData = (rows || []).map((r: any) => getTooltipPayloadForRow(r));
							seriesData.push({
								name: yCol,
								type: (chartType === 'bar') ? 'bar' : 'line',
								...(isArea ? { areaStyle: {} } : {}),
								...(getSeriesColor(yCol, seriesData.length) ? { itemStyle: { color: getSeriesColor(yCol, seriesData.length) }, lineStyle: { color: getSeriesColor(yCol, seriesData.length) }, areaStyle: isArea ? { color: getSeriesColor(yCol, seriesData.length) } : undefined } : {}),
								data: yData.map((v: any, idx: any) => {
									if (v === null || v === undefined) return null;
									return { value: v, __kustoTooltip: (idx < ttData.length) ? ttData[idx] : null };
								}),
								label: {
									show: showLabels,
									position: 'top',
									fontSize: 10,
									fontFamily: 'monospace',
									formatter: (params: any) => {
										try {
											const idx = params && typeof params.dataIndex === 'number' ? params.dataIndex : 0;
											const total = yData.length || 1;
											const interval = Math.max(1, Math.floor(total / 10));
											if (idx % interval !== 0) return '';
											const v = params && typeof params.value === 'number' ? params.value : (params && params.data);
											return (typeof v === 'number') ? formatNumber(v) : '';
										} catch {
											return '';
										}
									}
								}
							});
						}
					}
				}

				let xLabels = treatAsTime ? timeLabels : Array.from(xLabelsSet);

				if (!treatAsTime && xAxisSortDirection) {
					try {
						const numericLabels = xLabels.filter((l: any) => {
							const n = parseFloat(l);
							return !isNaN(n) && isFinite(n);
						});
						const isNumeric = numericLabels.length === xLabels.length && xLabels.length > 0;

						if (isNumeric) {
							xLabels.sort((a: any, b: any) => {
								const diff = parseFloat(a) - parseFloat(b);
								return xAxisSortDirection === 'desc' ? -diff : diff;
							});
						} else {
							xLabels.sort((a: any, b: any) => {
								const cmp = String(a).localeCompare(String(b));
								return xAxisSortDirection === 'desc' ? -cmp : cmp;
							});
						}
					} catch (e) { console.error('[kusto]', e); }
				}

				const showTime = treatAsTime ? timeShowTime : false;

				// ── Apply stack mode ──────────────────────────────────────
				if (stackMode === 'stacked' || stackMode === 'stacked100') {
					for (const s of seriesData) {
						s.stack = 'total';
						// Move labels inside segments and hide when the segment
						// is too thin to display legibly.
						if (s.label) {
							s.label.position = 'inside';
							const origFormatter = s.label.formatter;
							s.label.formatter = (params: any) => {
								try {
									// Compute the segment's share of the stack.
									// For stacked100 we already have percentages;
									// for normal stacked, approximate by checking
									// the raw value against a visibility threshold.
									if (stackMode === 'stacked100') {
										const v = params?.data?.value;
										if (typeof v === 'number' && v < 5) return '';
									} else {
										// In normal stacked mode, only show label when
										// the segment is at least ~8% of the column total.
										const dataIdx = params?.dataIndex ?? 0;
										let colTotal = 0;
										for (const sd of seriesData) {
											const d = sd.data?.[dataIdx];
											const dv = d && typeof d === 'object' ? d.value : (typeof d === 'number' ? d : null);
											if (typeof dv === 'number' && Number.isFinite(dv)) colTotal += Math.abs(dv);
										}
										const sv = params?.data?.value ?? params?.value ?? 0;
										if (colTotal > 0 && Math.abs(sv) / colTotal < 0.08) return '';
									}
									return typeof origFormatter === 'function' ? origFormatter(params) : '';
								} catch {
									return '';
								}
							};
						}
					}
				}
				if (stackMode === 'stacked100' && seriesData.length > 1) {
					// Compute per-index totals and normalize to percentages.
					const dataLen = seriesData[0]?.data?.length || 0;
					for (let i = 0; i < dataLen; i++) {
						let total = 0;
						for (const s of seriesData) {
							const d = s.data?.[i];
							const v = d && typeof d === 'object' ? d.value : (typeof d === 'number' ? d : null);
							if (typeof v === 'number' && Number.isFinite(v)) total += Math.abs(v);
						}
						if (total === 0) continue;
						for (const s of seriesData) {
							const d = s.data?.[i];
							if (!d || typeof d !== 'object') continue;
							const v = d.value;
							if (typeof v === 'number' && Number.isFinite(v)) {
								d.__kustoOriginalValue = v;
								d.value = (v / total) * 100;
							}
						}
					}
				}

				let rotate;
				let categoryLabelStats = null;
				if (treatAsTime) {
					if (useContinuousLabels) {
						categoryLabelStats = measureLabelChars(xLabels);
						rotate = computeCategoryLabelRotation(canvasWidthPx, xLabels.length, categoryLabelStats.avgLabelChars, categoryLabelStats.maxLabelChars);
					} else {
						rotate = computeTimeAxisLabelRotation(canvasWidthPx, xLabels.length, showTime);
					}
				} else {
					categoryLabelStats = measureLabelChars(xLabels);
					rotate = computeCategoryLabelRotation(canvasWidthPx, xLabels.length, categoryLabelStats.avgLabelChars, categoryLabelStats.maxLabelChars);
				}
				const axisFontSize = computeAxisFontSize(xLabels.length, canvasWidthPx, false);

				let axisLabelInterval: any = 0;
				const densityValue = typeof xAxisLabelDensity === 'number' ? Math.max(1, xAxisLabelDensity) : 100;
				const totalLabels = xLabels.length;
				if (densityValue < 100) {
					const skipFactor = (100 - densityValue) / 100;
					const maxInterval = Math.max(2, totalLabels - 1);
					const interval = Math.max(1, Math.floor(maxInterval * skipFactor));
					axisLabelInterval = (index: any) => {
						if (index === 0 || index === totalLabels - 1) return true;
						return index % (interval + 1) === 0;
					};
				}

				const bottomMargin = (rotate > 30 ? 45 : 15) + xAxisTitleGap;

				const legendEnabled = seriesData.length > 1;
				const useEndLabels = legendShowEndLabels && legendEnabled;

				let legendOpt: any;
				if (useEndLabels) {
					legendOpt = { show: false };
				} else if (legendEnabled) {
					legendOpt = buildLegendOption(legendPosition);
				}

				// Add end labels to each series when enabled
				if (useEndLabels) {
					for (const s of seriesData) {
						s.endLabel = {
							show: true,
							formatter: '{a}',
							fontSize: 11,
							fontFamily: 'var(--vscode-font-family, sans-serif)',
							distance: 8,
						};
					}
				}

				const endLabelRightMargin = useEndLabels ? 100 : 0;
				const gridLeft = (legendEnabled && !useEndLabels && legendPosition === 'left') ? (SIDE_LEGEND_TOTAL + SIDE_LEGEND_GAP + legendGap + yAxisTitleGap) : (15 + yAxisTitleGap);
				const gridRight = useEndLabels ? (20 + endLabelRightMargin)
					: ((legendEnabled && legendPosition === 'right') ? (SIDE_LEGEND_TOTAL + SIDE_LEGEND_GAP + legendGap) : 20);
				const gridTop = (legendEnabled && !useEndLabels && legendPosition === 'top') ? (50 + legendGap) : 20;
				const gridBottom = bottomMargin + ((legendEnabled && !useEndLabels && legendPosition === 'bottom') ? (40 + legendGap) : 0);

				// Build legend title (ECharts title component positioned near the legend)
				let legendTitleOpt: any = undefined;
				const effectiveLegendTitle = legendTitle || (legendEnabled && legendCol ? legendCol : '');
				if (effectiveLegendTitle && legendEnabled && !useEndLabels) {
					const titleStyle = { fontSize: 11, fontWeight: 'normal' as const, fontStyle: 'italic' as const, color: 'auto' };
					if (legendPosition === 'top') {
						legendTitleOpt = { text: effectiveLegendTitle, top: 0, right: 0, textStyle: titleStyle };
					} else if (legendPosition === 'bottom') {
						legendTitleOpt = { text: effectiveLegendTitle, bottom: 0, right: 0, textStyle: titleStyle };
					} else if (legendPosition === 'left') {
						legendTitleOpt = { text: effectiveLegendTitle, top: 4, left: 0, textStyle: titleStyle };
					} else {
						legendTitleOpt = { text: effectiveLegendTitle, top: 4, right: 0, textStyle: titleStyle };
					}
				}

				option = {
					backgroundColor: 'transparent',
					...(legendTitleOpt ? { title: legendTitleOpt } : {}),
					grid: {
						left: gridLeft,
						right: gridRight,
						top: gridTop,
						bottom: gridBottom,
						containLabel: false
					},
					legend: legendOpt,
					tooltip: {
						trigger: 'axis',
						confine: true,
						enterable: false,
						// Hide the built-in tooltip content — we render our own
						// interactive tooltip panel instead.  The axis pointer
						// (shadow/crosshair) still renders independently.
						extraCssText: 'opacity:0 !important; pointer-events:none !important; width:0 !important; height:0 !important; padding:0 !important; border:none !important; box-shadow:none !important; overflow:hidden !important;',
						axisPointer: {
							type: 'shadow',
							snap: true,
							animation: true,
							animationDurationUpdate: 120
						},
						formatter: (params: any) => {
							try {
								const arr = Array.isArray(params) ? params : (params ? [params] : []);
								handleTooltipFormatter(id, arr, stackMode);
							} catch (e) { console.error('[kusto]', e); }
							return '<span></span>';
						},
						position: (point: any) => {
							try {
								handleTooltipPosition(id, point[0], point[1], inst);
							} catch (e) { console.error('[kusto]', e); }
							return [-9999, -9999];
						}
					},
						xAxis: {
							type: 'category',
							name: xAxisName,
							nameLocation: 'middle',
							nameGap: rotate > 30 ? xAxisTitleGap + 25 : xAxisTitleGap,
							data: xLabels,
							boundaryGap: (chartType === 'bar'),
							triggerEvent: true,
							axisTick: { alignWithLabel: true },
							axisLabel: {
								fontSize: axisFontSize,
								fontFamily: 'monospace',
								interval: axisLabelInterval,
								rotate
							}
						},
					yAxis: {
						type: 'value',
						name: yAxisShowLabel ? (yAxisCustomLabel || (yCols.length === 1 ? yCols[0] : '')) : '',
						nameLocation: 'middle',
						triggerEvent: true,
						nameGap: yAxisTitleGap,
						min: stackMode === 'stacked100' ? 0 : (Number.isFinite(yAxisMinValue) ? yAxisMinValue : undefined),
						max: stackMode === 'stacked100' ? 100 : (Number.isFinite(yAxisMaxValue) ? yAxisMaxValue : undefined),
						axisLabel: {
							fontSize: 11,
							fontFamily: 'monospace',
							formatter: stackMode === 'stacked100'
								? (value: any) => (typeof value === 'number' ? value.toFixed(0) + '%' : '')
								: (value: any) => formatNumber(value)
						}
					},
					series: seriesData
				};

				if (treatAsTime && !useContinuousLabels) {
						st.__lastTimeAxis = { showTime, labelCount: xLabels.length, rotate };
						try { delete st.__lastCategoryAxis; } catch (e) { console.error('[kusto]', e); }
				} else {
					try { delete st.__lastTimeAxis; } catch (e) { console.error('[kusto]', e); }
					if (categoryLabelStats) {
						st.__lastCategoryAxis = {
							labelCount: xLabels.length,
							avgLabelChars: categoryLabelStats.avgLabelChars,
							maxLabelChars: categoryLabelStats.maxLabelChars,
							rotate
						};
					}
				}
			}
		}
	} catch {
		showErrorAndReturn('Failed to render chart.');
		return;
	}

	try {
		for (const child of Array.from(canvas.childNodes) as any[]) {
			if (child.nodeType === Node.TEXT_NODE) {
				canvas.removeChild(child);
			}
		}
		// Dismiss any visible tooltip BEFORE setOption with notMerge — the full
		// option replacement destroys the tooltip's internal DOM node, and any
		// pending tooltip animation/update that still holds the old reference
		// would crash with "Cannot set properties of null (setting 'innerHTML')".
		try { inst.dispatchAction({ type: 'hideTip' }); } catch (e) { console.error('[kusto]', e); }
		try { dismissHoverTooltip(id); } catch (e) { console.error('[kusto]', e); }
		inst.setOption(option || {}, { notMerge: true, lazyUpdate: true, silent: true });

		const isNowRendering = true;
		if (!wasRendering && isNowRendering) {
			try {
				const wrapper = document.getElementById(id + '_chart_wrapper') as any;
				if (wrapper && !wrapper.dataset.kustoUserResized) {
					const defaultChartHeight = 360;
					wrapper.style.height = defaultChartHeight + 'px';

					const sectionBox = document.getElementById(id) as any;
					if (sectionBox) {
						sectionBox.style.display = 'none';
						void sectionBox.offsetHeight;
						sectionBox.style.display = '';
					}

					requestAnimationFrame(() => {
						try {
							if (canvas.clientWidth > 0 && canvas.clientHeight > 0) {
								inst.resize();
							}
						} catch (e) { console.error('[kusto]', e); }
					});
					try { schedulePersist(); } catch (e) { console.error('[kusto]', e); }
				}
			} catch (e) { console.error('[kusto]', e); }
		}
		st.__wasRendering = isNowRendering;
	} catch (e) { console.error('[kusto]', e); }
	// Resize once after the browser has laid out the canvas.  Guard against
	// zero-dimension canvases (e.g. hidden containers) to avoid the ECharts
	// "Can't get DOM width or height" warning.
	try {
		requestAnimationFrame(() => {
			try {
				if (canvas.clientWidth > 0 && canvas.clientHeight > 0) {
					inst.resize();
				}
			} catch (e) { console.error('[kusto]', e); }
		});
	} catch (e) { console.error('[kusto]', e); }

	// Install mouse guard for deferred rendering.
	try { _installChartMouseGuard(id, canvas); } catch (e) { console.error('[kusto]', e); }

	// Keep the chart responsive to wrapper width changes.
	// IMPORTANT: Only react to WIDTH changes.  The wrapper has height:auto so its
	// height is determined by the canvas child.  inst.resize() sets the canvas size
	// to match the container, which changes the wrapper height, which would fire
	// the ResizeObserver again → infinite loop.  By tracking width only, the loop
	// is broken: inst.resize() doesn't change the wrapper's width.
	try {
		if (!st.__resizeObserver && typeof ResizeObserver !== 'undefined') {
			let lastObservedWidth = 0;
			let pendingWidth = 0;
			let resizeRaf = 0;
			st.__resizeObserver = new ResizeObserver((entries) => {
				let newWidth = 0;
				try {
					for (const entry of entries) {
						const cr = entry.contentRect;
						if (cr && cr.width > 0) newWidth = Math.round(cr.width);
					}
				} catch (e) { console.error('[kusto]', e); }
				if (!newWidth) return;
				pendingWidth = newWidth;
				if (resizeRaf) return;
				resizeRaf = requestAnimationFrame(() => {
					resizeRaf = 0;
					const width = pendingWidth;
					// Ignore tiny jitter (1px oscillation) to avoid resize feedback loops.
					if (!width || (lastObservedWidth && Math.abs(width - lastObservedWidth) < 2)) return;
					lastObservedWidth = width;
					try {
						if (canvas.clientWidth > 0 && canvas.clientHeight > 0) {
							inst.resize();
						}
					} catch (e) { console.error('[kusto]', e); }
					try {
						if (st.__lastTimeAxis) {
							const rotate = computeTimeAxisLabelRotation(width, st.__lastTimeAxis.labelCount, st.__lastTimeAxis.showTime);
							if (rotate !== st.__lastTimeAxis.rotate) {
								st.__lastTimeAxis.rotate = rotate;
								try {
									inst.setOption({ xAxis: { axisLabel: { rotate } } }, { lazyUpdate: true, silent: true });
								} catch (e) { console.error('[kusto]', e); }
							}
						} else if (st.__lastCategoryAxis) {
							const ca = st.__lastCategoryAxis;
							const rotate = computeCategoryLabelRotation(width, ca.labelCount, ca.avgLabelChars, ca.maxLabelChars);
							if (rotate !== ca.rotate) {
								ca.rotate = rotate;
								try {
									inst.setOption({ xAxis: { axisLabel: { rotate } } }, { lazyUpdate: true, silent: true });
								} catch (e) { console.error('[kusto]', e); }
							}
						}
					} catch (e) { console.error('[kusto]', e); }
				});
			});
			try {
				const wrapper = document.getElementById(id + '_chart_wrapper') as any;
				if (wrapper) st.__resizeObserver.observe(wrapper);
			} catch (e) { console.error('[kusto]', e); }
		}
	} catch (e) { console.error('[kusto]', e); }
}

// ── Maximize ──────────────────────────────────────────────────────────────────

export function maximizeChartBox(boxId: any) {
	try {
		const wrapper = document.getElementById(boxId + '_chart_wrapper') as any;
		if (!wrapper) return;

		const st = getChartState(boxId);

		const isChartRendered = st && st.__echarts && st.__echarts.instance && st.__wasRendering;
		const targetHeight = isChartRendered
			? 360
			: (typeof getChartMinResizeHeight === 'function' ? getChartMinResizeHeight(boxId) : 80);

		wrapper.style.height = Math.ceil(targetHeight) + 'px';
		try { delete wrapper.dataset.kustoUserResized; } catch (e) { console.error('[kusto]', e); }

		// NOTE: Do NOT call renderChart here — it would create an infinite loop
		// because renderChart calls maximizeChartBox on state transitions.
		try {
			if (st && st.__echarts && st.__echarts.instance) {
				requestAnimationFrame(() => {
					try { st.__echarts.instance.resize(); } catch (e) { console.error('[kusto]', e); }
				});
			}
		} catch (e) { console.error('[kusto]', e); }
		try { schedulePersist(); } catch (e) { console.error('[kusto]', e); }
	} catch (e) { console.error('[kusto]', e); }
}

// ── Legacy-compatible re-exports ──────────────────────────────────────────────
// These aliases preserve the __kusto prefix for callers that haven't been updated yet.

export {
	getChartState as __kustoGetChartState,
	renderChart as __kustoRenderChart,
	disposeChartEcharts as __kustoDisposeChartEcharts,
	maximizeChartBox as __kustoMaximizeChartBox,
	getChartMinResizeHeight as __kustoGetChartMinResizeHeight,
	getChartActiveCanvasElementId as __kustoGetChartActiveCanvasElementId,
	legendPositionIcons as __kustoLegendPositionIcons,
	updateLegendPositionButtonUI as __kustoUpdateLegendPositionButtonUI,
};
