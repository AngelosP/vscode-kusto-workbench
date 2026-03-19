// Extra boxes module — converted from legacy/extraBoxes.js
// Chart, Transformation, Markdown, URL, Python box creation + ECharts rendering.
// Window bridge exports at bottom for remaining legacy callers.
export {};

// Sub-modules (Phase 6 decomposition) — import ensures esbuild includes them in bundle.
// NOTE: Sub-modules initialize their own state on window (chartStateByBoxId, etc.)
// before reading it, so import order is safe regardless of hoisting.
import './extraBoxes-chart';
import './extraBoxes-transformation';
import './extraBoxes-markdown';

import {
	getRawCellValue as _getRawCellValue,
	cellToChartString as _cellToChartString,
	cellToChartNumber as _cellToChartNumber,
	cellToChartTimeMs as _cellToChartTimeMs,
	inferTimeXAxisFromRows as _inferTimeXAxisFromRows,
	normalizeResultsColumnName as _normalizeResultsColumnName,
	pickFirstNonEmpty as _pickFirstNonEmpty,
} from '../shared/data-utils.js';
import { escapeHtml, getScrollY, maybeAutoScrollWhileDragging } from './utils';
import { getResultsState, getRawCellValue as _getRawCellValueFromState } from './resultsState';
import { closeAllMenus as _closeAllDropdownMenus } from './dropdown';

const _win = window;
// Additional section types for the Kusto Query Editor webview:
// - Markdown: Monaco editor while focused; rendered markdown viewer on blur
// - Python: Monaco editor + Run button; output viewer
// - URL: URL input + expand/collapse content viewer; content fetched by extension host
// - Transformation: Data manipulation section (derive, summarize, pivot, etc.)

// Sub-module box arrays are initialized on window in their respective files
// (extraBoxes-markdown.ts, extraBoxes-chart.ts, extraBoxes-transformation.ts).
// Read references from window so all modules share the same arrays.
let markdownBoxes: any[] = window.__kustoMarkdownBoxes || [];
let chartBoxes: any[] = window.__kustoChartBoxes || [];
let transformationBoxes: any[] = window.__kustoTransformationBoxes || [];

// Python and URL boxes are managed in this file (not sub-modules).
let pythonBoxes: any[] = [];
let urlBoxes: any[] = [];
window.__kustoPythonBoxes = pythonBoxes;
window.__kustoUrlBoxes = urlBoxes;

// Expose markdownEditors on window so main.js can access it for tool handlers
window.__kustoMarkdownEditors = window.__kustoMarkdownEditors || {};
let markdownEditors = window.__kustoMarkdownEditors;
let markdownViewers: any = {};
let pythonEditors: any = {};
try { window.__kustoPythonEditors = pythonEditors; } catch (e) { console.error('[kusto]', e); }

// Chart UI state keyed by boxId.
// - mode: 'edit' | 'preview'
// - expanded: boolean (show/hide)
// - dataSourceId: boxId of the data source section
// - chartType: 'line' | 'area' | 'bar' | 'scatter' | 'pie' | 'funnel'
// - xColumn/yColumn: for line/area/bar/scatter
// - labelColumn/valueColumn: for pie/funnel
// - tooltipColumns: string[] (columns to show in tooltip)
// - showDataLabels: boolean (show labels on data points)
// - sortColumn: string (column to sort by, for funnel chart only)
// - sortDirection: 'asc' | 'desc' | '' (sort direction, for funnel chart only)
// - xAxisSettings: { sortDirection, scaleType, labelDensity, showAxisLabel, customLabel, titleGap } (X-axis customizations)
// - yAxisSettings: { showAxisLabel, customLabel, min, max, seriesColors, titleGap } (Y-axis customizations)
// Explicitly on window so persistence.js can access it
window.chartStateByBoxId = window.chartStateByBoxId || {};
const chartStateByBoxId = window.chartStateByBoxId;

// Transformation UI state keyed by boxId.
// Explicitly on window so persistence.js can access it
window.transformationStateByBoxId = window.transformationStateByBoxId || {};
const transformationStateByBoxId = window.transformationStateByBoxId;

// When query/transform results update, refresh dependent charts/transformations.
let __kustoIsRefreshingDependents = false;
let __kustoPendingDependentRefreshIds: Set<string> = new Set();
let __kustoDependentRefreshTimer: any = null;

function __kustoRefreshDependentExtraBoxes( rootSourceId: any) {
	const root = String(rootSourceId || '');
	if (!root) return;
	if (__kustoIsRefreshingDependents) return;
	__kustoIsRefreshingDependents = true;
	try {
		const queue = [root];
		const visitedSources = new Set();
		const visitedTransformations = new Set();

		while (queue.length) {
			const sourceId = String(queue.shift() || '');
			if (!sourceId || visitedSources.has(sourceId)) {
				continue;
			}
			visitedSources.add(sourceId);

			// Refresh transformations first (they produce new datasets other charts/transforms may depend on).
			try {
				if (transformationStateByBoxId && typeof transformationStateByBoxId === 'object') {
					for (const [boxId, st] of Object.entries(transformationStateByBoxId)) {
						if (!st || typeof st !== 'object') continue;
						const ds = (typeof (st as any).dataSourceId === 'string') ? String((st as any).dataSourceId) : '';
						if (ds !== sourceId) continue;
						if (visitedTransformations.has(boxId)) continue;
						visitedTransformations.add(boxId);
						try { _win.__kustoUpdateTransformationBuilderUI(boxId); } catch (e) { console.error('[kusto]', e); }
						try { _win.__kustoRenderTransformation(boxId); } catch (e) { console.error('[kusto]', e); }
						queue.push(boxId);
					}
				}
			} catch (e) { console.error('[kusto]', e); }

			// Refresh charts that directly depend on this source.
			try {
				if (chartStateByBoxId && typeof chartStateByBoxId === 'object') {
					for (const [boxId, st] of Object.entries(chartStateByBoxId)) {
						if (!st || typeof st !== 'object') continue;
						const ds = (typeof (st as any).dataSourceId === 'string') ? String((st as any).dataSourceId) : '';
						if (ds !== sourceId) continue;
						try { _win.__kustoUpdateChartBuilderUI(boxId); } catch (e) { console.error('[kusto]', e); }
						try { _win.__kustoRenderChart(boxId); } catch (e) { console.error('[kusto]', e); }
					}
				}
			} catch (e) { console.error('[kusto]', e); }
		}
	} finally {
		__kustoIsRefreshingDependents = false;
	}
}

