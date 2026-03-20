// Chart box creation, ECharts rendering, chart state management.
// Extracted from extraBoxes.ts (Phase 6 decomposition).
// Window bridge exports at bottom for remaining legacy callers.
import { schedulePersist } from './persistence';

import { isDarkTheme } from './monaco-theme';
import { escapeHtml, getScrollY, maybeAutoScrollWhileDragging } from './utils';
import { getResultsState } from './resultsState';
import {
	formatNumber as _formatNumber,
	computeAxisFontSize as _computeAxisFontSize,
	normalizeLegendPosition as _normalizeLegendPosition,
	getDefaultXAxisSettings,
	getDefaultYAxisSettings,
	formatUtcDateTime as _formatUtcDateTime,
	computeTimePeriodGranularity as _computeTimePeriodGranularity,
	formatTimePeriodLabel as _formatTimePeriodLabel,
	generateContinuousTimeLabels as _generateContinuousTimeLabels,
	shouldShowTimeForUtcAxis as _shouldShowTimeForUtcAxis,
	computeTimeAxisLabelRotation as _computeTimeAxisLabelRotation,
	computeCategoryLabelRotation as _computeCategoryLabelRotation,
	measureLabelChars as _measureLabelChars,
} from '../shared/chart-utils.js';

import {
	__kustoGetRawCellValueForChart, __kustoCellToChartTimeMs, __kustoCellToChartString,
	__kustoCellToChartNumber, __kustoInferTimeXAxisFromRows, __kustoNormalizeResultsColumnName,
	__kustoCleanupSectionModeResizeObserver
} from './extraBoxes';
const _win = window;

// Access shared chart/transformation state from window (set by extraBoxes.ts).
// Initialize on window if not already present, so load order doesn't matter.
window.chartStateByBoxId = window.chartStateByBoxId || {};
let chartStateByBoxId = window.chartStateByBoxId;
window.__kustoChartBoxes = window.__kustoChartBoxes || [];
let chartBoxes: any[] = window.__kustoChartBoxes;

export const __kustoLegendPositionIcons = {
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

export function __kustoNormalizeLegendPosition( pos: any) {
	return _normalizeLegendPosition(pos);
}

export function __kustoUpdateLegendPositionButtonUI( boxId: any) {
	try {
		const id = String(boxId || '');
		if (!id) return;
		const st = __kustoGetChartState(id);
		const chartType = (st && typeof st.chartType === 'string') ? String(st.chartType) : '';
		const btn = document.getElementById(id + '_chart_legend_pos_btn') as any;
		const legendWrapper = document.getElementById(id + '_chart_legend_wrapper') as any;
		if (!btn) return;

		// Only show legend position button for chart types that expose the Legend column UI
		// AND when a legend column is actually selected.
		const isValidChartType = (chartType === 'line' || chartType === 'area' || chartType === 'bar');
		const hasLegendColumn = (st && typeof st.legendColumn === 'string' && st.legendColumn !== '');
		const show = isValidChartType && hasLegendColumn;
		btn.style.display = show ? '' : 'none';
		// Adjust the legend dropdown wrapper to take full width when button is hidden.
		if (legendWrapper) {
			legendWrapper.style.flex = show ? '1 1 auto' : '1 1 100%';
		}
		if (!show) return;

		const pos = __kustoNormalizeLegendPosition(st && st.legendPosition);
		try { st.legendPosition = pos; } catch (e) { console.error('[kusto]', e); }
		btn.innerHTML = __kustoLegendPositionIcons[pos] || __kustoLegendPositionIcons.top;
		const title = 'Legend position: ' + (pos.charAt(0).toUpperCase() + pos.slice(1));
		btn.title = title;
		btn.setAttribute('aria-label', title);
	} catch (e) { console.error('[kusto]', e); }
}

export function __kustoFormatNumber( value: any) {
	try { return _formatNumber(value); } catch { return String(value); }
}

export function __kustoComputeAxisFontSize( labelCount: any, axisPixelWidth: any, isYAxis: any) {
	try { return _computeAxisFontSize(labelCount, axisPixelWidth, isYAxis); } catch { return 12; }
}

export function __kustoGetChartState( boxId: any) {
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
		// Ensure xAxisSettings exists with defaults
		try {
			if (!chartStateByBoxId[id].xAxisSettings || typeof chartStateByBoxId[id].xAxisSettings !== 'object') {
				chartStateByBoxId[id].xAxisSettings = __kustoGetDefaultAxisSettings();
			}
		} catch (e) { console.error('[kusto]', e); }
		// Ensure yAxisSettings exists with defaults
		try {
			if (!chartStateByBoxId[id].yAxisSettings || typeof chartStateByBoxId[id].yAxisSettings !== 'object') {
				chartStateByBoxId[id].yAxisSettings = __kustoGetDefaultYAxisSettings();
			}
		} catch (e) { console.error('[kusto]', e); }
		return chartStateByBoxId[id];
	} catch {
		return { mode: 'edit', expanded: true };
	}
}

/**
 * Returns default axis settings.
 */
export function __kustoGetDefaultAxisSettings() {
	return getDefaultXAxisSettings();
}

/**
 * Returns default Y-axis settings.
 */
export function __kustoGetDefaultYAxisSettings() {
	return getDefaultYAxisSettings();
}
export function __kustoGetChartMinResizeHeight( boxId: any) {
	const CHART_CANVAS_RENDERING_MIN_HEIGHT = 140; // When chart is rendering
	const CHART_CANVAS_PLACEHOLDER_MIN_HEIGHT = 60; // When showing placeholder text
	const CONTROLS_MARGIN_BOTTOM = 20; // CSS margin-bottom on .kusto-chart-controls
	const FALLBACK_MIN = 80;
	try {
		const id = String(boxId || '');
		if (!id) return FALLBACK_MIN;
		const st = __kustoGetChartState(id);
		const isEditMode = st.mode === 'edit';
		
		// Determine the canvas min-height based on whether a chart is actually rendering
		// Use the __wasRendering flag set by __kustoRenderChart as the source of truth
		const isChartRendering = st.__wasRendering || false;
		const canvasMinH = isChartRendering ? CHART_CANVAS_RENDERING_MIN_HEIGHT : CHART_CANVAS_PLACEHOLDER_MIN_HEIGHT;
		
		// In preview mode, we only need space for the chart canvas
		if (!isEditMode) {
			return canvasMinH;
		}
		
		// In edit mode, account for the controls panel height
		// The controls div doesn't have an ID, so find it via the edit container
		const editContainer = document.getElementById(id + '_chart_edit') as any;
		const controlsEl = editContainer ? editContainer.querySelector('.kusto-chart-controls') : null;
		const controlsH = controlsEl && controlsEl.getBoundingClientRect
			? Math.ceil(controlsEl.getBoundingClientRect().height || 0)
			: 0;
		
		// Min = controls height + margin-bottom (not captured by getBoundingClientRect) + chart canvas min-height
		return Math.max(FALLBACK_MIN, controlsH + CONTROLS_MARGIN_BOTTOM + canvasMinH);
	} catch {
		return FALLBACK_MIN;
	}
}