try {
	window.__kustoRefreshDependentExtraBoxes = __kustoRefreshDependentExtraBoxes;
	window.__kustoNotifyResultsUpdated = (boxId: any) => {
		try {
			const id = String(boxId || '');
			if (!id) return;
			// Avoid recursion: transformation renders update results too.
			if (__kustoIsRefreshingDependents) return;
			__kustoPendingDependentRefreshIds.add(id);
			if (__kustoDependentRefreshTimer) return;
			__kustoDependentRefreshTimer = setTimeout(() => {
				__kustoDependentRefreshTimer = null;
				const pending = Array.from(__kustoPendingDependentRefreshIds);
				__kustoPendingDependentRefreshIds = new Set();
				for (const rootId of pending) {
					try { __kustoRefreshDependentExtraBoxes(rootId); } catch (e) { console.error('[kusto]', e); }
				}
				// After dependent sections are refreshed, update all data-source dropdowns
				// so newly-available sources (e.g. a transformation that just produced results)
				// appear in chart/transformation pickers.
				try { __kustoRefreshAllDataSourceDropdowns(); } catch (e) { console.error('[kusto]', e); }
			}, 0);
		} catch (e) { console.error('[kusto]', e); }
	};
} catch (e) { console.error('[kusto]', e); }

// SVG icons for chart types
function __kustoGetChartDatasetsInDomOrder() {
	const out = [];
	try {
		const container = document.getElementById('queries-container') as any;
		const children = container ? Array.from(container.children || []) as any[] : [];
		// Calculate position among all sections (1-based)
		let sectionIndex = 0;
		for (const child of children) {
			try {
				const id = child && child.id ? String(child.id) : '';
				if (!id) continue;
				// Count all section types for consistent numbering
				if (id.startsWith('query_') || id.startsWith('markdown_') || id.startsWith('python_') || id.startsWith('url_') || id.startsWith('chart_') || id.startsWith('transformation_') || id.startsWith('copilotQuery_')) {
					sectionIndex++;
				}
				// Only include sections that can be data sources
				if (!(id.startsWith('query_') || id.startsWith('url_') || id.startsWith('transformation_'))) continue;
				const st = getResultsState(id);
				const cols = st && Array.isArray(st.columns) ? st.columns : [];
				const rows = st && Array.isArray(st.rows) ? st.rows : [];
				if (!cols.length) continue;
				let name = '';
				try {
					name = String(((document.getElementById(id + '_name') as any || {}).value || '')).trim();
				} catch (e) { console.error('[kusto]', e); }
				// Format: "<Name> [section #N]" if named, "Unnamed [section #N]" if not
				const label = name
					? name + ' [section #' + sectionIndex + ']'
					: 'Unnamed [section #' + sectionIndex + ']';
				out.push({
					id,
					label,
					columns: cols,
					rows
				});
			} catch (e) { console.error('[kusto]', e); }
		}
	} catch (e) { console.error('[kusto]', e); }
	return out;
}

/**
 * Refresh all Chart and Transformation section Data dropdowns.
 * Call this after sections are reordered, added, or removed to update position labels.
 */
function __kustoRefreshAllDataSourceDropdowns() {
	try {
		const container = document.getElementById('queries-container') as any;
		if (!container) return;
		const children = Array.from(container.children || []) as any[];
		for (const child of children) {
			try {
				const id = child && child.id ? String(child.id) : '';
				if (!id) continue;
				if (id.startsWith('chart_')) {
					_win.__kustoUpdateChartBuilderUI(id);
				} else if (id.startsWith('transformation_')) {
					_win.__kustoUpdateTransformationBuilderUI(id);
				}
			} catch (e) { console.error('[kusto]', e); }
		}
	} catch (e) { console.error('[kusto]', e); }
}

// Expose globally for use by main.js reorder logic
try { window.__kustoRefreshAllDataSourceDropdowns = __kustoRefreshAllDataSourceDropdowns; } catch (e) { console.error('[kusto]', e); }

/**
 * Configure a chart section programmatically (used by LLM tools).
 * @param {string} boxId - The chart section ID
 * @param {object} config - Configuration object with properties like:
 *   - dataSourceId: string (ID of the data source section)
 *   - chartType: 'line' | 'area' | 'bar' | 'scatter' | 'pie' | 'funnel'
 *   - xColumn: string (for line/area/bar/scatter)
 *   - yColumns: string[] (for line/area/bar/scatter)
 *   - labelColumn: string (for pie/funnel)
 *   - valueColumn: string (for pie/funnel)
 *   - legendColumn: string (for multi-series charts)
 *   - tooltipColumns: string[]
 *   - showDataLabels: boolean
 *   - legendPosition: 'top' | 'bottom' | 'left' | 'right' | 'none'
 */
function __kustoConfigureChartFromTool( boxId: any, config: any) {
	try {
		const id = String(boxId || '');
		if (!id) return false;
		if (!config || typeof config !== 'object') return false;
		
		// Ensure state object exists
		const st = _win.__kustoGetChartState(id);
		if (!st) return false;
		
		// Apply configuration properties
		if (typeof config.dataSourceId === 'string') {
			st.dataSourceId = config.dataSourceId;
		}
		if (typeof config.chartType === 'string') {
			st.chartType = config.chartType;
		}
		if (typeof config.xColumn === 'string') {
			st.xColumn = config.xColumn;
		}
		if (Array.isArray(config.yColumns)) {
			st.yColumns = config.yColumns.map((c: any) => String(c));
		} else if (typeof config.yColumn === 'string') {
			// Support single yColumn for backwards compat
			st.yColumns = [config.yColumn];
		}
		if (typeof config.labelColumn === 'string') {
			st.labelColumn = config.labelColumn;
		}
		if (typeof config.valueColumn === 'string') {
			st.valueColumn = config.valueColumn;
		}
		if (typeof config.legendColumn === 'string') {
			st.legendColumn = config.legendColumn;
		}
		if (Array.isArray(config.tooltipColumns)) {
			st.tooltipColumns = config.tooltipColumns.map((c: any) => String(c));
		}
		if (typeof config.showDataLabels === 'boolean') {
			st.showDataLabels = config.showDataLabels;
		}
		if (typeof config.legendPosition === 'string') {
			st.legendPosition = config.legendPosition;
		}
		if (typeof config.sortColumn === 'string') {
			st.sortColumn = config.sortColumn;
		}
		if (typeof config.sortDirection === 'string') {
			st.sortDirection = config.sortDirection;
		}
		
		// Update the UI dropdowns to reflect new state and re-render the chart
		try { _win.__kustoUpdateChartBuilderUI(id); } catch (e) { console.error('[kusto]', e); }
		try { _win.__kustoRenderChart(id); } catch (e) { console.error('[kusto]', e); }
		
		// Persist changes
		try { if (typeof _win.schedulePersist === 'function') _win.schedulePersist(); } catch (e) { console.error('[kusto]', e); }
		
		return true;
	} catch (err: any) {
		console.error('[Kusto] Error configuring chart:', err);
		return false;
	}
}

// Expose for tool calls from main.js
try { window.__kustoConfigureChart = __kustoConfigureChartFromTool; } catch (e) { console.error('[kusto]', e); }

/**
 * Validate a chart's configuration and return detailed status for tools.
 * This helps the LLM verify that chart configuration was successful.
 * @param {string} boxId - The chart section ID
 * @returns {object} Status object with validation details
 */
function __kustoGetChartValidationStatus( boxId: any) {
	try {
		const id = String(boxId || '');
		if (!id) return { valid: false, error: 'No chart ID provided' };
		
		const st = _win.__kustoGetChartState(id);
		if (!st) return { valid: false, error: 'Chart section not found' };
		
		const issues = [];
		
		// Check data source
		const dataSourceId = typeof st.dataSourceId === 'string' ? st.dataSourceId : '';
		if (!dataSourceId) {
			issues.push('No data source selected. Use dataSourceId to link to a query section with results.');
		}
		
		// Check chart type
		const chartType = typeof st.chartType === 'string' ? st.chartType : '';
		if (!chartType) {
			issues.push('No chart type selected. Specify chartType (line, area, bar, scatter, pie, or funnel).');
		}
		
		// Check if data source exists and has data
		let dataSourceExists = false;
		let dataSourceHasData = false;
		let availableColumns: any[] = [];
		if (dataSourceId) {
			try {
				const dsState = getResultsState(dataSourceId);
				if (dsState) {
					dataSourceExists = true;
					const cols = Array.isArray(dsState.columns) ? dsState.columns : [];
					const rows = Array.isArray(dsState.rows) ? dsState.rows : [];
					availableColumns = cols.map((c: any) => String(c || ''));
					dataSourceHasData = cols.length > 0 && rows.length > 0;
					if (!dataSourceHasData) {
						if (cols.length === 0) {
							issues.push(`Data source "${dataSourceId}" has no columns. Execute the query first to get results.`);
						} else if (rows.length === 0) {
							issues.push(`Data source "${dataSourceId}" has columns but no data rows. Execute the query first.`);
						}
					}
				} else {
					issues.push(`Data source "${dataSourceId}" not found or has no results. Make sure the query has been executed.`);
				}
			} catch (e) { console.error('[kusto]', e); }
		}
		
		// Check column configuration based on chart type
		if (chartType && dataSourceHasData && availableColumns.length > 0) {
			const xColumn = typeof st.xColumn === 'string' ? st.xColumn : '';
			const yColumns = Array.isArray(st.yColumns) ? st.yColumns : [];
			const labelColumn = typeof st.labelColumn === 'string' ? st.labelColumn : '';
			const valueColumn = typeof st.valueColumn === 'string' ? st.valueColumn : '';
			
			if (chartType === 'pie' || chartType === 'funnel') {
				// Pie/funnel need label and value columns
				if (!labelColumn) {
					issues.push(`${chartType} chart requires labelColumn (the category names). Available columns: ${availableColumns.join(', ')}`);
				} else if (!availableColumns.includes(labelColumn)) {
					issues.push(`labelColumn "${labelColumn}" not found in data. Available columns: ${availableColumns.join(', ')}`);
				}
				if (!valueColumn) {
					issues.push(`${chartType} chart requires valueColumn (the numeric values). Available columns: ${availableColumns.join(', ')}`);
				} else if (!availableColumns.includes(valueColumn)) {
					issues.push(`valueColumn "${valueColumn}" not found in data. Available columns: ${availableColumns.join(', ')}`);
				}
			} else {
				// Line, area, bar, scatter need x and y columns
				if (!xColumn) {
					issues.push(`${chartType} chart requires xColumn. Available columns: ${availableColumns.join(', ')}`);
				} else if (!availableColumns.includes(xColumn)) {
					issues.push(`xColumn "${xColumn}" not found in data. Available columns: ${availableColumns.join(', ')}`);
				}
				if (!yColumns || yColumns.length === 0) {
					issues.push(`${chartType} chart requires yColumns (array of column names for Y axis). Available columns: ${availableColumns.join(', ')}`);
				} else {
					const invalidYCols = yColumns.filter((c: any) => !availableColumns.includes(c));
					if (invalidYCols.length > 0) {
						issues.push(`yColumns "${invalidYCols.join(', ')}" not found in data. Available columns: ${availableColumns.join(', ')}`);
					}
				}
			}
		}
		
		const valid = issues.length === 0;
		return {
			valid,
			chartType: chartType || null,
			dataSourceId: dataSourceId || null,
			dataSourceExists,
			dataSourceHasData,
			availableColumns: availableColumns.length > 0 ? availableColumns : undefined,
			currentConfig: {
				xColumn: st.xColumn || null,
				yColumns: (Array.isArray(st.yColumns) && st.yColumns.length > 0) ? st.yColumns : null,
				labelColumn: st.labelColumn || null,
				valueColumn: st.valueColumn || null,
				legendColumn: st.legendColumn || null
			},
			...(issues.length > 0 ? { issues } : {})
		};
	} catch (err: any) {
		return { valid: false, error: `Validation error: ${err.message || String(err)}` };
	}
}