export function __kustoUpdateChartBuilderUI( boxId: any) {
	const id = String(boxId || '');
	if (!id) return;

	// Lit elements: sync global state into reactive properties, then refresh datasets.
	try {
		const el = document.getElementById(id) as any;
		if (el && typeof el.refreshDatasets === 'function') {
			if (typeof el.syncFromGlobalState === 'function') el.syncFromGlobalState();
			el.refreshDatasets();
			return;
		}
	} catch (e) { console.error('[kusto]', e); }
}

export function __kustoGetChartActiveCanvasElementId( boxId: any) {
	const st = __kustoGetChartState(boxId);
	const mode = st && st.mode ? String(st.mode) : 'edit';
	return (mode === 'preview') ? (boxId + '_chart_canvas_preview') : (boxId + '_chart_canvas_edit');
}

export function __kustoGetIsDarkThemeForEcharts() {
	try {
		return isDarkTheme();
	} catch (e) { console.error('[kusto]', e); }
	return true;
}

export function __kustoFormatUtcDateTime( ms: any, showTime: any) {
	return _formatUtcDateTime(ms, showTime);
}

/**
 * Determines the best time period granularity for continuous axis labels based on the date range.
 * Returns: 'day', 'week', 'month', 'quarter', or 'year'
 */
export function __kustoComputeTimePeriodGranularity( timeMsValues: any) {
	try { return _computeTimePeriodGranularity(timeMsValues); } catch { return 'day'; }
}

/**
 * Formats a timestamp to a period boundary label based on granularity.
 */
export function __kustoFormatTimePeriodLabel( ms: any, granularity: any) {
	return _formatTimePeriodLabel(ms, granularity);
}

/**
 * Generates axis labels for continuous time scale, showing only period boundaries.
 * Returns an array of labels with the same length as timeKeys, with empty strings for non-boundary points.
 */
export function __kustoGenerateContinuousTimeLabels( timeKeys: any, granularity: any) {
	try { return _generateContinuousTimeLabels(timeKeys, granularity); } catch { return (timeKeys || []).map(() => ''); }
}

export function __kustoShouldShowTimeForUtcAxis( timeMsValues: any) {
	try { return _shouldShowTimeForUtcAxis(timeMsValues); } catch { return false; }
}

export function __kustoComputeTimeAxisLabelRotation( axisPixelWidth: any, labelCount: any, showTime: any) {
	return _computeTimeAxisLabelRotation(axisPixelWidth, labelCount, showTime);
}

/**
 * Compute the optimal X-axis label rotation for category (non-time) labels.
 */
export function __kustoComputeCategoryLabelRotation( axisPixelWidth: any, labelCount: any, avgLabelChars: any, maxLabelChars: any) {
	return _computeCategoryLabelRotation(axisPixelWidth, labelCount, avgLabelChars, maxLabelChars);
}

/**
 * Measure label character stats from an array of label strings.
 * Returns { avgLabelChars, maxLabelChars }.
 */
export function __kustoMeasureLabelChars( labels: any) {
	return _measureLabelChars(labels);
}

let __kustoEchartsThemeObserverStarted = false;
let __kustoLastAppliedEchartsIsDarkTheme: any = null;

export function __kustoRefreshChartsForThemeChange() {
	let dark = true;
	try { dark = __kustoGetIsDarkThemeForEcharts(); } catch { dark = true; }
	if (__kustoLastAppliedEchartsIsDarkTheme === dark) return;
	__kustoLastAppliedEchartsIsDarkTheme = dark;
	try {
		for (const id of (chartBoxes || [])) {
			try { __kustoDisposeChartEcharts(id); } catch (e) { console.error('[kusto]', e); }
			try { __kustoRenderChart(id); } catch (e) { console.error('[kusto]', e); }
			try { __kustoUpdateLegendPositionButtonUI(id); } catch (e) { console.error('[kusto]', e); }
		}
	} catch (e) { console.error('[kusto]', e); }
}