// Expose for tool calls
try { window.__kustoGetChartValidationStatus = __kustoGetChartValidationStatus; } catch (e) { console.error('[kusto]', e); }

/**
 * Configure a transformation section programmatically (used by LLM tools).
 * @param {string} boxId - The transformation section ID
 * @param {object} config - Configuration object with properties like:
 *   - dataSourceId: string (ID of the data source section)
 *   - transformationType: 'derive' | 'distinct' | 'summarize' | 'pivot'
 *   - deriveColumns: Array<{name: string, expression: string}>
 *   - distinctColumn: string
 *   - groupByColumns: string[]
 *   - aggregations: Array<{function: string, column: string, alias?: string}>
 *   - pivotRowKeyColumn: string
 *   - pivotColumnKeyColumn: string
 *   - pivotValueColumn: string
 *   - pivotAggregation: string
 *   - pivotMaxColumns: number
 */

function __kustoGetRawCellValueForChart( cell: any) {
	try {
		return _getRawCellValueFromState(cell);
	} catch (e) { console.error('[kusto]', e); }
	return _getRawCellValue(cell);
}

function __kustoCellToChartString( cell: any) {
	try {
		const raw = __kustoGetRawCellValueForChart(cell);
		if (raw === null || raw === undefined) return '';
		if (raw instanceof Date) return raw.toISOString();
		if (typeof raw === 'string') return raw;
		if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
		if (typeof raw === 'object') {
			try { return JSON.stringify(raw); } catch { return '[object]'; }
		}
		return String(raw);
	} catch {
		try { return String(cell); } catch { return ''; }
	}
}

function __kustoCellToChartNumber( cell: any) {
	try {
		const raw = __kustoGetRawCellValueForChart(cell);
		if (typeof _win.__kustoTryParseNumber === 'function') {
			return _win.__kustoTryParseNumber(raw);
		}
		const n = (typeof raw === 'number') ? raw : Number(raw);
		return Number.isFinite(n) ? n : null;
	} catch {
		return null;
	}
}

function __kustoCellToChartTimeMs( cell: any) {
	try {
		const raw = __kustoGetRawCellValueForChart(cell);
		if (typeof _win.__kustoTryParseDateMs === 'function') {
			return _win.__kustoTryParseDateMs(raw);
		}
		const t = Date.parse(String(raw || ''));
		return Number.isFinite(t) ? t : null;
	} catch {
		return null;
	}
}

function __kustoInferTimeXAxisFromRows( rows: any, xIndex: any) {
	return _inferTimeXAxisFromRows(rows, xIndex);
}

function __kustoNormalizeResultsColumnName( c: any) {
	return _normalizeResultsColumnName(c);
}

function __kustoSetSelectOptions( selectEl: any, values: any, selectedValue: any, labelMap?: any) {
	if (!selectEl) return;
	try {
		const selected = (typeof selectedValue === 'string') ? selectedValue : '';
		const opts = Array.isArray(values) ? values : [];
		const labels = (labelMap && typeof labelMap === 'object') ? labelMap : {};
		let html = '';
		for (const v of opts) {
			const s = String(v ?? '');
			const labelText = (s in labels) ? labels[s] : s;
			if (!labelText) continue;
			const escVal = escapeHtml(s);
			const escLabel = escapeHtml(labelText);
			html += '<option value="' + escVal + '">' + escLabel + '</option>';
		}
		if (!html) {
			html = '<option value="">(select)</option>';
		}
		selectEl.innerHTML = html;
		selectEl.value = selected;
	} catch (e) { console.error('[kusto]', e); }
}

function __kustoPickFirstNonEmpty( arr: any) {
	return _pickFirstNonEmpty(arr);
}

// Pending reveal requests from the extension host (e.g., Search result click).
// Keyed by markdown boxId.
function __kustoToggleSectionModeDropdown( boxId: any, prefix: any, ev: any) {
	try {
		if (ev && typeof ev.stopPropagation === 'function') {
			ev.stopPropagation();
		}
		const menu = document.getElementById(boxId + '_' + prefix + '_mode_dropdown_menu') as any;
		const btn = document.getElementById(boxId + '_' + prefix + '_mode_dropdown_btn') as any;
		if (!menu || !btn) return;
		const isOpen = menu.style.display !== 'none';
		// Close all other dropdowns first
		try { _closeAllDropdownMenus(); } catch (e) { console.error('[kusto]', e); }
		if (isOpen) {
			menu.style.display = 'none';
			btn.setAttribute('aria-expanded', 'false');
		} else {
			menu.style.display = 'block';
			btn.setAttribute('aria-expanded', 'true');
		}
	} catch (e) { console.error('[kusto]', e); }
}

// Close the section mode dropdown menu
function __kustoCloseSectionModeDropdown( boxId: any, prefix: any) {
	try {
		const menu = document.getElementById(boxId + '_' + prefix + '_mode_dropdown_menu') as any;
		const btn = document.getElementById(boxId + '_' + prefix + '_mode_dropdown_btn') as any;
		if (menu) menu.style.display = 'none';
		if (btn) btn.setAttribute('aria-expanded', 'false');
	} catch (e) { console.error('[kusto]', e); }
}

// Track ResizeObservers for chart/transformation sections
const __kustoSectionModeResizeObservers: any = {};

// Check if a section should show the dropdown vs buttons
function __kustoUpdateSectionModeResponsive( boxId: any) {
	try {
		const box = document.getElementById(boxId) as any;
		if (!box) return;
		const width = box.offsetWidth || 0;
		const isNarrow = width > 0 && width < 450;
		const isVeryNarrow = width > 0 && width < 250;
		box.classList.toggle('is-section-narrow', isNarrow);
		box.classList.toggle('is-section-very-narrow', isVeryNarrow);
	} catch (e) { console.error('[kusto]', e); }
}

// Set up ResizeObserver for a chart/transformation section
function __kustoSetupSectionModeResizeObserver( boxId: any) {
	try {
		if (__kustoSectionModeResizeObservers[boxId]) return;
		const box = document.getElementById(boxId) as any;
		if (!box) return;
		if (typeof ResizeObserver === 'undefined') return;
		const observer = new ResizeObserver(() => {
			try { __kustoUpdateSectionModeResponsive(boxId); } catch (e) { console.error('[kusto]', e); }
		});
		observer.observe(box);
		__kustoSectionModeResizeObservers[boxId] = observer;
		// Initial check
		__kustoUpdateSectionModeResponsive(boxId);
	} catch (e) { console.error('[kusto]', e); }
}

// Clean up ResizeObserver when a chart/transformation section is removed
function __kustoCleanupSectionModeResizeObserver( boxId: any) {
	try {
		const observer = __kustoSectionModeResizeObservers[boxId];
		if (observer && typeof observer.disconnect === 'function') {
			observer.disconnect();
		}
		delete __kustoSectionModeResizeObservers[boxId];
	} catch (e) { console.error('[kusto]', e); }
}

// Close all section-mode dropdowns when clicking outside
try {
	document.addEventListener('click', (ev: any) => {
		try {
			const target = ev.target;
			if (!target) return;
			const inDropdown = target.closest && target.closest('.section-mode-dropdown');
			if (!inDropdown) {
				const menus = document.querySelectorAll('.section-mode-dropdown-menu');
				const btns = document.querySelectorAll('.section-mode-dropdown-btn');
				for (const m of menus as any) {
					try { m.style.display = 'none'; } catch (e) { console.error('[kusto]', e); }
				}
				for (const b of btns) {
					try { b.setAttribute('aria-expanded', 'false'); } catch (e) { console.error('[kusto]', e); }
				}
			}
		} catch (e) { console.error('[kusto]', e); }
	});
} catch (e) { console.error('[kusto]', e); }

export function addPythonBox( options: any) {
	const id = (options && options.id) ? String(options.id) : ('python_' + Date.now());
	pythonBoxes.push(id);

	const container = document.getElementById('queries-container') as any;
	if (!container) {
		return;
	}

	const litEl = document.createElement('kw-python-section');
	litEl.id = id;
	litEl.setAttribute('box-id', id);

	// Pass initial code if available.
	const pendingCode = window.__kustoPendingPythonCodeByBoxId && window.__kustoPendingPythonCodeByBoxId[id];
	if (typeof pendingCode === 'string') {
		litEl.setAttribute('initial-code', pendingCode);
	}

	// Create the light-DOM editor container that Monaco will render into.
	const editorDiv = document.createElement('div');
	editorDiv.className = 'query-editor';
	editorDiv.id = id + '_py_editor';
	editorDiv.slot = 'editor';
	litEl.appendChild(editorDiv);

	// Handle remove event from the Lit component.
	litEl.addEventListener('section-remove', function (e: any) {
		try { removePythonBox(e.detail.boxId); } catch (e) { console.error('[kusto]', e); }
	});

	container.appendChild(litEl);

	try { _win.schedulePersist && _win.schedulePersist(); } catch (e) { console.error('[kusto]', e); }
	try {
		const controls = document.querySelector('.add-controls');
		if (controls && typeof controls.scrollIntoView === 'function') {
			controls.scrollIntoView({ block: 'end' });
		}
	} catch (e) { console.error('[kusto]', e); }
	return id;
}