export function __kustoStartEchartsThemeObserver() {
	if (__kustoEchartsThemeObserverStarted) return;
	__kustoEchartsThemeObserverStarted = true;
	try { __kustoRefreshChartsForThemeChange(); } catch (e) { console.error('[kusto]', e); }

	let pending = false;
	const schedule = () => {
		if (pending) return;
		pending = true;
		setTimeout(() => {
			pending = false;
			try { __kustoRefreshChartsForThemeChange(); } catch (e) { console.error('[kusto]', e); }
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

export function __kustoDisposeChartEcharts( boxId: any) {
	try {
		const st = __kustoGetChartState(boxId);
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
		}
	} catch (e) { console.error('[kusto]', e); }
}

export function __kustoRenderChart( boxId: any) {
	const id = String(boxId || '');
	if (!id) return;
	try { __kustoStartEchartsThemeObserver(); } catch (e) { console.error('[kusto]', e); }
	const st = __kustoGetChartState(id);
	
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
	const canvasId = __kustoGetChartActiveCanvasElementId(id);
	const canvas = document.getElementById(canvasId) as any;
	if (!canvas) return;

	// If ECharts isn't loaded yet, show a simple placeholder.
	if (!window.echarts || typeof window.echarts.init !== 'function') {
		try { canvas.textContent = 'Loading chart…'; } catch (e) { console.error('[kusto]', e); }
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
	const colNames = cols.map(__kustoNormalizeResultsColumnName);
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
				const aVal = (a && a.length > sortColIndex) ? __kustoGetRawCellValueForChart(a[sortColIndex]) : null;
				const bVal = (b && b.length > sortColIndex) ? __kustoGetRawCellValueForChart(b[sortColIndex]) : null;
				// Handle nulls: sort nulls to the end
				if (aVal === null && bVal === null) return 0;
				if (aVal === null) return 1;
				if (bVal === null) return -1;
				// Numeric comparison
				const aNum = typeof aVal === 'number' ? aVal : (typeof aVal === 'string' ? parseFloat(aVal) : NaN);
				const bNum = typeof bVal === 'number' ? bVal : (typeof bVal === 'string' ? parseFloat(bVal) : NaN);
				if (!isNaN(aNum) && !isNaN(bNum)) {
					return sortDirection === 'asc' ? (aNum - bNum) : (bNum - aNum);
				}
				// String comparison
				const aStr = String(aVal ?? '');
				const bStr = String(bVal ?? '');
				const cmp = aStr.localeCompare(bStr);
				return sortDirection === 'asc' ? cmp : -cmp;
			});
		} catch (e) { console.error('[kusto]', e); }
	}

	// Apply X-axis sorting if configured (and no other sort is active)
	const xAxisSettings = st.xAxisSettings || __kustoGetDefaultAxisSettings();
	const yAxisSettings = st.yAxisSettings || __kustoGetDefaultYAxisSettings();
	const xAxisSortDir = xAxisSettings.sortDirection || '';
	
	// Helper to sort rows by a specific column
	const sortRowsByColumn = (rowsToSort: any, colIndex: any, direction: any) => {
		if (colIndex < 0 || !direction) return rowsToSort;
		try {
			return [...rowsToSort].sort((a: any, b: any) => {
				const aVal = (a && a.length > colIndex) ? __kustoGetRawCellValueForChart(a[colIndex]) : null;
				const bVal = (b && b.length > colIndex) ? __kustoGetRawCellValueForChart(b[colIndex]) : null;
				// Handle nulls: sort nulls to the end
				if (aVal === null && bVal === null) return 0;
				if (aVal === null) return 1;
				if (bVal === null) return -1;
				// Try date/time comparison first
				const aTime = __kustoCellToChartTimeMs(aVal);
				const bTime = __kustoCellToChartTimeMs(bVal);
				if (typeof aTime === 'number' && typeof bTime === 'number' && Number.isFinite(aTime) && Number.isFinite(bTime)) {
					return direction === 'asc' ? (aTime - bTime) : (bTime - aTime);
				}
				// Numeric comparison
				const aNum = typeof aVal === 'number' ? aVal : (typeof aVal === 'string' ? parseFloat(aVal) : NaN);
				const bNum = typeof bVal === 'number' ? bVal : (typeof bVal === 'string' ? parseFloat(bVal) : NaN);
				if (!isNaN(aNum) && !isNaN(bNum)) {
					return direction === 'asc' ? (aNum - bNum) : (bNum - aNum);
				}
				// String comparison
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
	// Setting innerHTML destroys ECharts DOM, so we must dispose the instance first.
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
		// Reduce canvas min-height when showing placeholder text to avoid overflow.
		try { canvas.style.minHeight = '60px'; } catch (e) { console.error('[kusto]', e); }
		// Track that we're now showing a message, not a chart
		const isNowRendering = false;
		st.__wasRendering = isNowRendering;
		// Auto-fit section when transitioning from rendering to not-rendering
		if (wasRendering !== isNowRendering) {
			try { __kustoMaximizeChartBox(id); } catch (e) { console.error('[kusto]', e); }
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
	// Restore canvas min-height for actual chart rendering (may have been reduced for placeholder text).
	try { canvas.style.minHeight = '140px'; } catch (e) { console.error('[kusto]', e); }
	try {
		const isDark = __kustoGetIsDarkThemeForEcharts();
		const themeName = isDark ? 'dark' : undefined;
		const prev = st.__echarts && st.__echarts.instance ? st.__echarts : null;
		if (!prev || prev.canvasId !== canvasId || prev.isDark !== isDark) {
			try { if (prev && prev.instance) prev.instance.dispose(); } catch (e) { console.error('[kusto]', e); }
			st.__echarts = { instance: window.echarts.init(canvas, themeName), canvasId, isDark };
			// Canvas changed (Edit <-> Preview). Rebind resize observer.
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
		const __kustoTooltipCommon = {
			// Keep tooltips readable when they have many lines.
			confine: true,
			enterable: true,
			extraCssText: 'max-width:520px; max-height:320px; overflow:auto; pointer-events:auto;'
		};

		const __kustoEscapeHtml = (v: any) => {
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
				// Keep only columns that exist in this dataset.
				const available = new Set(cols.map((c: any) => String(c || '')));
				return normalized.filter((c: any) => available.has(c));
			} catch {
				return [];
			}
		})();

		const __kustoGetTooltipPayloadForRow = (row: any) => {
			try {
				if (!tooltipColNames.length) return null;
				const out: any = {};
				for (const colName of tooltipColNames) {
					const ci = indexOf(colName);
					if (ci < 0) continue;
					const cell = (row && row.length > ci) ? row[ci] : null;
					const raw = __kustoGetRawCellValueForChart(cell);
					if (raw === null || raw === undefined) {
						out[colName] = '';
						continue;
					}
					if (typeof raw === 'number' && Number.isFinite(raw)) {
						out[colName] = __kustoFormatNumber(raw);
						continue;
					}
					out[colName] = __kustoCellToChartString(cell);
				}
				return out;
			} catch {
				return null;
			}
		};

		const __kustoAppendTooltipColumnsHtmlLines = (lines: any, payload: any, indentPx: any) => {
			try {
				if (!payload || !tooltipColNames.length) return;
				// NOTE: Keep tooltip columns aligned with the main lines.
				// (We intentionally do not indent or "tab" these values.)
				for (const colName of tooltipColNames) {
					const rawVal = payload && Object.prototype.hasOwnProperty.call(payload, colName) ? payload[colName] : '';
					const s = String(rawVal ?? '');
					if (!s) continue;
					lines.push(`<span style="opacity:0.85"><strong>${__kustoEscapeHtml(colName)}</strong>: ${__kustoEscapeHtml(s)}</span>`);
				}
			} catch (e) { console.error('[kusto]', e); }
		};

		const legendPosition = __kustoNormalizeLegendPosition(st && st.legendPosition);
		const __kustoBuildLegendOption = (pos: any) => {
			const p = __kustoNormalizeLegendPosition(pos);
			if (p === 'bottom') return { type: 'scroll', bottom: 0, left: 'center', orient: 'horizontal' };
			if (p === 'left') return { type: 'scroll', left: 0, top: 20, orient: 'vertical' };
			if (p === 'right') return { type: 'scroll', right: 0, top: 20, orient: 'vertical' };
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
					const label = (r && r.length > li) ? __kustoCellToChartString(r[li]) : '';
					const value = (r && r.length > vi) ? __kustoCellToChartNumber(r[vi]) : null;
					const tooltipPayload = __kustoGetTooltipPayloadForRow(r);
					return { name: label, value: (typeof value === 'number' && Number.isFinite(value)) ? value : 0, __kustoTooltip: tooltipPayload };
				});
				
				// ========== SMART PIE CHART LABEL CONFIGURATION ==========
				// Custom labeling system with user-controllable density modes
				// Toggle controls on/off, labelMode controls which slices get labels
				
				const labelMode = st.labelMode || 'auto';
				const labelDensity = typeof st.labelDensity === 'number' ? st.labelDensity : 50;
				const showLabels = !!st.showDataLabels; // Controlled by toggle
				const sliceCount = data.length;
				const totalValue = data.reduce((sum: any, d: any) => sum + (d.value || 0), 0);
				
				// Calculate percentages for each slice and their cumulative angles
				const slicesWithPercent = data.map((d: any, i: any) => ({
					index: i,
					percent: totalValue > 0 ? (d.value / totalValue) * 100 : 0,
					value: d.value,
					name: d.name
				}));
				
				// Determine which slices should show labels based on mode
				const sortedByPercent = [...slicesWithPercent].sort((a: any, b: any) => b.percent - a.percent);
				const labelEligibleIndices = new Set();
				
				if (labelMode === 'all') {
					// Show all labels (let overlap handling deal with it)
					slicesWithPercent.forEach((s: any) => labelEligibleIndices.add(s.index));
				} else if (labelMode === 'top5') {
					sortedByPercent.slice(0, 5).forEach((s: any) => labelEligibleIndices.add(s.index));
				} else if (labelMode === 'top10') {
					sortedByPercent.slice(0, 10).forEach((s: any) => labelEligibleIndices.add(s.index));
				} else if (labelMode === 'topPercent') {
					slicesWithPercent.filter((s: any) => s.percent >= 5).forEach((s: any) => labelEligibleIndices.add(s.index));
				} else {
					// 'auto' mode - adaptive thresholds based on slice count AND density slider
					// Density 0 = very sparse (high min%), Density 100 = show most (low min%)
					// Base thresholds adjusted by density
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
					
					// Density adjusts the threshold: 
					// density=100 -> minPercent = 0 (show all)
					// density=50 -> minPercent = baseMinPercent
					// density=0 -> minPercent = baseMinPercent * 2 (very sparse)
					const densityFactor = (100 - labelDensity) / 50; // 0 at density=100, 1 at density=50, 2 at density=0
					const minPercent = baseMinPercent * densityFactor;
					
					slicesWithPercent.filter((s: any) => s.percent >= minPercent).forEach((s: any) => labelEligibleIndices.add(s.index));
				}
				
				// Apply label visibility directly to data items
				// This ensures labelLine is also hidden for non-eligible slices
				data.forEach((d: any, idx: any) => {
					if (!labelEligibleIndices.has(idx)) {
						d.label = { show: false };
						d.labelLine = { show: false };
					}
				});
				
				// Pie sizing - smaller when more slices to give labels more room
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
				
				// Helper to truncate label name with ellipsis
				const maxLabelLength = sliceCount > 15 ? 18 : (sliceCount > 8 ? 25 : 35);
				const truncateName = (name: any, maxLen: any) => {
					if (!name || name.length <= maxLen) return name;
					return name.substring(0, maxLen - 1) + '…';
				};
				
				// Build label configuration
				const labelConfig = {
					show: showLabels,
					position: 'outside',
					fontFamily: 'monospace',
					fontSize: fontSize,
					formatter: (params: any) => {
						try {
							const percent = params && typeof params.percent === 'number' ? params.percent : 0;
							const name = params && params.name ? String(params.name) : '';
							const value = params && typeof params.value === 'number' ? __kustoFormatNumber(params.value) : '';
							const pctStr = percent.toFixed(1) + '%';
							
							const displayName = truncateName(name, maxLabelLength);
							
							// For significant slices (>=5%), show full info
							if (percent >= 5) {
								return displayName + '\n' + value + ' (' + pctStr + ')';
							}
							// For smaller slices, single line
							return displayName + ' (' + pctStr + ')';
						} catch {
							return '';
						}
					}
				};
				
				// Label line configuration
				const labelLineConfig = {
					show: showLabels,
					length: 15,
					length2: 20,
					smooth: 0.2,
					minTurnAngle: 90
				};
				
				// ========== CLOCKWISE OVERLAP-AVOIDING LABEL LAYOUT ==========
				// Places labels clockwise around the pie, adjusting positions to avoid overlap.
				// Non-eligible labels are already hidden via data item's label.show = false.
				
				const placedLabels: any[] = []; // Array of {x, y, width, height, dataIndex, isRightSide}
				const LABEL_PADDING = 4; // Minimum gap between labels
				const SHIFT_STEP = 2; // Pixels to shift each iteration
				const MAX_VERTICAL_SHIFT = 80; // Maximum vertical adjustment
				
				const labelLayoutFn = (params: any) => {
					try {
						const idx = params.dataIndex;
						
						const rect = params.labelRect;
						if (!rect || rect.width === 0) {
							return {};
						}
						
						const width = rect.width;
						const height = rect.height;
						
						// Determine which side of the pie this label is on
						const labelLinePoints = params.labelLinePoints;
						const pieCenter = labelLinePoints?.[0] || [0, 0];
						const labelEnd = labelLinePoints?.[2] || [rect.x, rect.y];
						const isRightSide = labelEnd[0] > pieCenter[0];
						
						// Start at the natural position ECharts calculated
						let x = rect.x;
						let y = rect.y;
						
						// Check for overlap with already placed labels
						const checkOverlap = (testX: any, testY: any) => {
							for (const placed of placedLabels) {
								// AABB collision detection with padding
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
						
						// Find the closest non-overlapping position by shifting vertically
						let overlappingLabel = checkOverlap(x, y);
						let totalShift = 0;
						
						if (overlappingLabel) {
							// Try to find a clear position by shifting up or down
							// Prefer direction away from the overlapping label's center
							const overlapCenterY = overlappingLabel.y + overlappingLabel.height / 2;
							const myPreferredDirection = y < overlapCenterY ? -1 : 1; // -1 = up, 1 = down
							
							let bestY = y;
							let foundClear = false;
							
							// First try preferred direction
							for (let shift = SHIFT_STEP; shift <= MAX_VERTICAL_SHIFT; shift += SHIFT_STEP) {
								const testY = y + (shift * myPreferredDirection);
								if (!checkOverlap(x, testY)) {
									bestY = testY;
									foundClear = true;
									break;
								}
							}
							
							// If preferred direction didn't work, try opposite
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
							
							// Use best position found - if still overlapping, accept it
							// User can adjust density slider to reduce overlaps
							y = bestY;
						}
						
						// Record this label's final position
						placedLabels.push({ x, y, width, height, dataIndex: idx, isRightSide });
						
						return { x, y };
					} catch {
						return {};
					}
				};
				
				option = {
					backgroundColor: 'transparent',
					tooltip: {
						...__kustoTooltipCommon,
						trigger: 'item',
						formatter: (params: any) => {
							try {
								const name = params && params.name ? params.name : '';
								const value = params && typeof params.value === 'number' ? __kustoFormatNumber(params.value) : '';
								const percent = params && typeof params.percent === 'number' ? params.percent.toFixed(1) : '';
								const lines = [`${__kustoEscapeHtml(name)}`, `<strong>${__kustoEscapeHtml(valueColName)}</strong>: ${__kustoEscapeHtml(value)} (${__kustoEscapeHtml(percent)}%)`];
								const payload = params && params.data && params.data.__kustoTooltip ? params.data.__kustoTooltip : null;
								__kustoAppendTooltipColumnsHtmlLines(lines, payload, 0);
								return lines.join('<br/>');
							} catch {
								return '';
							}
						}
					},
					legend: __kustoBuildLegendOption(legendPosition),
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
				// Get sort column index if specified.
				const sortCol = (typeof st.sortColumn === 'string') ? st.sortColumn : '';
				const sortDir = (typeof st.sortDirection === 'string') ? st.sortDirection : '';
				const si = sortCol ? indexOf(sortCol) : -1;
				
				let data = (rows || []).map((r: any, originalIndex: any) => {
					const label = (r && r.length > li) ? __kustoCellToChartString(r[li]) : '';
					const value = (r && r.length > vi) ? __kustoCellToChartNumber(r[vi]) : null;
					const tooltipPayload = __kustoGetTooltipPayloadForRow(r);
					// Store the sort value for sorting later.
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
				
				// Sort data if a sort column is specified.
				if (si >= 0 && sortDir) {
					data.sort((a: any, b: any) => {
						const av = a.__kustoSortValue;
						const bv = b.__kustoSortValue;
						// Handle null/undefined values - push them to the end.
						// eslint-disable-next-line eqeqeq
						if (av == null && bv == null) return 0;
						// eslint-disable-next-line eqeqeq
						if (av == null) return 1;
						// eslint-disable-next-line eqeqeq
						if (bv == null) return -1;
						// Compare values.
						let cmp = 0;
						if (typeof av === 'number' && typeof bv === 'number') {
							cmp = av - bv;
						} else if (typeof av === 'string' && typeof bv === 'string') {
							cmp = av.localeCompare(bv);
						} else if (av instanceof Date && bv instanceof Date) {
							cmp = av.getTime() - bv.getTime();
						} else {
							// Convert to string for comparison.
							cmp = String(av).localeCompare(String(bv));
						}
						return sortDir === 'asc' ? cmp : -cmp;
					});
				}
				
				// Calculate max value for percentage (first step in funnel, which should be the largest)
				const maxValue = data.length > 0 ? Math.max(...data.map((d: any) => d.value)) : 1;
				const showLabels = !!st.showDataLabels;
				option = {
					backgroundColor: 'transparent',
					tooltip: {
						...__kustoTooltipCommon,
						trigger: 'item',
						formatter: (params: any) => {
							try {
								const name = params && params.name ? params.name : '';
								const value = params && typeof params.value === 'number' ? __kustoFormatNumber(params.value) : '';
								const percent = maxValue > 0 && params && typeof params.value === 'number' ? ((params.value / maxValue) * 100).toFixed(1) : '0.0';
								const lines = [`${__kustoEscapeHtml(name)}`, `<strong>${__kustoEscapeHtml(valueColName)}</strong>: ${__kustoEscapeHtml(value)} (${__kustoEscapeHtml(percent)}%)`];
								const payload = params && params.data && params.data.__kustoTooltip ? params.data.__kustoTooltip : null;
								__kustoAppendTooltipColumnsHtmlLines(lines, payload, 0);
								return lines.join('<br/>');
							} catch {
								return '';
							}
						}
					},
					legend: __kustoBuildLegendOption(legendPosition),
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
									const value = params && typeof params.value === 'number' ? __kustoFormatNumber(params.value) : '';
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
			
			// X-axis settings for scatter chart
			const xAxisTitleGap = typeof xAxisSettings.titleGap === 'number' ? xAxisSettings.titleGap : 30;
			
			// Y-axis settings for scatter chart
			const yAxisShowLabel = yAxisSettings.showAxisLabel !== false;
			const yAxisCustomLabel = yAxisSettings.customLabel || '';
			const yAxisName = yAxisShowLabel ? (yAxisCustomLabel || yColName) : '';
			const yAxisMin = yAxisSettings.min;
			const yAxisMax = yAxisSettings.max;
			const yAxisTitleGap = typeof yAxisSettings.titleGap === 'number' ? yAxisSettings.titleGap : 45;
			// Parse min/max: empty string means auto (undefined)
			const yAxisMinValue = (yAxisMin !== '' && yAxisMin !== undefined) ? parseFloat(yAxisMin) : undefined;
			const yAxisMaxValue = (yAxisMax !== '' && yAxisMax !== undefined) ? parseFloat(yAxisMax) : undefined;
			
			if (xi < 0 || yi < 0) {
				showErrorAndReturn('Select columns.');
				return;
			} else {
				const useTime = __kustoInferTimeXAxisFromRows(rows, xi);
				const points = [];
				for (const r of (rows || [])) {
					const x = useTime
						? ((r && r.length > xi) ? __kustoCellToChartTimeMs(r[xi]) : null)
						: ((r && r.length > xi) ? __kustoCellToChartNumber(r[xi]) : null);
					const y = (r && r.length > yi) ? __kustoCellToChartNumber(r[yi]) : null;
					if (typeof x === 'number' && Number.isFinite(x) && typeof y === 'number' && Number.isFinite(y)) {
						points.push({ value: [x, y], __kustoTooltip: __kustoGetTooltipPayloadForRow(r) });
					}
				}
				// Only sort by X for stable left-to-right plotting if no user sort is specified.
				// When user specifies a sort, the rows are already sorted and we preserve that order.
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
				const showTime = useTime ? __kustoShouldShowTimeForUtcAxis(points.map((p: any) => {
					try {
						const v = p && p.value ? p.value : null;
						return v && v.length ? v[0] : null;
					} catch { return null; }
				})) : false;
				const rotate = useTime ? __kustoComputeTimeAxisLabelRotation(canvasWidthPx, points.length, showTime) : 0;
				const axisFontSize = __kustoComputeAxisFontSize(points.length, canvasWidthPx, false);
				// Calculate bottom margin for rotated labels and X-axis title gap.
				const bottomMargin = (rotate > 30 ? 45 : 25) + xAxisTitleGap;
				// Calculate left margin for Y-axis title gap.
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
						...__kustoTooltipCommon,
						trigger: 'item',
						formatter: (params: any) => {
							try {
								const v = params && params.value ? params.value : null;
								const x = v && v.length ? v[0] : null;
								const y = v && v.length > 1 ? v[1] : null;
								const xStr = useTime ? __kustoFormatUtcDateTime(x, showTime) : __kustoFormatNumber(x);
								const yStr = __kustoFormatNumber(y);
								const lines = [`<strong>${__kustoEscapeHtml(xColName)}</strong>: ${__kustoEscapeHtml(xStr)}`, `<strong>${__kustoEscapeHtml(yColName)}</strong>: ${__kustoEscapeHtml(yStr)}`];
								const payload = params && params.data && params.data.__kustoTooltip ? params.data.__kustoTooltip : null;
								__kustoAppendTooltipColumnsHtmlLines(lines, payload, 0);
								return lines.join('<br/>');
							} catch {
								return '';
							}
						}
					},
					xAxis: useTime ? {
						type: 'time',
						name: xColName,
						nameLocation: 'middle',
						nameGap: xAxisTitleGap,
						axisLabel: {
							rotate,
							fontSize: axisFontSize,
							fontFamily: 'monospace',
							formatter: (value: any) => __kustoFormatUtcDateTime(value, showTime)
						},
						axisPointer: { label: { formatter: (p: any) => __kustoFormatUtcDateTime(p && p.value, showTime) } }
					} : {
						type: 'value',
						name: xColName,
						nameLocation: 'middle',
						nameGap: xAxisTitleGap,
						axisLabel: {
							fontSize: axisFontSize,
							fontFamily: 'monospace',
							formatter: (value: any) => __kustoFormatNumber(value)
						}
					},
					yAxis: {
						type: 'value',
						name: yAxisName,
						nameLocation: 'middle',
						nameGap: yAxisTitleGap,
						min: Number.isFinite(yAxisMinValue) ? yAxisMinValue : undefined,
						max: Number.isFinite(yAxisMaxValue) ? yAxisMaxValue : undefined,
						axisLabel: {
							fontSize: 11,
							fontFamily: 'monospace',
							formatter: (value: any) => __kustoFormatNumber(value)
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
									// Only show label for ~10% of data points to reduce clutter
									const idx = params && typeof params.dataIndex === 'number' ? params.dataIndex : 0;
									const total = points.length || 1;
									const interval = Math.max(1, Math.floor(total / 10));
									if (idx % interval !== 0) return '';
									const v = params && params.value ? params.value : null;
									const y = v && v.length > 1 ? v[1] : null;
									return __kustoFormatNumber(y);
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
			
			// Get Y columns (support multi-select or fallback to single).
			let yCols = Array.isArray(st.yColumns) && st.yColumns.length ? st.yColumns : (st.yColumn ? [st.yColumn] : []);
			// Filter to valid columns only.
			yCols = yCols.filter((c: any) => indexOf(c) >= 0);
			
			if (xi < 0 || !yCols.length) {
				showErrorAndReturn('Select columns.');
				return;
			} else {
				const isArea = chartType === 'area';
				const useTime = __kustoInferTimeXAxisFromRows(rows, xi);
				
				// X-axis settings for sort, scale, label density, etc.
				const xAxisSortDirection = xAxisSettings.sortDirection || '';
				const xAxisScaleType = xAxisSettings.scaleType || '';
				const xAxisLabelDensity = xAxisSettings.labelDensity || '';
				const xAxisShowLabel = xAxisSettings.showAxisLabel !== false;
				const xAxisCustomLabel = xAxisSettings.customLabel || '';
				const xAxisName = xAxisShowLabel ? (xAxisCustomLabel || xColName) : '';
				const xAxisTitleGap = typeof xAxisSettings.titleGap === 'number' ? xAxisSettings.titleGap : 30;
				
				// Y-axis settings for axis title, min, max
				const yAxisShowLabel = yAxisSettings.showAxisLabel !== false;
				const yAxisCustomLabel = yAxisSettings.customLabel || '';
				const yAxisMin = yAxisSettings.min;
				const yAxisMax = yAxisSettings.max;
				const yAxisTitleGap = typeof yAxisSettings.titleGap === 'number' ? yAxisSettings.titleGap : 45;
				// Parse min/max: empty string means auto (undefined)
				const yAxisMinValue = (yAxisMin !== '' && yAxisMin !== undefined) ? parseFloat(yAxisMin) : undefined;
				const yAxisMaxValue = (yAxisMax !== '' && yAxisMax !== undefined) ? parseFloat(yAxisMax) : undefined;
				// Series colors
				const seriesColors = (yAxisSettings.seriesColors && typeof yAxisSettings.seriesColors === 'object') ? yAxisSettings.seriesColors : {};
				
				// Scale type settings:
				// - Auto/Categorical: show all individual values (auto-detect time handling)
				// - Continuous: for time data, show period-based labels (week/month/quarter/year)
				const useContinuousLabels = useTime && xAxisScaleType === 'continuous';
				
				// treatAsTime controls data grouping behavior (based on auto-detection)
				const treatAsTime = useTime;
				
					let timeKeys: any[] = [];
					let timeLabels: any[] = [];
					let timeTooltipLabels: any[] = []; // Always contains full date/time for tooltips
					let timeShowTime = false;
					let timePeriodGranularity = 'day';
					if (treatAsTime) {
						try {
							const all = [];
							for (const r of (rows || [])) {
								const t = (r && r.length > xi) ? __kustoCellToChartTimeMs(r[xi]) : null;
								if (typeof t === 'number' && Number.isFinite(t)) all.push(t);
							}
							// Sort based on X-axis sort direction setting
							if (xAxisSortDirection === 'desc') {
								all.sort((a: any, b: any) => b - a);
							} else {
								// Default: ascending (oldest to newest)
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
							timeShowTime = __kustoShouldShowTimeForUtcAxis(timeKeys);
							
							// Always generate full labels for tooltips
							timeTooltipLabels = timeKeys.map((t: any) => __kustoFormatUtcDateTime(t, timeShowTime));
							
							// Generate labels based on scale type
							if (useContinuousLabels) {
								// Continuous: show aggregated period labels (week/month/quarter/year)
								timePeriodGranularity = __kustoComputeTimePeriodGranularity(timeKeys);
								timeLabels = __kustoGenerateContinuousTimeLabels(timeKeys, timePeriodGranularity);
							} else {
								// Categorical or Auto: show all individual timestamps
								timeLabels = timeTooltipLabels;
							}
						} catch (e) { console.error('[kusto]', e); }
					}
				
				// Build series based on legend grouping or multiple Y columns.
				let seriesData: any[] = [];
				let xLabelsSet = new Set();
				
				// Helper to get color for a series (by column name or series index)
				const getSeriesColor = (name: any, index: any) => {
					if (seriesColors[name]) return seriesColors[name];
					return undefined; // Let ECharts use default
				};
				
				if (li >= 0 && yCols.length === 1) {
					// Legend grouping: group data by legend column values.
					const yi = indexOf(yCols[0]);
					const yColName = yCols[0] || 'Y';
					const groups: any = {};
					for (const r of (rows || [])) {
						const legendValue = (r && r.length > li) ? __kustoCellToChartString(r[li]) : '(empty)';
						const xVal = treatAsTime
							? ((r && r.length > xi) ? __kustoCellToChartTimeMs(r[xi]) : null)
							: ((r && r.length > xi) ? __kustoCellToChartString(r[xi]) : '');
						const yVal = (r && r.length > yi) ? __kustoCellToChartNumber(r[yi]) : null;
						const tt = __kustoGetTooltipPayloadForRow(r);
						if (!groups[legendValue]) groups[legendValue] = [];
						groups[legendValue].push({ x: xVal, y: yVal, tt });
						if (treatAsTime) {
							// For time axis, collect all x values.
						} else {
							xLabelsSet.add(xVal);
						}
					}
					const legendNames = Object.keys(groups).sort();
					
					if (treatAsTime) {
							// Time-based X axis with legend grouping (render as category labels so all values show).
						for (const legendName of legendNames) {
							const pts = groups[legendName] || [];
							// Sort by time.
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
									// Use timeTooltipLabels for full date, not timeLabels which may be empty in continuous mode
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
												return __kustoFormatNumber(v);
										} catch {
											return '';
										}
									}
								}
							});
						}
					} else {
						// Category X axis with legend grouping.
						const xLabels = Array.from(xLabelsSet);
						for (const legendName of legendNames) {
							const pts = groups[legendName] || [];
							// Map to x labels order.
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
											return (typeof v === 'number') ? __kustoFormatNumber(v) : '';
										} catch {
											return '';
										}
									}
								}
							});
						}
					}
				} else {
					// Multiple Y columns (no legend grouping, or legend not set).
					for (const yCol of yCols) {
						const yi = indexOf(yCol);
						if (yi < 0) continue;
						
						if (treatAsTime) {
								const map: any = {};
								const tmap: any = {};
								for (const r of (rows || [])) {
									const x = (r && r.length > xi) ? __kustoCellToChartTimeMs(r[xi]) : null;
									const y = (r && r.length > yi) ? __kustoCellToChartNumber(r[yi]) : null;
									if (typeof x === 'number' && Number.isFinite(x)) {
										const key = String(x);
										map[key] = y;
										if (!(key in tmap)) tmap[key] = __kustoGetTooltipPayloadForRow(r);
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
									// Use timeTooltipLabels for full date, not timeLabels which may be empty in continuous mode
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
												return __kustoFormatNumber(v);
										} catch {
											return '';
										}
									}
								}
							});
						} else {
							for (const r of (rows || [])) {
								const xVal = (r && r.length > xi) ? __kustoCellToChartString(r[xi]) : '';
								xLabelsSet.add(xVal);
							}
							const xLabels = Array.from(xLabelsSet);
							const yData = (rows || []).map((r: any) => (r && r.length > yi) ? __kustoCellToChartNumber(r[yi]) : null);
							const ttData = (rows || []).map((r: any) => __kustoGetTooltipPayloadForRow(r));
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
											return (typeof v === 'number') ? __kustoFormatNumber(v) : '';
										} catch {
											return '';
										}
									}
								}
							});
						}
					}
				}
				
				// Build final xLabels with sorting applied
				let xLabels = treatAsTime ? timeLabels : Array.from(xLabelsSet);
				
				// Apply X-axis sort direction to category labels if not time-based
				if (!treatAsTime && xAxisSortDirection) {
					try {
						// Try to detect if labels are numeric for better sorting
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
						
						// Re-order series data to match new label order if needed
						// This is complex and depends on how series data was built
						// For now, we'll rebuild series data maps with the new order
					} catch (e) { console.error('[kusto]', e); }
				}
				
				const showTime = treatAsTime ? timeShowTime : false;
				// Compute rotation based on label content.
				// - Time + continuous: estimate from period label lengths
				// - Time + categorical: use dedicated time rotation heuristic
				// - Non-time categories: measure actual label strings
				let rotate;
				let __categoryLabelStats = null;
				if (treatAsTime) {
					if (useContinuousLabels) {
						// Period labels vary in length (e.g. "Jan 2025", "Q3 2024"), measure them
						__categoryLabelStats = __kustoMeasureLabelChars(xLabels);
						rotate = __kustoComputeCategoryLabelRotation(canvasWidthPx, xLabels.length, __categoryLabelStats.avgLabelChars, __categoryLabelStats.maxLabelChars);
					} else {
						rotate = __kustoComputeTimeAxisLabelRotation(canvasWidthPx, xLabels.length, showTime);
					}
				} else {
					__categoryLabelStats = __kustoMeasureLabelChars(xLabels);
					rotate = __kustoComputeCategoryLabelRotation(canvasWidthPx, xLabels.length, __categoryLabelStats.avgLabelChars, __categoryLabelStats.maxLabelChars);
				}
				const axisFontSize = __kustoComputeAxisFontSize(xLabels.length, canvasWidthPx, false);
				
				// Calculate label interval based on density slider (100 = show all, 1 = minimum density with first & last always shown)
				let axisLabelInterval: any = 0; // Default: show all
				const densityValue = typeof xAxisLabelDensity === 'number' ? Math.max(1, xAxisLabelDensity) : 100;
				const totalLabels = xLabels.length;
				if (densityValue < 100) {
					// Map 1-99 to skip intervals: lower density value = more labels skipped
					// But always show first and last labels
					const skipFactor = (100 - densityValue) / 100;
					const maxInterval = Math.max(2, totalLabels - 1);
					const interval = Math.max(1, Math.floor(maxInterval * skipFactor));
					axisLabelInterval = (index: any) => {
						// Always show first and last
						if (index === 0 || index === totalLabels - 1) return true;
						// Show based on interval
						return index % (interval + 1) === 0;
					};
				}
				// else densityValue >= 100, show all labels (interval = 0)
				
				// Calculate bottom margin for rotated labels and X-axis title gap.
				const bottomMargin = (rotate > 30 ? 45 : 15) + xAxisTitleGap;
				
				const legendEnabled = seriesData.length > 1;
				const legendOpt = legendEnabled ? __kustoBuildLegendOption(legendPosition) : undefined;
				// Calculate left margin for Y-axis title gap.
				const gridLeft = (legendEnabled && legendPosition === 'left') ? 140 : (15 + yAxisTitleGap);
				const gridRight = (legendEnabled && legendPosition === 'right') ? 140 : 20;
				const gridTop = legendEnabled && legendPosition === 'top' ? 50 : 20;
				const gridBottom = bottomMargin + (legendEnabled && legendPosition === 'bottom' ? 40 : 0);

				option = {
					backgroundColor: 'transparent',
					grid: {
						left: gridLeft,
						right: gridRight,
						top: gridTop,
						bottom: gridBottom,
						containLabel: false
					},
					legend: legendOpt,
					tooltip: {
						...__kustoTooltipCommon,
						trigger: 'axis',
						axisPointer: {
							type: 'shadow',
							snap: true
						},
						formatter: (params: any) => {
							try {
								const arr = Array.isArray(params) ? params : (params ? [params] : []);
								const first = arr.length ? arr[0] : null;
								// Use multiple fallbacks: axisValue, axisValueLabel, data.name (embedded in data point)
								// Note: first.name is the SERIES name, not the x-axis value, so use data.name instead
								let axisValue = first ? (first.axisValue ?? first.axisValueLabel ?? (first.data && first.data.name)) : null;
									const title = String(axisValue || '');
								let lines = [`<strong>${__kustoEscapeHtml(xColName)}</strong>: ${__kustoEscapeHtml(title)}`];

								// Tooltip columns are intended to show contextual fields for the hovered x-value.
								// Render them once (not repeated under each series entry).
								let tooltipPayloadOnce = null;
								try {
									for (const p of arr) {
										const rawData = p && p.data ? p.data : null;
										const payload = rawData && rawData.__kustoTooltip ? rawData.__kustoTooltip : null;
										if (payload) {
											tooltipPayloadOnce = payload;
											break;
										}
									}
								} catch (e) { console.error('[kusto]', e); }
								__kustoAppendTooltipColumnsHtmlLines(lines, tooltipPayloadOnce, 0);

								for (const p of arr) {
									const seriesName = p && p.seriesName ? p.seriesName : '';
									const rawData = p && p.data ? p.data : null;
									const v = rawData ? (Array.isArray(rawData) ? rawData[1] : (rawData.value !== undefined ? rawData.value : rawData)) : '';
									const formatted = (typeof v === 'number') ? __kustoFormatNumber(v) : String(v ?? '');
									lines.push(`<strong>${__kustoEscapeHtml(seriesName)}</strong>: ${__kustoEscapeHtml(formatted)}`);
								}
								return lines.join('<br/>');
							} catch {
								return '';
							}
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
						nameGap: yAxisTitleGap,
						min: Number.isFinite(yAxisMinValue) ? yAxisMinValue : undefined,
						max: Number.isFinite(yAxisMaxValue) ? yAxisMaxValue : undefined,
						axisLabel: {
							fontSize: 11,
							fontFamily: 'monospace',
							formatter: (value: any) => __kustoFormatNumber(value)
						}
					},
					series: seriesData
				};
				
				if (treatAsTime && !useContinuousLabels) {
						st.__lastTimeAxis = { showTime, labelCount: xLabels.length, rotate };
						try { delete st.__lastCategoryAxis; } catch (e) { console.error('[kusto]', e); }
				} else {
					try { delete st.__lastTimeAxis; } catch (e) { console.error('[kusto]', e); }
					// Store category label stats so the resize observer can recompute rotation.
					if (__categoryLabelStats) {
						st.__lastCategoryAxis = {
							labelCount: xLabels.length,
							avgLabelChars: __categoryLabelStats.avgLabelChars,
							maxLabelChars: __categoryLabelStats.maxLabelChars,
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
		// Clear any text nodes (error messages) without destroying ECharts child elements.
		for (const child of Array.from(canvas.childNodes) as any[]) {
			if (child.nodeType === Node.TEXT_NODE) {
				canvas.removeChild(child);
			}
		}
		inst.setOption(option || {}, true);
		
		// Track that we're now rendering a chart
		const isNowRendering = true;
		// Auto-expand section when transitioning from not-rendering to rendering a chart
		// This makes the chart nicely visible so the user can continue configuring settings.
		if (!wasRendering && isNowRendering) {
			try {
				const wrapper = document.getElementById(id + '_chart_wrapper') as any;
				if (wrapper && !wrapper.dataset.kustoUserResized) {
					// Set a nice default height for viewing the chart (360px is good for visibility)
					const defaultChartHeight = 360;
					wrapper.style.height = defaultChartHeight + 'px';
					
					// Force the outer section box to recalculate its layout
					// This ensures the section border moves to contain the expanded chart
					const sectionBox = document.getElementById(id) as any;
					if (sectionBox) {
						// Trigger a reflow by temporarily modifying the display
						sectionBox.style.display = 'none';
						// Force reflow
						void sectionBox.offsetHeight;
						sectionBox.style.display = '';
					}
					
					// Resize the ECharts instance to fit the new container size
					requestAnimationFrame(() => {
						try { inst.resize(); } catch (e) { console.error('[kusto]', e); }
					});
					try { schedulePersist(); } catch (e) { console.error('[kusto]', e); }
				}
			} catch (e) { console.error('[kusto]', e); }
		}
		st.__wasRendering = isNowRendering;
	} catch (e) { console.error('[kusto]', e); }
	try {
		requestAnimationFrame(() => {
			try { inst.resize(); } catch (e) { console.error('[kusto]', e); }
		});
	} catch (e) { console.error('[kusto]', e); }

	// Keep the chart responsive to wrapper/canvas resizes.
	try {
		if (!st.__resizeObserver && typeof ResizeObserver !== 'undefined') {
			st.__resizeObserver = new ResizeObserver(() => {
				try { inst.resize(); } catch (e) { console.error('[kusto]', e); }
				try {
					const w = canvas && typeof canvas.clientWidth === 'number' ? canvas.clientWidth : 0;
					if (st.__lastTimeAxis) {
						const rotate = __kustoComputeTimeAxisLabelRotation(w, st.__lastTimeAxis.labelCount, st.__lastTimeAxis.showTime);
						if (rotate !== st.__lastTimeAxis.rotate) {
							st.__lastTimeAxis.rotate = rotate;
							try {
								inst.setOption({ xAxis: { axisLabel: { rotate } } });
							} catch (e) { console.error('[kusto]', e); }
						}
					} else if (st.__lastCategoryAxis) {
						const ca = st.__lastCategoryAxis;
						const rotate = __kustoComputeCategoryLabelRotation(w, ca.labelCount, ca.avgLabelChars, ca.maxLabelChars);
						if (rotate !== ca.rotate) {
							ca.rotate = rotate;
							try {
								inst.setOption({ xAxis: { axisLabel: { rotate } } });
							} catch (e) { console.error('[kusto]', e); }
						}
					}
				} catch (e) { console.error('[kusto]', e); }
			});
			try { st.__resizeObserver.observe(canvas); } catch (e) { console.error('[kusto]', e); }
			try {
				const wrapper = document.getElementById(id + '_chart_wrapper') as any;
				if (wrapper) st.__resizeObserver.observe(wrapper);
			} catch (e) { console.error('[kusto]', e); }
		}
	} catch (e) { console.error('[kusto]', e); }
}


export function __kustoMaximizeChartBox( boxId: any) {
	try {
		const wrapper = document.getElementById(boxId + '_chart_wrapper') as any;
		if (!wrapper) return;
		
		const st = __kustoGetChartState(boxId);
		
		// If a chart is currently rendered, use the standard chart viewing height (600px)
		// Otherwise, use the minimum height for showing the placeholder/error message
		const isChartRendered = st && st.__echarts && st.__echarts.instance && st.__wasRendering;
		const targetHeight = isChartRendered 
			? 360  // Same as the default height when first rendering a chart
			: (typeof __kustoGetChartMinResizeHeight === 'function' ? __kustoGetChartMinResizeHeight(boxId) : 80);
		
		// Apply the calculated height
		wrapper.style.height = Math.ceil(targetHeight) + 'px';
		try { delete wrapper.dataset.kustoUserResized; } catch (e) { console.error('[kusto]', e); }
		
		// NOTE: Do NOT call __kustoRenderChart here - it would create an infinite loop
		// because __kustoRenderChart calls __kustoMaximizeChartBox on state transitions.
		// The chart will be rendered by the caller that triggered the state transition.
		// Instead, just resize the existing ECharts instance if one exists.
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

export function addChartBox( options: any) {
	const id = (options && options.id) ? String(options.id) : ('chart_' + Date.now());
	chartBoxes.push(id);
	const st = __kustoGetChartState(id);
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
		st.xAxisSettings = { ...__kustoGetDefaultAxisSettings(), ...st.xAxisSettings, ...options.xAxisSettings };
	}
	if (options && options.yAxisSettings && typeof options.yAxisSettings === 'object') {
		st.yAxisSettings = { ...__kustoGetDefaultYAxisSettings(), ...st.yAxisSettings, ...options.yAxisSettings };
	}

	const container = document.getElementById('queries-container') as any;
	if (!container) return;

	// ── Create Lit element as primary ──
	const litEl = document.createElement('kw-chart-section');
	litEl.id = id;
	litEl.setAttribute('box-id', id);
	if (options && typeof options.editorHeightPx === 'number') {
		litEl.setAttribute('editor-height-px', String(options.editorHeightPx));
	}

	// Create light-DOM wrapper + canvas elements for ECharts (cannot render in shadow DOM).
	// The wrapper must have `id = id + '_chart_wrapper'` so __kustoRenderChart can find it.
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
				try { __kustoMaximizeChartBox(id); } catch (e) { console.error('[kusto]', e); }
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
				const minH = typeof __kustoGetChartMinResizeHeight === 'function' ? __kustoGetChartMinResizeHeight(id) : 80;
				const maxH = 900;
				const onMove = (moveEvent: any) => {
					try {
						maybeAutoScrollWhileDragging(moveEvent.clientY);
					} catch (e) { console.error('[kusto]', e); }
					const pageY = moveEvent.clientY + getScrollY();
					const delta = pageY - startPageY;
					const currentMinH = typeof __kustoGetChartMinResizeHeight === 'function' ? __kustoGetChartMinResizeHeight(id) : 80;
					const nextHeight = Math.max(currentMinH, Math.min(maxH, startHeight + delta));
					chartWrapper.style.height = nextHeight + 'px';
					try { __kustoRenderChart(id); } catch (e) { console.error('[kusto]', e); }
				};
				const onUp = () => {
					document.removeEventListener('mousemove', onMove, true);
					document.removeEventListener('mouseup', onUp, true);
					resizerEl.classList.remove('is-dragging');
					document.body.style.cursor = prevCursor;
					document.body.style.userSelect = prevUserSelect;
					try { schedulePersist(); } catch (e) { console.error('[kusto]', e); }
					try { __kustoRenderChart(id); } catch (e) { console.error('[kusto]', e); }
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
	try { __kustoDisposeChartEcharts(boxId); } catch (e) { console.error('[kusto]', e); }
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