function removePythonBox( boxId: any) {
	// Legacy editor cleanup (for any old-style boxes still in DOM).
	if (pythonEditors[boxId]) {
		try { pythonEditors[boxId].dispose(); } catch (e) { console.error('[kusto]', e); }
		delete pythonEditors[boxId];
	}
	pythonBoxes = pythonBoxes.filter((id: any) => id !== boxId);
	const box = document.getElementById(boxId) as any;
	if (box && box.parentNode) {
		box.parentNode.removeChild(box);
	}
	try { _win.schedulePersist && _win.schedulePersist(); } catch (e) { console.error('[kusto]', e); }
}

function __kustoMaximizePythonBox(boxId: any) {
	const id = String(boxId || '').trim();
	if (!id) return;
	const editorEl = document.getElementById(id + '_py_editor') as any;
	const wrapper = editorEl?.closest?.('.query-editor-wrapper');
	if (!wrapper) return;
	const applyFitToContent = () => {
		try {
			const ed = pythonEditors?.[id];
			if (!ed) return;
			let contentHeight = 0;
			try {
				const ch = typeof ed.getContentHeight === 'function' ? ed.getContentHeight() : 0;
				if (ch && Number.isFinite(ch)) contentHeight = Math.max(contentHeight, ch);
			} catch (e) { console.error('[kusto]', e); }
			if (!contentHeight || !Number.isFinite(contentHeight) || contentHeight <= 0) return;

			let chrome = 0;
			try {
				for (const child of Array.from(wrapper.children || []) as any[]) {
					if (!child || child === editorEl) continue;
					try { if (getComputedStyle(child).display === 'none') continue; } catch (e) { console.error('[kusto]', e); }
					chrome += child.getBoundingClientRect?.().height || 0;
				}
			} catch (e) { console.error('[kusto]', e); }
			try {
				const csw = getComputedStyle(wrapper);
				chrome += (parseFloat(csw.paddingTop || '0') || 0) + (parseFloat(csw.paddingBottom || '0') || 0);
				chrome += (parseFloat(csw.borderTopWidth || '0') || 0) + (parseFloat(csw.borderBottomWidth || '0') || 0);
			} catch (e) { console.error('[kusto]', e); }

			const desired = Math.max(120, Math.min(20000, Math.ceil(chrome + contentHeight)));
			wrapper.style.height = desired + 'px';
			wrapper.style.minHeight = '0';
			try { if (wrapper.dataset) wrapper.dataset.kustoUserResized = 'true'; } catch (e) { console.error('[kusto]', e); }
			try { if (typeof ed.layout === 'function') ed.layout(); } catch (e) { console.error('[kusto]', e); }
		} catch (e) { console.error('[kusto]', e); }
	};

	applyFitToContent();
	setTimeout(applyFitToContent, 50);
	setTimeout(applyFitToContent, 150);
	try { _win.schedulePersist?.(); } catch (e) { console.error('[kusto]', e); }
}
_win.__kustoMaximizePythonBox = __kustoMaximizePythonBox;

function initPythonEditor( boxId: any) {
	return _win.ensureMonaco().then((monaco: any) => {
		const container = document.getElementById(boxId + '_py_editor') as any;
		if (!container) {
			return;
		}

		// If an editor exists, ensure it's still attached to this container.
		try {
			const existing = pythonEditors && pythonEditors[boxId] ? pythonEditors[boxId] : null;
			if (existing) {
				const dom = (typeof existing.getDomNode === 'function') ? existing.getDomNode() : null;
				const attached = !!(dom && dom.isConnected && container.contains(dom));
				if (attached) {
					return;
				}
				try { existing.dispose(); } catch (e) { console.error('[kusto]', e); }
				try { delete pythonEditors[boxId]; } catch (e) { console.error('[kusto]', e); }
			}
		} catch (e) { console.error('[kusto]', e); }

		container.style.minHeight = '0';
		container.style.minWidth = '0';

		// Avoid editor.setValue() during init; pass initial value into create() to reduce timing races.
		let initialValue = '';
		try {
			const pending = window.__kustoPendingPythonCodeByBoxId && window.__kustoPendingPythonCodeByBoxId[boxId];
			if (typeof pending === 'string') {
				initialValue = pending;
				try { delete window.__kustoPendingPythonCodeByBoxId[boxId]; } catch (e) { console.error('[kusto]', e); }
			}
		} catch (e) { console.error('[kusto]', e); }

		const editor = monaco.editor.create(container, {
			value: initialValue,
			language: 'python',
			readOnly: false,
			domReadOnly: false,
			automaticLayout: true,
			scrollbar: { alwaysConsumeMouseWheel: false },
			fixedOverflowWidgets: true,
			minimap: { enabled: false },
			scrollBeyondLastLine: false,
			fontFamily: getComputedStyle(document.body).getPropertyValue('--vscode-editor-font-family'),
			fontSize: 13,
			lineNumbers: 'on',
			renderLineHighlight: 'none'
		});

		// Mark this as the active Monaco editor for global key handlers (paste, etc.).
		try {
			if (typeof editor.onDidFocusEditorText === 'function') {
				editor.onDidFocusEditorText(() => {
					try { _win.activeMonacoEditor = editor; } catch (e) { console.error('[kusto]', e); }
					try {
						if (typeof _win.__kustoForceEditorWritable === 'function') {
							_win.__kustoForceEditorWritable(editor);
						}
					} catch (e) { console.error('[kusto]', e); }
				});
			}
			if (typeof editor.onDidFocusEditorWidget === 'function') {
				editor.onDidFocusEditorWidget(() => {
					try { _win.activeMonacoEditor = editor; } catch (e) { console.error('[kusto]', e); }
					try {
						if (typeof _win.__kustoForceEditorWritable === 'function') {
							_win.__kustoForceEditorWritable(editor);
						}
					} catch (e) { console.error('[kusto]', e); }
				});
			}
		} catch (e) { console.error('[kusto]', e); }

		pythonEditors[boxId] = editor;
		// Work around sporadic webview timing issues where Monaco input can end up stuck readonly.
		try {
			if (typeof _win.__kustoEnsureEditorWritableSoon === 'function') {
				_win.__kustoEnsureEditorWritableSoon(editor);
			}
		} catch (e) { console.error('[kusto]', e); }
		try {
			if (typeof _win.__kustoInstallWritableGuard === 'function') {
				_win.__kustoInstallWritableGuard(editor);
			}
		} catch (e) { console.error('[kusto]', e); }
		// If the editor is stuck non-interactive on click, force writable before focusing.
		try {
			container.addEventListener('mousedown', () => {
				try {
					if (typeof _win.__kustoForceEditorWritable === 'function') {
						_win.__kustoForceEditorWritable(editor);
					}
				} catch (e) { console.error('[kusto]', e); }
				try { editor.focus(); } catch (e) { console.error('[kusto]', e); }
			}, true);
		} catch (e) { console.error('[kusto]', e); }
		// Auto-resize editor to show full content, until the user manually resizes.
		try {
			if (typeof _win.__kustoAttachAutoResizeToContent === 'function') {
				_win.__kustoAttachAutoResizeToContent(editor, container);
			}
		} catch (e) { console.error('[kusto]', e); }
		try {
			editor.onDidChangeModelContent(() => {
				try { _win.schedulePersist && _win.schedulePersist(); } catch (e) { console.error('[kusto]', e); }
			});
		} catch (e) { console.error('[kusto]', e); }

		// Ctrl+Enter / Ctrl+Shift+Enter runs the Python code (not the Kusto query).
		// addCommand prevents the event from reaching the global Ctrl+Enter handler
		// in main.ts which would otherwise execute the last-focused Kusto query.
		try {
			const runPython = () => {
				try {
					const el = document.getElementById(boxId) as any;
					if (el && typeof el._run === 'function') {
						el._run();
					}
				} catch (e) { console.error('[kusto]', e); }
			};
			editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, runPython);
			editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Enter, runPython);
		} catch (e) { console.error('[kusto]', e); }

		// Drag handle resize (copied from KQL editor behavior).
		try {
			const wrapper = container.closest ? container.closest('.query-editor-wrapper') : null;
			const resizer = document.getElementById(boxId + '_py_resizer') as any;
			if (wrapper && resizer) {
				resizer.addEventListener('mousedown', (e: any) => {
					try {
						e.preventDefault();
						e.stopPropagation();
					} catch (e) { console.error('[kusto]', e); }
					try { wrapper.dataset.kustoUserResized = 'true'; } catch (e) { console.error('[kusto]', e); }

					resizer.classList.add('is-dragging');
					const previousCursor = document.body.style.cursor;
					const previousUserSelect = document.body.style.userSelect;
					document.body.style.cursor = 'ns-resize';
					document.body.style.userSelect = 'none';

						const startPageY = e.clientY + getScrollY();
					const startHeight = wrapper.getBoundingClientRect().height;

					const onMove = (moveEvent: any) => {
							try {
								maybeAutoScrollWhileDragging(moveEvent.clientY);
							} catch (e) { console.error('[kusto]', e); }
							const pageY = moveEvent.clientY + getScrollY();
							const delta = pageY - startPageY;
						const nextHeight = Math.max(120, Math.min(900, startHeight + delta));
						wrapper.style.height = nextHeight + 'px';
						try { editor.layout(); } catch (e) { console.error('[kusto]', e); }
					};
					const onUp = () => {
						document.removeEventListener('mousemove', onMove, true);
						document.removeEventListener('mouseup', onUp, true);
						resizer.classList.remove('is-dragging');
						document.body.style.cursor = previousCursor;
						document.body.style.userSelect = previousUserSelect;
						try { _win.schedulePersist && _win.schedulePersist(); } catch (e) { console.error('[kusto]', e); }
					};

					document.addEventListener('mousemove', onMove, true);
					document.addEventListener('mouseup', onUp, true);
				});

				// Double-click to fit editor to contents - delegate to the button's function
				// which already handles measurement with proper retries for async layout settling.
				resizer.addEventListener('dblclick', (e: any) => {
					try {
						e.preventDefault();
						e.stopPropagation();
						if (typeof _win.__kustoMaximizePythonBox === 'function') {
							_win.__kustoMaximizePythonBox(boxId);
						}
					} catch (e) { console.error('[kusto]', e); }
				});
			}
		} catch (e) { console.error('[kusto]', e); }
	}).catch((e: any) => {
		try {
			if (pythonEditors && pythonEditors[boxId]) {
				return;
			}
		} catch (e) { console.error('[kusto]', e); }

		let attempt = 0;
		try {
			window.__kustoMonacoInitRetryCountByBoxId = window.__kustoMonacoInitRetryCountByBoxId || {};
			attempt = (window.__kustoMonacoInitRetryCountByBoxId[boxId] || 0) + 1;
			window.__kustoMonacoInitRetryCountByBoxId[boxId] = attempt;
		} catch {
			attempt = 1;
		}

		const delays = [50, 250, 1000, 2000, 4000];
		const delay = delays[Math.min(attempt - 1, delays.length - 1)];
		if (attempt > delays.length) {
			try { console.error('Monaco init failed (python editor).', e); } catch (e) { console.error('[kusto]', e); }
			return;
		}
		try {
			setTimeout(() => {
				try { initPythonEditor(boxId); } catch (e) { console.error('[kusto]', e); }
			}, delay);
		} catch (e) { console.error('[kusto]', e); }
	});
}

function setPythonOutput( boxId: any, text: any) {
	const out = document.getElementById(boxId + '_py_output') as any;
	if (!out) {
		return;
	}
	out.textContent = String(text || '');
}

function runPythonBox( boxId: any) {
	const editor = pythonEditors[boxId];
	if (!editor) {
		return;
	}
	const model = editor.getModel();
	const code = model ? model.getValue() : '';
	setPythonOutput(boxId, 'Running…');
	try {
		(_win.vscode as any).postMessage({ type: 'executePython', boxId, code });
	} catch (e: any) {
		setPythonOutput(boxId, 'Failed to send run request.');
	}
}

export function onPythonResult( message: any) {
	const boxId = message && message.boxId ? String(message.boxId) : '';
	if (!boxId) {
		return;
	}
	const stdout = String(message.stdout || '');
	const stderr = String(message.stderr || '');
	const exitCode = (typeof message.exitCode === 'number') ? message.exitCode : null;
	let out = '';
	if (stdout.trim()) {
		out += stdout;
	}
	if (stderr.trim()) {
		if (out) out += '\n\n';
		out += stderr;
	}
	if (!out) {
		out = (exitCode === 0) ? '' : 'No output.';
	}
	setPythonOutput(boxId, out);
}

export function onPythonError( message: any) {
	const boxId = message && message.boxId ? String(message.boxId) : '';
	if (!boxId) {
		return;
	}
	setPythonOutput(boxId, String(message.error || 'Python execution failed.'));
}

export function addUrlBox( options: any) {
	const id = (options && options.id) ? String(options.id) : ('url_' + Date.now());
	urlBoxes.push(id);

	const container = document.getElementById('queries-container') as any;
	if (!container) {
		return;
	}

	const litEl = document.createElement('kw-url-section');
	litEl.id = id;
	litEl.setAttribute('box-id', id);

	if (options && typeof options.name === 'string') {
		litEl.setName(options.name);
	}
	if (options && typeof options.url === 'string') {
		litEl.setUrl(options.url);
	}
	if (options && typeof options.expanded === 'boolean') {
		litEl.setExpanded(options.expanded);
	}
	if (options && typeof options.outputHeightPx === 'number') {
		litEl.setAttribute('output-height-px', String(options.outputHeightPx));
	}
	if (options) {
		litEl.setImageDisplayMode(options.imageSizeMode, options.imageAlign, options.imageOverflow);
	}

	litEl.addEventListener('section-remove', function (e: any) {
		try { removeUrlBox(e.detail.boxId); } catch (e) { console.error('[kusto]', e); }
	});

	container.appendChild(litEl);

	try { _win.schedulePersist && _win.schedulePersist(); } catch (e) { console.error('[kusto]', e); }
	try {
		const controls = document.querySelector('.add-controls');
		if (controls && typeof controls.scrollIntoView === 'function') {
			controls.scrollIntoView({ block: 'end' });
		}
	} catch (e) { console.error('[kusto]', e); }

	return id;
}

function removeUrlBox( boxId: any) {
	urlBoxes = urlBoxes.filter((id: any) => id !== boxId);
	const box = document.getElementById(boxId) as any;
	if (box && box.parentNode) {
		box.parentNode.removeChild(box);
	}
	try { _win.schedulePersist && _win.schedulePersist(); } catch (e) { console.error('[kusto]', e); }
}

// (Legacy URL helpers removed — now handled by <kw-url-section> Lit component.)


// ── Window bridges for remaining legacy callers ──
window.__kustoGetChartDatasetsInDomOrder = __kustoGetChartDatasetsInDomOrder;
window.__kustoGetRawCellValueForChart = __kustoGetRawCellValueForChart;
window.__kustoCellToChartString = __kustoCellToChartString;
window.__kustoCellToChartNumber = __kustoCellToChartNumber;
window.__kustoCellToChartTimeMs = __kustoCellToChartTimeMs;
window.__kustoInferTimeXAxisFromRows = __kustoInferTimeXAxisFromRows;
window.__kustoNormalizeResultsColumnName = __kustoNormalizeResultsColumnName;
window.__kustoSetSelectOptions = __kustoSetSelectOptions;
window.__kustoPickFirstNonEmpty = __kustoPickFirstNonEmpty;
window.__kustoSetupSectionModeResizeObserver = __kustoSetupSectionModeResizeObserver;
window.__kustoCleanupSectionModeResizeObserver = __kustoCleanupSectionModeResizeObserver;
window.addPythonBox = addPythonBox;
window.removePythonBox = removePythonBox;
window.initPythonEditor = initPythonEditor;
window.setPythonOutput = setPythonOutput;
window.runPythonBox = runPythonBox;
window.onPythonResult = onPythonResult;
window.onPythonError = onPythonError;
window.addUrlBox = addUrlBox;
window.removeUrlBox = removeUrlBox;

