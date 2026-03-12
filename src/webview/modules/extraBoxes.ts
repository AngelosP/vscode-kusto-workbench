// Extra boxes module — converted from legacy/extraBoxes.js
// Chart, Transformation, Markdown, URL, Python box creation + ECharts rendering.
// Window bridge exports at bottom for remaining legacy callers.
export {};

const _win = window as unknown as Record<string, any>;
// Additional section types for the Kusto Query Editor webview:
// - Markdown: Monaco editor while focused; rendered markdown viewer on blur
// - Python: Monaco editor + Run button; output viewer
// - URL: URL input + expand/collapse content viewer; content fetched by extension host
// - Transformation: Data manipulation section (derive, summarize, pivot, etc.)

let markdownBoxes: any[] = [];
let pythonBoxes: any[] = [];
let urlBoxes: any[] = [];
let chartBoxes: any[] = [];
let transformationBoxes: any[] = [];

// Expose box arrays on window so modules in bundle scope can access them.
try {
	(window as any).__kustoMarkdownBoxes = markdownBoxes;
	(window as any).__kustoPythonBoxes = pythonBoxes;
	(window as any).__kustoUrlBoxes = urlBoxes;
	(window as any).__kustoChartBoxes = chartBoxes;
} catch { /* ignore */ }

// Expose markdownEditors on window so main.js can access it for tool handlers
(window as any).__kustoMarkdownEditors = (window as any).__kustoMarkdownEditors || {};
let markdownEditors = (window as any).__kustoMarkdownEditors;
let markdownViewers: any = {};
let pythonEditors: any = {};
try { (window as any).__kustoPythonEditors = pythonEditors; } catch { /* ignore */ }

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
(window as any).chartStateByBoxId = (window as any).chartStateByBoxId || {};
var chartStateByBoxId = (window as any).chartStateByBoxId;

// Transformation UI state keyed by boxId.
// Explicitly on window so persistence.js can access it
(window as any).transformationStateByBoxId = (window as any).transformationStateByBoxId || {};
var transformationStateByBoxId = (window as any).transformationStateByBoxId;

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
						// Update UI dropdowns (column selects) before rendering so new columns are visible.
						try { __kustoUpdateTransformationBuilderUI(boxId); } catch { /* ignore */ }
						try { __kustoRenderTransformation(boxId); } catch { /* ignore */ }
						queue.push(boxId);
					}
				}
			} catch { /* ignore */ }

			// Refresh charts that directly depend on this source.
			try {
				if (chartStateByBoxId && typeof chartStateByBoxId === 'object') {
					for (const [boxId, st] of Object.entries(chartStateByBoxId)) {
						if (!st || typeof st !== 'object') continue;
						const ds = (typeof (st as any).dataSourceId === 'string') ? String((st as any).dataSourceId) : '';
						if (ds !== sourceId) continue;
						// Update UI dropdowns (axis/column selects) before rendering so new columns are visible.
						try { __kustoUpdateChartBuilderUI(boxId); } catch { /* ignore */ }
						try { __kustoRenderChart(boxId); } catch { /* ignore */ }
					}
				}
			} catch { /* ignore */ }
		}
	} finally {
		__kustoIsRefreshingDependents = false;
	}
}

try {
	(window as any).__kustoRefreshDependentExtraBoxes = __kustoRefreshDependentExtraBoxes;
	(window as any).__kustoNotifyResultsUpdated = (boxId: any) => {
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
					try { __kustoRefreshDependentExtraBoxes(rootId); } catch { /* ignore */ }
				}
			}, 0);
		} catch { /* ignore */ }
	};
} catch { /* ignore */ }

// SVG icons for chart types
const __kustoChartTypeIcons = {
	line: '<svg viewBox="0 0 32 32" width="32" height="32" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4,24 10,16 16,20 22,8 28,12"/></svg>',
	area: '<svg viewBox="0 0 32 32" width="32" height="32" fill="currentColor" fill-opacity="0.3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4,24 L10,16 L16,20 L22,8 L28,12 L28,28 L4,28 Z"/></svg>',
	bar: '<svg viewBox="0 0 32 32" width="32" height="32" fill="currentColor" fill-opacity="0.7"><rect x="4" y="16" width="5" height="12" rx="1"/><rect x="11" y="10" width="5" height="18" rx="1"/><rect x="18" y="14" width="5" height="14" rx="1"/><rect x="25" y="6" width="5" height="22" rx="1"/></svg>',
	scatter: '<svg viewBox="0 0 32 32" width="32" height="32" fill="currentColor"><circle cx="8" cy="20" r="2.5"/><circle cx="14" cy="12" r="2.5"/><circle cx="20" cy="18" r="2.5"/><circle cx="26" cy="8" r="2.5"/><circle cx="11" cy="24" r="2.5"/><circle cx="23" cy="22" r="2.5"/></svg>',
	pie: '<svg viewBox="0 0 32 32" width="32" height="32" fill="none" stroke="currentColor" stroke-width="2"><circle cx="16" cy="16" r="12" fill="currentColor" fill-opacity="0.2"/><path d="M16,16 L16,4 A12,12 0 0,1 27.2,20.8 Z" fill="currentColor" fill-opacity="0.5"/><path d="M16,16 L27.2,20.8 A12,12 0 0,1 8,25.6 Z" fill="currentColor" fill-opacity="0.7"/></svg>',
	funnel: '<svg viewBox="0 0 32 32" width="32" height="32" fill="currentColor" fill-opacity="0.7"><path d="M4,4 L28,4 L28,7 L4,7 Z"/><path d="M6,9 L26,9 L26,12 L6,12 Z" fill-opacity="0.6"/><path d="M8,14 L24,14 L24,17 L8,17 Z" fill-opacity="0.5"/><path d="M10,19 L22,19 L22,22 L10,22 Z" fill-opacity="0.4"/><path d="M12,24 L20,24 L20,27 L12,27 Z" fill-opacity="0.3"/></svg>'
};

const __kustoChartTypeLabels = {
	line: 'Line',
	area: 'Area',
	bar: 'Bar',
	scatter: 'Scatter',
	pie: 'Pie',
	funnel: 'Funnel'
};

const __kustoLegendPositionCycle = ['top', 'right', 'bottom', 'left'];

const __kustoLegendPositionIcons = {
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

function __kustoNormalizeLegendPosition( pos: any) {
	const p = String(pos || '').toLowerCase();
	return (p === 'top' || p === 'right' || p === 'bottom' || p === 'left') ? p : 'top';
}

function __kustoUpdateLegendPositionButtonUI( boxId: any) {
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
		try { st.legendPosition = pos; } catch { /* ignore */ }
		btn.innerHTML = __kustoLegendPositionIcons[pos] || __kustoLegendPositionIcons.top;
		const title = 'Legend position: ' + (pos.charAt(0).toUpperCase() + pos.slice(1));
		btn.title = title;
		btn.setAttribute('aria-label', title);
	} catch { /* ignore */ }
}

function __kustoOnChartLegendPositionClicked( boxId: any) {
	const id = String(boxId || '');
	if (!id) return;
	const st = __kustoGetChartState(id);
	const current = __kustoNormalizeLegendPosition(st && st.legendPosition);
	let next = 'top';
	try {
		const idx = __kustoLegendPositionCycle.indexOf(current);
		next = __kustoLegendPositionCycle[(idx + 1) % __kustoLegendPositionCycle.length] || 'top';
	} catch { /* ignore */ }
	try { st.legendPosition = next; } catch { /* ignore */ }
	try { __kustoUpdateLegendPositionButtonUI(id); } catch { /* ignore */ }
	try { __kustoRenderChart(id); } catch { /* ignore */ }
	try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
}

function __kustoFormatNumber( value: any) {
	try {
		if (value === null || value === undefined) return '';
		const n = typeof value === 'number' ? value : Number(value);
		if (!Number.isFinite(n)) return String(value);
		// Use locale formatting for nice thousands separators
		return n.toLocaleString('en-US', { maximumFractionDigits: 6 });
	} catch {
		return String(value);
	}
}

function __kustoComputeAxisFontSize( labelCount: any, axisPixelWidth: any, isYAxis: any) {
	try {
		const w = (typeof axisPixelWidth === 'number' && Number.isFinite(axisPixelWidth)) ? axisPixelWidth : 0;
		const n = (typeof labelCount === 'number' && Number.isFinite(labelCount)) ? Math.max(0, Math.floor(labelCount)) : 0;
		if (!w || !n) return 12; // default
		// For Y-axis, always use reasonable size
		if (isYAxis) return 11;
		// For X-axis, adjust based on density
		const pixelsPerLabel = w / n;
		if (pixelsPerLabel < 30) return 9;
		if (pixelsPerLabel < 50) return 10;
		if (pixelsPerLabel < 80) return 11;
		return 12;
	} catch {
		return 12;
	}
}

function __kustoGetChartState( boxId: any) {
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
		} catch { /* ignore */ }
		// Ensure xAxisSettings exists with defaults
		try {
			if (!chartStateByBoxId[id].xAxisSettings || typeof chartStateByBoxId[id].xAxisSettings !== 'object') {
				chartStateByBoxId[id].xAxisSettings = __kustoGetDefaultAxisSettings();
			}
		} catch { /* ignore */ }
		// Ensure yAxisSettings exists with defaults
		try {
			if (!chartStateByBoxId[id].yAxisSettings || typeof chartStateByBoxId[id].yAxisSettings !== 'object') {
				chartStateByBoxId[id].yAxisSettings = __kustoGetDefaultYAxisSettings();
			}
		} catch { /* ignore */ }
		return chartStateByBoxId[id];
	} catch {
		return { mode: 'edit', expanded: true };
	}
}

/**
 * Returns default axis settings.
 */
function __kustoGetDefaultAxisSettings() {
	return {
		sortDirection: '',      // '' = auto, 'asc', 'desc'
		scaleType: '',          // '' = auto, 'category', 'continuous'
		labelDensity: 100,      // 100 = show all, 0 = hide all (slider value)
		showAxisLabel: true,    // Show the axis title
		customLabel: '',        // Custom axis title (empty = use column name)
		titleGap: 30            // Gap between axis title and axis (default 30 for X)
	};
}

/**
 * Check if axis settings differ from defaults.
 */
function __kustoHasCustomAxisSettings( settings: any) {
	if (!settings || typeof settings !== 'object') return false;
	const defaults = __kustoGetDefaultAxisSettings();
	return (
		(settings.sortDirection && settings.sortDirection !== defaults.sortDirection) ||
		(settings.scaleType && settings.scaleType !== defaults.scaleType) ||
		(typeof settings.labelDensity === 'number' && settings.labelDensity !== 100) ||
		(settings.showAxisLabel === false) ||
		(settings.customLabel && settings.customLabel !== defaults.customLabel) ||
		(typeof settings.titleGap === 'number' && settings.titleGap !== defaults.titleGap)
	);
}

/**
 * Returns default Y-axis settings.
 */
function __kustoGetDefaultYAxisSettings() {
	return {
		showAxisLabel: true,    // Show the axis title
		customLabel: '',        // Custom axis title (empty = use column name)
		min: '',                // Min value (empty = auto)
		max: '',                // Max value (empty = auto)
		seriesColors: {},       // Custom colors by column name, e.g. { 'Revenue': '#ff0000' }
		titleGap: 45            // Gap between axis title and axis (default 45 for Y)
	};
}

/**
 * Check if Y-axis settings differ from defaults.
 */
function __kustoHasCustomYAxisSettings( settings: any) {
	if (!settings || typeof settings !== 'object') return false;
	const defaults = __kustoGetDefaultYAxisSettings();
	const hasCustomColors = settings.seriesColors && typeof settings.seriesColors === 'object' && Object.keys(settings.seriesColors).length > 0;
	return (
		(settings.showAxisLabel === false) ||
		(settings.customLabel && settings.customLabel !== '') ||
		(settings.min !== '' && settings.min !== undefined && settings.min !== null) ||
		(settings.max !== '' && settings.max !== undefined && settings.max !== null) ||
		hasCustomColors ||
		(typeof settings.titleGap === 'number' && settings.titleGap !== defaults.titleGap)
	);
}

/**
 * Default color palette for chart series (ECharts default-ish colors).
 */
const __kustoDefaultSeriesColors = [
	'#5470c6', '#91cc75', '#fac858', '#ee6666', '#73c0de',
	'#3ba272', '#fc8452', '#9a60b4', '#ea7ccc', '#48b8d0'
];

/**
 * Update the series colors UI in the Y-axis settings popup.
 */
function __kustoUpdateSeriesColorsUI( boxId: any, settings: any) {
	const id = String(boxId || '');
	if (!id) return;
	
	try {
		const st = __kustoGetChartState(id);
		const yColumns = Array.isArray(st.yColumns) ? st.yColumns.filter((c: any) => c) : (st.yColumn ? [st.yColumn] : []);
		const colorsSection = document.getElementById(id + '_chart_y_colors_section') as any;
		const colorsList = document.getElementById(id + '_chart_y_colors_list') as any;
		
		if (!colorsSection || !colorsList) return;
		
		// Only show colors section if there are Y columns selected
		if (yColumns.length === 0) {
			colorsSection.style.display = 'none';
			return;
		}
		
		colorsSection.style.display = '';
		
		// Build the color picker rows
		const seriesColors = (settings && settings.seriesColors) || {};
		let html = '';
		
		// Use global escapeHtml function (defined in utils.js) since __kustoEscapeHtml is only defined inside __kustoRenderChart
		const escHtml = (v: any) => {
			try {
				if (typeof _win.escapeHtml === 'function') return _win.escapeHtml(String(v ?? ''));
			} catch { /* ignore */ }
			return String(v ?? '')
				.replace(/&/g, '&amp;')
				.replace(/</g, '&lt;')
				.replace(/>/g, '&gt;')
				.replace(/\"/g, '&quot;')
				.replace(/'/g, '&#39;');
		};
		
		for (let i = 0; i < yColumns.length; i++) {
			const colName = yColumns[i];
			const customColor = seriesColors[colName] || '';
			const defaultColor = __kustoDefaultSeriesColors[i % __kustoDefaultSeriesColors.length];
			const displayColor = customColor || defaultColor;
			
			html += '<div class="kusto-axis-settings-color-row">' +
				'<input type="color" class="kusto-axis-settings-color-input" ' +
				'id="' + id + '_chart_y_color_' + i + '" ' +
				'value="' + displayColor + '" ' +
				'data-column="' + escHtml(colName) + '" ' +
				'data-default="' + defaultColor + '" ' +
				'onchange="try{__kustoOnSeriesColorChanged(\'' + id + '\', this)}catch{}">' +
				'<span class="kusto-axis-settings-color-label" title="' + escHtml(colName) + '">' + escHtml(colName) + '</span>' +
				(customColor ? '<button type="button" class="kusto-axis-settings-color-reset" title="Reset to default" ' +
				'onclick="try{__kustoResetSeriesColor(\'' + id + '\', \'' + escHtml(colName).replace(/'/g, "\\'") + '\', ' + i + ')}catch{}">' +
				'<svg width="12" height="12" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M8 8.707l3.646 3.647.708-.707L8.707 8l3.647-3.646-.707-.708L8 7.293 4.354 3.646l-.708.708L7.293 8l-3.647 3.646.708.708L8 8.707z" fill="currentColor"/></svg>' +
				'</button>' : '') +
				'</div>';
		}
		
		colorsList.innerHTML = html;
	} catch { /* ignore */ }
}

/**
 * Handle series color change from color picker.
 */
function __kustoOnSeriesColorChanged( boxId: any, inputEl: any) {
	const id = String(boxId || '');
	if (!id || !inputEl) return;
	
	try {
		const colName = inputEl.dataset.column;
		const defaultColor = inputEl.dataset.default;
		const newColor = inputEl.value;
		
		if (!colName) return;
		
		const st = __kustoGetChartState(id);
		if (!st.yAxisSettings) st.yAxisSettings = __kustoGetDefaultYAxisSettings();
		if (!st.yAxisSettings.seriesColors) st.yAxisSettings.seriesColors = {};
		
		// If color matches default, remove from custom colors
		if (newColor.toLowerCase() === defaultColor.toLowerCase()) {
			delete st.yAxisSettings.seriesColors[colName];
		} else {
			st.yAxisSettings.seriesColors[colName] = newColor;
		}
		
		// Re-render chart with new colors
		try { __kustoRenderChart(id); } catch { /* ignore */ }
		try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
		
		// Update indicator
		__kustoUpdateAxisLabelIndicator(id, 'y');
		
		// Re-sync UI to show/hide reset button
		__kustoUpdateSeriesColorsUI(id, st.yAxisSettings);
	} catch { /* ignore */ }
}

/**
 * Reset a series color to its default.
 */
function __kustoResetSeriesColor( boxId: any, colName: any, index: any) {
	const id = String(boxId || '');
	if (!id || !colName) return;
	
	try {
		const st = __kustoGetChartState(id);
		if (st.yAxisSettings && st.yAxisSettings.seriesColors) {
			delete st.yAxisSettings.seriesColors[colName];
		}
		
		// Update the color input to show default
		const colorInput = document.getElementById(id + '_chart_y_color_' + index) as any;
		if (colorInput) {
			colorInput.value = colorInput.dataset.default || __kustoDefaultSeriesColors[index % __kustoDefaultSeriesColors.length];
		}
		
		// Re-render chart
		try { __kustoRenderChart(id); } catch { /* ignore */ }
		try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
		
		// Update indicator
		__kustoUpdateAxisLabelIndicator(id, 'y');
		
		// Re-sync UI
		__kustoUpdateSeriesColorsUI(id, st.yAxisSettings);
	} catch { /* ignore */ }
}

/**
 * Toggle the axis settings popup visibility.
 */
function __kustoToggleAxisSettingsPopup( boxId: any, axis: any) {
	const id = String(boxId || '');
	const ax = String(axis || '').toLowerCase();
	if (!id || !ax) return;
	
	try {
		const popup = document.getElementById(id + '_chart_' + ax + '_settings_popup') as any;
		if (!popup) return;
		
		const isOpen = popup.classList.contains('is-open');
		
		// Close all other popups first
		try { __kustoCloseAllAxisSettingsPopups(); } catch { /* ignore */ }
		
		if (isOpen) {
			// Was open, now closed (by closeAll above)
			return;
		}
		
		// Position the popup using fixed positioning relative to the label
		const label = document.getElementById(id + '_chart_' + ax + '_label') as any;
		if (label) {
			const labelRect = label.getBoundingClientRect();
			// Measure actual text width to center arrow on text, not padded label area
			const labelText = label.textContent || '';
			const computedStyle = window.getComputedStyle(label);
			const canvas = document.createElement('canvas');
			const ctx = canvas.getContext('2d')!;
			ctx.font = computedStyle.fontSize + ' ' + computedStyle.fontFamily;
			const textWidth = ctx.measureText(labelText).width;
			// Position below the label with a small gap
			// Arrow is at left: 12px in CSS, arrow tip is ~5px from that point
			const arrowTipOffset = 17; // 12px + 5px for arrow center
			const textCenter = labelRect.left + (textWidth / 2);
			popup.style.top = (labelRect.bottom + 8) + 'px';
			popup.style.left = (textCenter - arrowTipOffset) + 'px';
		}
		
		// Open this popup
		popup.classList.add('is-open');
		
		// Adjust if popup goes off-screen
		setTimeout(() => {
			try {
				const popupRect = popup.getBoundingClientRect();
				const viewportWidth = window.innerWidth;
				const viewportHeight = window.innerHeight;
				
				// Adjust horizontal position if off-screen to the right
				if (popupRect.right > viewportWidth - 8) {
					popup.style.left = Math.max(8, viewportWidth - popupRect.width - 8) + 'px';
				}
				
				// Adjust vertical position if off-screen at the bottom
				if (popupRect.bottom > viewportHeight - 8) {
					// Try positioning above the label instead
					const label = document.getElementById(id + '_chart_' + ax + '_label') as any;
					if (label) {
						const labelRect = label.getBoundingClientRect();
						const newTop = labelRect.top - popupRect.height - 8;
						if (newTop > 8) {
							popup.style.top = newTop + 'px';
							popup.classList.add('is-above');
						}
					}
				}
			} catch { /* ignore */ }
		}, 0);
		
		// Sync UI with current state
		__kustoSyncAxisSettingsUI(id, ax);
		
		// Add scroll listener to reposition popup when document scrolls
		const repositionOnScroll = () => {
			try {
				if (!popup.classList.contains('is-open')) {
					window.removeEventListener('scroll', repositionOnScroll, true);
					return;
				}
				const label = document.getElementById(id + '_chart_' + ax + '_label') as any;
				if (label) {
					const labelRect = label.getBoundingClientRect();
					const popupRect = popup.getBoundingClientRect();
					const isAbove = popup.classList.contains('is-above');
					// Measure actual text width to center arrow on text
					const labelText = label.textContent || '';
					const computedStyle = window.getComputedStyle(label);
					const canvas = document.createElement('canvas');
					const ctx = canvas.getContext('2d')!;
					ctx.font = computedStyle.fontSize + ' ' + computedStyle.fontFamily;
					const textWidth = ctx.measureText(labelText).width;
					const arrowTipOffset = 17;
					const textCenter = labelRect.left + (textWidth / 2);
					if (isAbove) {
						popup.style.top = (labelRect.top - popupRect.height - 8) + 'px';
					} else {
						popup.style.top = (labelRect.bottom + 8) + 'px';
					}
					popup.style.left = (textCenter - arrowTipOffset) + 'px';
				}
			} catch { /* ignore */ }
		};
		window.addEventListener('scroll', repositionOnScroll, true);
		
		// Add click-outside listener
		setTimeout(() => {
			const closeOnClickOutside = (e: any) => {
				try {
					// Check if click is inside the popup
					if (popup.contains(e.target)) return;
					// Check if click is on the label that toggles the popup
					const label = document.getElementById(id + '_chart_' + ax + '_label') as any;
					if (label && label.contains(e.target)) return;
					// Check if click is inside a dropdown menu or on a dropdown item (they use position:fixed and are outside popup DOM)
					if ((e.target as any).closest && ((e.target as any).closest('.kusto-dropdown-menu') || (e.target as any).closest('.kusto-dropdown-item'))) return;
					popup.classList.remove('is-open');
					popup.classList.remove('is-above');
					document.removeEventListener('click', closeOnClickOutside);
					window.removeEventListener('scroll', repositionOnScroll, true);
				} catch { /* ignore */ }
			};
			document.addEventListener('click', closeOnClickOutside);
		}, 0);
	} catch { /* ignore */ }
}

/**
 * Close a specific axis settings popup.
 */
function __kustoCloseAxisSettingsPopup( boxId: any, axis: any) {
	const id = String(boxId || '');
	const ax = String(axis || '').toLowerCase();
	if (!id || !ax) return;
	
	try {
		const popup = document.getElementById(id + '_chart_' + ax + '_settings_popup') as any;
		if (popup) {
			popup.classList.remove('is-open');
			popup.classList.remove('is-above');
		}
	} catch { /* ignore */ }
}

/**
 * Close all axis settings popups.
 */
function __kustoCloseAllAxisSettingsPopups() {
	try {
		const popups = document.querySelectorAll('.kusto-axis-settings-popup.is-open');
		for (const popup of popups) {
			try {
				popup.classList.remove('is-open');
				popup.classList.remove('is-above');
			} catch { /* ignore */ }
		}
	} catch { /* ignore */ }
}

/**
 * Toggle the label settings popup visibility for pie/funnel charts.
 */
function __kustoToggleLabelSettingsPopup( boxId: any) {
	const id = String(boxId || '');
	if (!id) return;
	
	try {
		const popup = document.getElementById(id + '_chart_label_settings_popup') as any;
		if (!popup) return;
		
		const isOpen = popup.classList.contains('is-open');
		
		// Close all other popups first
		try { __kustoCloseAllAxisSettingsPopups(); } catch { /* ignore */ }
		
		if (isOpen) {
			// Was open, now closed (by closeAll above)
			return;
		}
		
		// Position the popup using fixed positioning relative to the "Labels" text
		const toggle = document.getElementById(id + '_chart_labels_pie_toggle') as any;
		const labelText = toggle ? toggle.querySelector('.kusto-chart-labels-toggle-text') : null;
		if (labelText) {
			const labelRect = labelText.getBoundingClientRect();
			// Position below the label with a small gap
			const arrowTipOffset = 17; // 12px + 5px for arrow center
			const textCenter = labelRect.left + (labelRect.width / 2);
			popup.style.top = (labelRect.bottom + 8) + 'px';
			popup.style.left = (textCenter - arrowTipOffset) + 'px';
		}
		
		// Open this popup
		popup.classList.add('is-open');
		
		// Sync UI with current state
		__kustoSyncLabelSettingsUI(id);
		
		// Adjust if popup goes off-screen
		setTimeout(() => {
			try {
				const popupRect = popup.getBoundingClientRect();
				const viewportWidth = window.innerWidth;
				const viewportHeight = window.innerHeight;
				
				// Adjust horizontal position if off-screen to the right
				if (popupRect.right > viewportWidth - 8) {
					popup.style.left = Math.max(8, viewportWidth - popupRect.width - 8) + 'px';
				}
				
				// Adjust vertical position if off-screen at the bottom
				if (popupRect.bottom > viewportHeight - 8) {
					const toggle = document.getElementById(id + '_chart_labels_pie_toggle') as any;
					const labelText = toggle ? toggle.querySelector('.kusto-chart-labels-toggle-text') : null;
					if (labelText) {
						const labelRect = labelText.getBoundingClientRect();
						const newTop = labelRect.top - popupRect.height - 8;
						if (newTop > 8) {
							popup.style.top = newTop + 'px';
							popup.classList.add('is-above');
						}
					}
				}
			} catch { /* ignore */ }
		}, 0);
		
		// Add click-outside listener
		setTimeout(() => {
			const closeOnClickOutside = (e: any) => {
				try {
					// Check if click is inside the popup
					if (popup.contains(e.target)) return;
					// Check if click is on the label text that toggles the popup
					const toggle = document.getElementById(id + '_chart_labels_pie_toggle') as any;
					const labelText = toggle ? toggle.querySelector('.kusto-chart-labels-toggle-text') : null;
					if (labelText && labelText.contains(e.target)) return;
					// Check if click is inside a dropdown menu
					if ((e.target as any).closest && ((e.target as any).closest('.kusto-dropdown-menu') || (e.target as any).closest('.kusto-dropdown-item'))) return;
					popup.classList.remove('is-open');
					popup.classList.remove('is-above');
					document.removeEventListener('click', closeOnClickOutside);
				} catch { /* ignore */ }
			};
			document.addEventListener('click', closeOnClickOutside);
		}, 0);
	} catch { /* ignore */ }
}

/**
 * Close the label settings popup.
 */
function __kustoCloseLabelSettingsPopup( boxId: any) {
	const id = String(boxId || '');
	if (!id) return;
	
	try {
		const popup = document.getElementById(id + '_chart_label_settings_popup') as any;
		if (popup) {
			popup.classList.remove('is-open');
			popup.classList.remove('is-above');
		}
	} catch { /* ignore */ }
}

/**
 * Sync the label settings popup UI with current state.
 */
function __kustoSyncLabelSettingsUI( boxId: any) {
	const id = String(boxId || '');
	if (!id) return;
	
	try {
		const st = __kustoGetChartState(id);
		const mode = st.labelMode || 'auto';
		const density = typeof st.labelDensity === 'number' ? st.labelDensity : 50;
		
		// Sync mode dropdown
		const modeEl = document.getElementById(id + '_chart_label_mode') as any;
		if (modeEl) {
			modeEl.value = mode;
			try { (window as any).__kustoDropdown.syncSelectBackedDropdown(id + '_chart_label_mode'); } catch { /* ignore */ }
		}
		
		// Sync density slider
		const densityEl = document.getElementById(id + '_chart_label_density') as any;
		const densityValueEl = document.getElementById(id + '_chart_label_density_value') as any;
		if (densityEl) {
			densityEl.value = density;
		}
		if (densityValueEl) {
			densityValueEl.textContent = density + '%';
		}
		
		// Show/hide density slider based on mode
		const densityRow = document.getElementById(id + '_chart_label_density_row') as any;
		if (densityRow) {
			densityRow.style.display = (mode === 'auto') ? '' : 'none';
		}
		
		// Update indicator
		__kustoUpdateLabelSettingsIndicator(id);
	} catch { /* ignore */ }
}

/**
 * Check if label settings have been customized from defaults.
 */
function __kustoHasCustomLabelSettings( st: any) {
	if (!st) return false;
	const mode = st.labelMode || 'auto';
	const density = typeof st.labelDensity === 'number' ? st.labelDensity : 50;
	// Has custom if mode is not 'auto' OR if density differs from default (50)
	return mode !== 'auto' || density !== 50;
}

/**
 * Update the visual indicator on the Labels text showing if it has custom settings.
 */
function __kustoUpdateLabelSettingsIndicator( boxId: any) {
	const id = String(boxId || '');
	if (!id) return;
	
	try {
		const toggle = document.getElementById(id + '_chart_labels_pie_toggle') as any;
		const labelText = toggle ? toggle.querySelector('.kusto-chart-labels-toggle-text') : null;
		if (!labelText) return;
		
		const st = __kustoGetChartState(id);
		const hasCustom = __kustoHasCustomLabelSettings(st);
		
		if (hasCustom) {
			labelText.classList.add('has-settings');
		} else {
			labelText.classList.remove('has-settings');
		}
	} catch { /* ignore */ }
}

/**
 * Sync the axis settings popup UI with current state.
 */
function __kustoSyncAxisSettingsUI( boxId: any, axis: any) {
	const id = String(boxId || '');
	const ax = String(axis || '').toLowerCase();
	if (!id || !ax) return;
	
	try {
		const st = __kustoGetChartState(id);
		const settings = ax === 'x' 
			? (st.xAxisSettings || __kustoGetDefaultAxisSettings())
			: (st.yAxisSettings || __kustoGetDefaultYAxisSettings());
		
		if (ax === 'x') {
			// X-axis specific: Sort direction
			const sortEl = document.getElementById(id + '_chart_' + ax + '_sort') as any;
			if (sortEl) {
				sortEl.value = settings.sortDirection || '';
				try { (window as any).__kustoDropdown.syncSelectBackedDropdown(id + '_chart_' + ax + '_sort'); } catch { /* ignore */ }
			}
			
			// X-axis specific: Scale type
			const scaleEl = document.getElementById(id + '_chart_' + ax + '_scale') as any;
			if (scaleEl) {
				scaleEl.value = settings.scaleType || '';
				try { (window as any).__kustoDropdown.syncSelectBackedDropdown(id + '_chart_' + ax + '_scale'); } catch { /* ignore */ }
			}
			
			// X-axis specific: Label density slider (100 = All/show all, 1 = minimum density)
			const densitySlider = document.getElementById(id + '_chart_' + ax + '_density') as any;
			if (densitySlider) {
				const densityValue = typeof settings.labelDensity === 'number' ? settings.labelDensity : 100;
				densitySlider.value = Math.max(1, densityValue); // Clamp to minimum of 1
				// Update the displayed value
				const densityValueEl = document.getElementById(id + '_chart_' + ax + '_density_value') as any;
				if (densityValueEl) {
					if (densityValue >= 100) {
						densityValueEl.textContent = 'All';
					} else {
						densityValueEl.textContent = Math.max(1, densityValue) + '%';
					}
				}
			}
			
			// X-axis specific: Title gap slider
			const xTitleGapSlider = document.getElementById(id + '_chart_' + ax + '_title_gap') as any;
			if (xTitleGapSlider) {
				const defaults = __kustoGetDefaultAxisSettings();
				const titleGapValue = typeof settings.titleGap === 'number' ? settings.titleGap : defaults.titleGap;
				xTitleGapSlider.value = titleGapValue;
				const titleGapValueEl = document.getElementById(id + '_chart_' + ax + '_title_gap_value') as any;
				if (titleGapValueEl) {
					titleGapValueEl.textContent = titleGapValue;
				}
			}
			
			// Show/hide title gap row based on show axis label setting
			const xTitleGapRow = document.getElementById(id + '_chart_' + ax + '_title_gap_row') as any;
			if (xTitleGapRow) {
				xTitleGapRow.style.display = (settings.showAxisLabel !== false) ? '' : 'none';
			}
		} else if (ax === 'y') {
			// Y-axis specific: Min value
			const minEl = document.getElementById(id + '_chart_' + ax + '_min') as any;
			if (minEl) {
				minEl.value = settings.min !== undefined && settings.min !== null ? String(settings.min) : '';
			}
			
			// Y-axis specific: Max value
			const maxEl = document.getElementById(id + '_chart_' + ax + '_max') as any;
			if (maxEl) {
				maxEl.value = settings.max !== undefined && settings.max !== null ? String(settings.max) : '';
			}
			
			// Y-axis specific: Series colors
			__kustoUpdateSeriesColorsUI(id, settings);
			
			// Y-axis specific: Title gap slider
			const yTitleGapSlider = document.getElementById(id + '_chart_' + ax + '_title_gap') as any;
			if (yTitleGapSlider) {
				const defaults = __kustoGetDefaultYAxisSettings();
				const titleGapValue = typeof settings.titleGap === 'number' ? settings.titleGap : defaults.titleGap;
				yTitleGapSlider.value = titleGapValue;
				const titleGapValueEl = document.getElementById(id + '_chart_' + ax + '_title_gap_value') as any;
				if (titleGapValueEl) {
					titleGapValueEl.textContent = titleGapValue;
				}
			}
			
			// Show/hide title gap row based on show axis label setting
			const yTitleGapRow = document.getElementById(id + '_chart_' + ax + '_title_gap_row') as any;
			if (yTitleGapRow) {
				yTitleGapRow.style.display = (settings.showAxisLabel !== false) ? '' : 'none';
			}
		}
		
		// Common: Show axis label checkbox
		const showLabelEl = document.getElementById(id + '_chart_' + ax + '_show_axis_label') as any;
		if (showLabelEl) showLabelEl.checked = settings.showAxisLabel !== false;
		
		// Common: Custom label input - update placeholder with actual column name
		const customLabelEl = document.getElementById(id + '_chart_' + ax + '_custom_label') as any;
		if (customLabelEl) {
			customLabelEl.value = settings.customLabel || '';
			// Get the current column name for the placeholder
			try {
				if (ax === 'x') {
					const xSelectEl = document.getElementById(id + '_chart_x') as any;
					if (xSelectEl && xSelectEl.value) {
						customLabelEl.placeholder = xSelectEl.value;
					} else {
						customLabelEl.placeholder = 'Column name';
					}
				} else {
					// For Y-axis, try to get a meaningful name from selected Y columns
					const st = __kustoGetChartState(id);
					if (st.yColumns && st.yColumns.length === 1) {
						customLabelEl.placeholder = st.yColumns[0];
					} else if (st.yColumns && st.yColumns.length > 1) {
						customLabelEl.placeholder = 'Value';
					} else {
						customLabelEl.placeholder = 'Column name';
					}
				}
			} catch {
				customLabelEl.placeholder = 'Column name';
			}
		}
		
		// Common: Show/hide custom label row based on checkbox
		const customLabelRow = document.getElementById(id + '_chart_' + ax + '_custom_label_row') as any;
		if (customLabelRow) {
			customLabelRow.style.display = (settings.showAxisLabel !== false) ? '' : 'none';
		}
		
		// Update label indicator
		__kustoUpdateAxisLabelIndicator(id, ax);
	} catch { /* ignore */ }
}

/**
 * Update the visual indicator on the axis label showing if it has custom settings.
 */
function __kustoUpdateAxisLabelIndicator( boxId: any, axis: any) {
	const id = String(boxId || '');
	const ax = String(axis || '').toLowerCase();
	if (!id || !ax) return;
	
	try {
		const label = document.getElementById(id + '_chart_' + ax + '_label') as any;
		if (!label) return;
		
		const st = __kustoGetChartState(id);
		let hasCustom = false;
		if (ax === 'x') {
			const settings = st.xAxisSettings || __kustoGetDefaultAxisSettings();
			hasCustom = __kustoHasCustomAxisSettings(settings);
		} else if (ax === 'y') {
			const settings = st.yAxisSettings || __kustoGetDefaultYAxisSettings();
			hasCustom = __kustoHasCustomYAxisSettings(settings);
		}
		
		if (hasCustom) {
			label.classList.add('has-settings');
		} else {
			label.classList.remove('has-settings');
		}
	} catch { /* ignore */ }
}

/**
 * Handle axis setting change from the popup UI.
 */
function __kustoOnAxisSettingChanged( boxId: any, axis: any, setting: any, value: any) {
	const id = String(boxId || '');
	const ax = String(axis || '').toLowerCase();
	const key = String(setting || '');
	if (!id || !ax || !key) return;
	
	try {
		const st = __kustoGetChartState(id);
		if (ax === 'x') {
			if (!st.xAxisSettings || typeof st.xAxisSettings !== 'object') {
				st.xAxisSettings = __kustoGetDefaultAxisSettings();
			}
			
			// Handle different setting types
			if (key === 'showAxisLabel') {
				st.xAxisSettings.showAxisLabel = !!value;
				// Show/hide custom label row
				const customLabelRow = document.getElementById(id + '_chart_x_custom_label_row') as any;
				if (customLabelRow) {
					customLabelRow.style.display = value ? '' : 'none';
				}
				// Show/hide title gap row
				const titleGapRow = document.getElementById(id + '_chart_x_title_gap_row') as any;
				if (titleGapRow) {
					titleGapRow.style.display = value ? '' : 'none';
				}
			} else if (key === 'labelDensity') {
				// Update slider value display (100 = All/show all, 1 = minimum density)
				const densityValue = typeof value === 'number' ? Math.max(1, value) : 100;
				st.xAxisSettings.labelDensity = densityValue;
				const densityValueEl = document.getElementById(id + '_chart_x_density_value') as any;
				if (densityValueEl) {
					if (densityValue >= 100) {
						densityValueEl.textContent = 'All';
					} else {
						densityValueEl.textContent = densityValue + '%';
					}
				}
			} else if (key === 'titleGap') {
				// Update slider value display
				const titleGapValue = typeof value === 'number' ? value : 30;
				st.xAxisSettings.titleGap = titleGapValue;
				const titleGapValueEl = document.getElementById(id + '_chart_x_title_gap_value') as any;
				if (titleGapValueEl) {
					titleGapValueEl.textContent = titleGapValue;
				}
			} else {
				st.xAxisSettings[key] = value;
			}
		} else if (ax === 'y') {
			if (!st.yAxisSettings || typeof st.yAxisSettings !== 'object') {
				st.yAxisSettings = __kustoGetDefaultYAxisSettings();
			}
			
			// Handle different setting types
			if (key === 'showAxisLabel') {
				st.yAxisSettings.showAxisLabel = !!value;
				// Show/hide custom label row
				const customLabelRow = document.getElementById(id + '_chart_y_custom_label_row') as any;
				if (customLabelRow) {
					customLabelRow.style.display = value ? '' : 'none';
				}
				// Show/hide title gap row
				const titleGapRow = document.getElementById(id + '_chart_y_title_gap_row') as any;
				if (titleGapRow) {
					titleGapRow.style.display = value ? '' : 'none';
				}
			} else if (key === 'min' || key === 'max') {
				// Store min/max as string (can be empty for auto)
				st.yAxisSettings[key] = value !== undefined && value !== null ? String(value).trim() : '';
			} else if (key === 'titleGap') {
				// Update slider value display
				const titleGapValue = typeof value === 'number' ? value : 45;
				st.yAxisSettings.titleGap = titleGapValue;
				const titleGapValueEl = document.getElementById(id + '_chart_y_title_gap_value') as any;
				if (titleGapValueEl) {
					titleGapValueEl.textContent = titleGapValue;
				}
			} else {
				st.yAxisSettings[key] = value;
			}
		}
		
		// Update indicator and re-render chart
		__kustoUpdateAxisLabelIndicator(id, ax);
		try { __kustoRenderChart(id); } catch { /* ignore */ }
		// Use immediate persist for axis settings to avoid losing changes on quick close
		try { _win.schedulePersist && _win.schedulePersist('axisSettingChanged', true); } catch { /* ignore */ }
	} catch { /* ignore */ }
}

/**
 * Reset axis settings to defaults.
 */
function __kustoResetAxisSettings( boxId: any, axis: any) {
	const id = String(boxId || '');
	const ax = String(axis || '').toLowerCase();
	if (!id || !ax) return;
	
	try {
		const st = __kustoGetChartState(id);
		if (ax === 'x') {
			st.xAxisSettings = __kustoGetDefaultAxisSettings();
		} else if (ax === 'y') {
			st.yAxisSettings = __kustoGetDefaultYAxisSettings();
		}
		
		// Sync UI and re-render
		__kustoSyncAxisSettingsUI(id, ax);
		try { __kustoRenderChart(id); } catch { /* ignore */ }
		// Use immediate persist for axis settings to avoid losing changes on quick close
		try { _win.schedulePersist && _win.schedulePersist('axisSettingReset', true); } catch { /* ignore */ }
	} catch { /* ignore */ }
}

/**
 * Computes the minimum resize height for a Chart section wrapper.
 * Accounts for: controls panel height (in Edit mode) + chart canvas min-height.
 * @param {string} boxId - The chart box ID
 * @returns {number} Minimum height in pixels
 */
function __kustoGetChartMinResizeHeight( boxId: any) {
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
				if (typeof _win.__kustoGetResultsState !== 'function') continue;
				const st = _win.__kustoGetResultsState(id);
				const cols = st && Array.isArray(st.columns) ? st.columns : [];
				const rows = st && Array.isArray(st.rows) ? st.rows : [];
				if (!cols.length) continue;
				let name = '';
				try {
					name = String(((document.getElementById(id + '_name') as any || {}).value || '')).trim();
				} catch { /* ignore */ }
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
			} catch { /* ignore */ }
		}
	} catch {
		// ignore
	}
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
					__kustoUpdateChartBuilderUI(id);
				} else if (id.startsWith('transformation_')) {
					__kustoUpdateTransformationBuilderUI(id);
				}
			} catch { /* ignore */ }
		}
	} catch { /* ignore */ }
}

// Expose globally for use by main.js reorder logic
try { (window as any).__kustoRefreshAllDataSourceDropdowns = __kustoRefreshAllDataSourceDropdowns; } catch { /* ignore */ }

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
		const st = __kustoGetChartState(id);
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
		try { __kustoUpdateChartBuilderUI(id); } catch { /* ignore */ }
		try { __kustoRenderChart(id); } catch { /* ignore */ }
		
		// Persist changes
		try { if (typeof _win.schedulePersist === 'function') _win.schedulePersist(); } catch { /* ignore */ }
		
		return true;
	} catch (err: any) {
		console.error('[Kusto] Error configuring chart:', err);
		return false;
	}
}

// Expose for tool calls from main.js
try { (window as any).__kustoConfigureChart = __kustoConfigureChartFromTool; } catch { /* ignore */ }

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
		
		const st = __kustoGetChartState(id);
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
				if (typeof _win.__kustoGetResultsState === 'function') {
					const dsState = _win.__kustoGetResultsState(dataSourceId);
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
				}
			} catch { /* ignore */ }
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
try { (window as any).__kustoGetChartValidationStatus = __kustoGetChartValidationStatus; } catch { /* ignore */ }

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
function __kustoConfigureTransformationFromTool( boxId: any, config: any) {
	try {
		const id = String(boxId || '');
		if (!id) return false;
		if (!config || typeof config !== 'object') return false;

		// Lit element: delegate to its configure() method.
		try {
			const el = document.getElementById(id) as any;
			if (el && typeof el.configure === 'function') {
				return el.configure(config);
			}
		} catch { /* ignore */ }
		
		// Ensure state object exists
		const st = __kustoGetTransformationState(id);
		if (!st) return false;
		
		// Apply configuration properties
		if (typeof config.dataSourceId === 'string') {
			st.dataSourceId = config.dataSourceId;
		}
		if (typeof config.transformationType === 'string') {
			st.transformationType = config.transformationType;
		}
		
		// Derive columns
		if (Array.isArray(config.deriveColumns)) {
			st.deriveColumns = config.deriveColumns.map((c: any) => ({
				name: String(c.name || ''),
				expression: String(c.expression || '')
			}));
		}
		
		// Distinct
		if (typeof config.distinctColumn === 'string') {
			st.distinctColumn = config.distinctColumn;
		}
		
		// Summarize
		if (Array.isArray(config.groupByColumns)) {
			st.groupByColumns = config.groupByColumns.map((c: any) => String(c));
		}
		if (Array.isArray(config.aggregations)) {
			st.aggregations = config.aggregations.map((a: any) => ({
				function: String(a.function || 'count'),
				column: String(a.column || ''),
				alias: a.alias ? String(a.alias) : undefined
			}));
		}
		
		// Pivot
		if (typeof config.pivotRowKeyColumn === 'string') {
			st.pivotRowKeyColumn = config.pivotRowKeyColumn;
		}
		if (typeof config.pivotColumnKeyColumn === 'string') {
			st.pivotColumnKeyColumn = config.pivotColumnKeyColumn;
		}
		if (typeof config.pivotValueColumn === 'string') {
			st.pivotValueColumn = config.pivotValueColumn;
		}
		if (typeof config.pivotAggregation === 'string') {
			st.pivotAggregation = config.pivotAggregation;
		}
		if (typeof config.pivotMaxColumns === 'number') {
			st.pivotMaxColumns = config.pivotMaxColumns;
		}
		
		// Update the UI to reflect new state
		try { __kustoUpdateTransformationBuilderUI(id); } catch { /* ignore */ }
		
		// Re-render the transformation
		try { __kustoRenderTransformation(id); } catch { /* ignore */ }
		
		// Persist changes
		try { if (typeof _win.schedulePersist === 'function') _win.schedulePersist(); } catch { /* ignore */ }
		
		return true;
	} catch (err: any) {
		console.error('[Kusto] Error configuring transformation:', err);
		return false;
	}
}

// Expose for tool calls from main.js
try { (window as any).__kustoConfigureTransformation = __kustoConfigureTransformationFromTool; } catch { /* ignore */ }

function __kustoGetRawCellValueForChart( cell: any) {
	try {
		if (typeof _win.__kustoGetRawCellValue === 'function') {
			return _win.__kustoGetRawCellValue(cell);
		}
	} catch { /* ignore */ }
	try {
		if (cell && typeof cell === 'object') {
			if ('full' in cell && cell.full !== undefined && cell.full !== null) return cell.full;
			if ('display' in cell && cell.display !== undefined && cell.display !== null) return cell.display;
		}
	} catch { /* ignore */ }
	return cell;
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
	try {
		const r = Array.isArray(rows) ? rows : [];
		let seen = 0;
		let dateCount = 0;
		for (let i = 0; i < r.length && seen < 50; i++) {
			const row = r[i];
			if (!row) continue;
			const raw = __kustoGetRawCellValueForChart(row[xIndex]);
			if (raw === null || raw === undefined) continue;
			const s = String(raw).trim();
			if (!s) continue;
			seen++;
			const t = __kustoCellToChartTimeMs(raw);
			if (typeof t === 'number' && Number.isFinite(t)) dateCount++;
		}
		if (seen === 0) return false;
		return (dateCount / seen) >= 0.8;
	} catch {
		return false;
	}
}

function __kustoNormalizeResultsColumnName( c: any) {
	try {
		if (typeof c === 'string') return c;
		if (c && typeof c === 'object') {
			if (typeof c.name === 'string') return c.name;
			if (typeof c.columnName === 'string') return c.columnName;
		}
	} catch { /* ignore */ }
	return '';
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
			const escVal = (typeof _win.escapeHtml === 'function') ? _win.escapeHtml(s) : s;
			const escLabel = (typeof _win.escapeHtml === 'function') ? _win.escapeHtml(labelText) : labelText;
			html += '<option value="' + escVal + '">' + escLabel + '</option>';
		}
		if (!html) {
			html = '<option value="">(select)</option>';
		}
		selectEl.innerHTML = html;
		selectEl.value = selected;
	} catch {
		// ignore
	}
}

function __kustoPickFirstNonEmpty( arr: any) {
	try {
		for (const v of (arr || [])) {
			const s = String(v || '');
			if (s) return s;
		}
	} catch { /* ignore */ }
	return '';
}

function __kustoUpdateChartBuilderUI( boxId: any) {
	const id = String(boxId || '');
	if (!id) return;
	const st = __kustoGetChartState(id);
	const datasets = __kustoGetChartDatasetsInDomOrder();
	const dsSelect = document.getElementById(id + '_chart_ds') as any;
	try {
		if (dsSelect) {
			let html = '<option value="">(select)</option>';
			for (const ds of datasets) {
				const value = String(ds.id || '');
				const label = String(ds.label || value);
				const escValue = (typeof _win.escapeHtml === 'function') ? _win.escapeHtml(value) : value;
				const escLabel = (typeof _win.escapeHtml === 'function') ? _win.escapeHtml(label) : label;
				html += '<option value="' + escValue + '">' + escLabel + '</option>';
			}
			dsSelect.innerHTML = html;
			// Restore selection from state. Use unescaped value since browser parses HTML attributes.
			const desired = (typeof st.dataSourceId === 'string') ? st.dataSourceId : '';
			dsSelect.value = desired;
			// If setting value failed (option doesn't exist), try to find a matching option manually.
			if (dsSelect.value !== desired && desired) {
				for (const opt of dsSelect.options) {
					if (opt.value === desired) {
						dsSelect.value = desired;
						break;
					}
				}
			}
		}
	} catch { /* ignore */ }
	// Sync the unified dropdown button text for Data.
	try { (window as any).__kustoDropdown.syncSelectBackedDropdown(id + '_chart_ds'); } catch { /* ignore */ }

	// Update chart type picker selection (visual buttons)
	try {
		const picker = document.getElementById(id + '_chart_type_picker') as any;
		if (picker) {
			const buttons = picker.querySelectorAll('.kusto-chart-type-btn');
			const currentType = (typeof st.chartType === 'string') ? String(st.chartType) : '';
			for (const btn of buttons) {
				const btnType = btn.getAttribute('data-type') || '';
				btn.classList.toggle('is-active', btnType === currentType);
				btn.setAttribute('aria-pressed', btnType === currentType ? 'true' : 'false');
			}
		}
	} catch { /* ignore */ }

	// Update data labels toggle switch
	try {
		const labelsToggle = document.getElementById(id + '_chart_labels_toggle') as any;
		if (labelsToggle) {
			labelsToggle.classList.toggle('is-active', !!st.showDataLabels);
			labelsToggle.setAttribute('aria-checked', st.showDataLabels ? 'true' : 'false');
		}
		const labelsTogglePie = document.getElementById(id + '_chart_labels_pie_toggle') as any;
		if (labelsTogglePie) {
			labelsTogglePie.classList.toggle('is-active', !!st.showDataLabels);
			labelsTogglePie.setAttribute('aria-checked', st.showDataLabels ? 'true' : 'false');
		}
	} catch { /* ignore */ }

	// Update pie/funnel label mode dropdown
	try {
		const labelModeSelect = document.getElementById(id + '_chart_label_mode') as any;
		const labelModeText = document.getElementById(id + '_chart_label_mode_text') as any;
		if (labelModeSelect) {
			const mode = st.labelMode || 'auto';
			labelModeSelect.value = mode;
			if (labelModeText) {
				const opt = labelModeSelect.options[labelModeSelect.selectedIndex];
				labelModeText.textContent = opt ? opt.text : 'Auto (smart)';
			}
			// Also sync dropdown if it exists
			try { (window as any).__kustoDropdown.syncSelectBackedDropdown(id + '_chart_label_mode'); } catch { /* ignore */ }
		}
	} catch { /* ignore */ }

	let ds = null;
	try {
		const desired = (typeof st.dataSourceId === 'string') ? st.dataSourceId : '';
		ds = datasets.find((d: any) => String(d.id) === desired) || null;
	} catch { /* ignore */ }

	const colNames = (() => {
		try {
			const cols = ds && Array.isArray(ds.columns) ? ds.columns : [];
			return cols.map(__kustoNormalizeResultsColumnName).filter(Boolean);
		} catch {
			return [];
		}
	})();

	const mappingLineHost = document.getElementById(id + '_chart_mapping_xy') as any;
	const mappingPieHost = document.getElementById(id + '_chart_mapping_pie') as any;
	const chartType = (typeof st.chartType === 'string') ? String(st.chartType) : '';
	// Tag mapping containers so CSS can apply chart-type-specific layout tweaks.
	try {
		if (mappingLineHost) mappingLineHost.setAttribute('data-chart-type', chartType);
		if (mappingPieHost) mappingPieHost.setAttribute('data-chart-type', chartType);
	} catch { /* ignore */ }
	try {
		if (mappingLineHost) mappingLineHost.style.display = (chartType === 'line' || chartType === 'area' || chartType === 'bar' || chartType === 'scatter') ? '' : 'none';
		if (mappingPieHost) mappingPieHost.style.display = (chartType === 'pie' || chartType === 'funnel') ? '' : 'none';
	} catch { /* ignore */ }

	// Legend column selection only applies to line/area/bar.
	try {
		const legendGroup = document.getElementById(id + '_chart_legend_group') as any;
		if (legendGroup) {
			legendGroup.style.display = (chartType === 'line' || chartType === 'area' || chartType === 'bar') ? '' : 'none';
		}
	} catch { /* ignore */ }

	// Populate X select with (none) option.
	let desiredX = '';
	try { desiredX = String(((document.getElementById(id + '_chart_x') as any || {}).value || st.xColumn || '')).trim(); } catch { desiredX = String(st.xColumn || ''); }
	const xOptions = ['', ...colNames.filter((c: any) => c)];
	__kustoSetSelectOptions(document.getElementById(id + '_chart_x'), xOptions, desiredX, { '': '(none)' });
	// Sync the unified dropdown button text for X.
	try { (window as any).__kustoDropdown.syncSelectBackedDropdown(id + '_chart_x'); } catch { /* ignore */ }

	// Populate Y checkbox dropdown (for line/area/bar).
	const yMenu = document.getElementById(id + '_chart_y_menu') as any;
	if (yMenu) {
		const yOptions = colNames.filter((c: any) => c && c !== desiredX);
		// Get currently selected Y columns from state.
		let desiredYCols = Array.isArray(st.yColumns) ? st.yColumns.filter((c: any) => c) : [];
		// Fall back to single yColumn if no array.
		if (!desiredYCols.length && st.yColumn) {
			desiredYCols = [st.yColumn];
		}
		// Build checkbox items.
		const items = yOptions.map((c: any) => ({
			key: c,
			label: c,
			checked: desiredYCols.includes(c)
		}));
		try {
			yMenu.innerHTML = (window as any).__kustoDropdown.renderCheckboxItemsHtml(items, {
				dropdownId: id + '_chart_y',
				onChangeJs: '__kustoOnChartYCheckboxChanged'
			});
		} catch {
			yMenu.innerHTML = '<div class="kusto-dropdown-empty">No columns available.</div>';
		}
		// Update button text.
		const selected = desiredYCols.filter((c: any) => yOptions.includes(c));
		try {
			(window as any).__kustoDropdown.updateCheckboxButtonText(id + '_chart_y_text', selected, 'Select...');
		} catch { /* ignore */ }
	}

	// Populate Tooltip checkbox dropdown (for all chart types).
	const isPieOrFunnel = (chartType === 'pie' || chartType === 'funnel');
	const tooltipMenuId = isPieOrFunnel ? (id + '_chart_tooltip_pie_menu') : (id + '_chart_tooltip_menu');
	const tooltipTextId = isPieOrFunnel ? (id + '_chart_tooltip_pie_text') : (id + '_chart_tooltip_text');
	const tooltipMenu = document.getElementById(tooltipMenuId) as any;
	if (tooltipMenu) {
		const tooltipOptions = colNames.filter((c: any) => c);
		let desiredTooltipCols = Array.isArray(st.tooltipColumns) ? st.tooltipColumns.filter((c: any) => c) : [];
		// Filter invalid selections to avoid persisting phantom columns.
		desiredTooltipCols = desiredTooltipCols.filter((c: any) => tooltipOptions.includes(c));
		try { st.tooltipColumns = desiredTooltipCols; } catch { /* ignore */ }
		const items = tooltipOptions.map((c: any) => ({
			key: c,
			label: c,
			checked: desiredTooltipCols.includes(c)
		}));
		try {
			tooltipMenu.innerHTML = (window as any).__kustoDropdown.renderCheckboxItemsHtml(items, {
				dropdownId: isPieOrFunnel ? (id + '_chart_tooltip_pie') : (id + '_chart_tooltip'),
				onChangeJs: '__kustoOnChartTooltipCheckboxChanged'
			});
		} catch {
			tooltipMenu.innerHTML = '<div class="kusto-dropdown-empty">No columns available.</div>';
		}
		try {
			(window as any).__kustoDropdown.updateCheckboxButtonText(tooltipTextId, desiredTooltipCols, '(none)');
		} catch { /* ignore */ }
	}

	// Legend dropdown: prepend "(none)" option for no legend grouping.
	const legendSelect = document.getElementById(id + '_chart_legend') as any;
	if (legendSelect) {
		const legendOptions = ['', ...colNames.filter((c: any) => c && c !== desiredX)];
		const yCount = (Array.isArray(st.yColumns) ? st.yColumns.filter(Boolean).length : 0) || (st.yColumn ? 1 : 0);
		const disableLegend = yCount > 1;
		if (disableLegend) {
			try { st.legendColumn = ''; } catch { /* ignore */ }
		}
		__kustoSetSelectOptions(legendSelect, legendOptions, disableLegend ? '' : ((typeof st.legendColumn === 'string') ? st.legendColumn : ''), { '': '(none)' });
		try { legendSelect.disabled = disableLegend; } catch { /* ignore */ }
		// Sync the unified dropdown button text and disabled state for Legend.
		try { (window as any).__kustoDropdown.syncSelectBackedDropdown(id + '_chart_legend'); } catch { /* ignore */ }
		// Also sync the button's disabled state.
		try {
			const legendBtn = document.getElementById(id + '_chart_legend_btn') as any;
			if (legendBtn) {
				legendBtn.disabled = disableLegend;
				legendBtn.setAttribute('aria-disabled', disableLegend ? 'true' : 'false');
			}
		} catch { /* ignore */ }
	}
	__kustoSetSelectOptions(document.getElementById(id + '_chart_label'), colNames, (typeof st.labelColumn === 'string') ? st.labelColumn : '');
	__kustoSetSelectOptions(document.getElementById(id + '_chart_value'), colNames, (typeof st.valueColumn === 'string') ? st.valueColumn : '');
	// Sync the unified dropdown button text for Label and Value.
	try { (window as any).__kustoDropdown.syncSelectBackedDropdown(id + '_chart_label'); } catch { /* ignore */ }
	try { (window as any).__kustoDropdown.syncSelectBackedDropdown(id + '_chart_value'); } catch { /* ignore */ }

	// Funnel Sort dropdown: show only for funnel chart type.
	try {
		const funnelSortGroup = document.getElementById(id + '_chart_funnel_sort_group') as any;
		if (funnelSortGroup) {
			funnelSortGroup.style.display = (chartType === 'funnel') ? '' : 'none';
		}
		if (chartType === 'funnel') {
			// Populate sort dropdown with (none) option plus all columns.
			const sortOptions = ['', ...colNames.filter((c: any) => c)];
			const currentSortCol = (typeof st.sortColumn === 'string') ? st.sortColumn : '';
			__kustoSetSelectOptions(document.getElementById(id + '_chart_funnel_sort'), sortOptions, currentSortCol, { '': '(none)' });
			try { (window as any).__kustoDropdown.syncSelectBackedDropdown(id + '_chart_funnel_sort'); } catch { /* ignore */ }
			// Update the sort UI (direction button visibility).
			try { __kustoUpdateFunnelSortUI(id); } catch { /* ignore */ }
		}
	} catch { /* ignore */ }

	// Best-effort defaults once we have a dataset.
	// Note: X column is NOT auto-assigned - user must explicitly select it.
	try {
		if (colNames.length) {
			if (chartType === 'pie' || chartType === 'funnel') {
				if (!st.labelColumn) st.labelColumn = colNames[0] || '';
				if (!st.valueColumn) st.valueColumn = __kustoPickFirstNonEmpty(colNames.slice(1)) || colNames[0] || '';
			}
		}
	} catch { /* ignore */ }

	// Update legend position button visibility based on current state.
	try { __kustoUpdateLegendPositionButtonUI(id); } catch { /* ignore */ }

	// Auto-fit if the chart canvas is being clipped after control changes.
	try { __kustoAutoFitChartIfClipped(id); } catch { /* ignore */ }
}

function __kustoGetChartActiveCanvasElementId( boxId: any) {
	const st = __kustoGetChartState(boxId);
	const mode = st && st.mode ? String(st.mode) : 'edit';
	return (mode === 'preview') ? (boxId + '_chart_canvas_preview') : (boxId + '_chart_canvas_edit');
}

function __kustoGetIsDarkThemeForEcharts() {
	try {
		if (typeof _win.isDarkTheme === 'function') {
			return !!_win.isDarkTheme();
		}
	} catch { /* ignore */ }
	try {
		const cls = document && document.body && document.body.classList;
		if (cls) {
			if (cls.contains('vscode-light') || cls.contains('vscode-high-contrast-light')) return false;
			if (cls.contains('vscode-dark') || cls.contains('vscode-high-contrast')) return true;
		}
	} catch { /* ignore */ }
	return true;
}

function __kustoFormatUtcDateTime( ms: any, showTime: any) {
	const v = (typeof ms === 'number') ? ms : Number(ms);
	if (!Number.isFinite(v)) return '';
	const d = new Date(v);
	const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
	const dd = String(d.getUTCDate()).padStart(2, '0');
	const mon = months[d.getUTCMonth()] || 'Jan';
	const yyyy = String(d.getUTCFullYear());
	const date = `${dd}-${mon}-${yyyy}`;
	if (!showTime) return date;
	const hh = String(d.getUTCHours()).padStart(2, '0');
	const mm = String(d.getUTCMinutes()).padStart(2, '0');
	const ss = String(d.getUTCSeconds()).padStart(2, '0');
	return (ss === '00') ? `${date} ${hh}:${mm}` : `${date} ${hh}:${mm}:${ss}`;
}

/**
 * Determines the best time period granularity for continuous axis labels based on the date range.
 * Returns: 'day', 'week', 'month', 'quarter', or 'year'
 */
function __kustoComputeTimePeriodGranularity( timeMsValues: any) {
	try {
		const times = (timeMsValues || []).filter((t: any) => typeof t === 'number' && Number.isFinite(t));
		if (times.length < 2) return 'day';
		
		const minT = Math.min(...times);
		const maxT = Math.max(...times);
		const rangeDays = (maxT - minT) / (1000 * 60 * 60 * 24);
		
		// Choose granularity based on date range
		if (rangeDays > 365 * 2) return 'year';      // > 2 years: show years
		if (rangeDays > 365) return 'quarter';       // > 1 year: show quarters
		if (rangeDays > 90) return 'month';          // > 3 months: show months
		if (rangeDays > 14) return 'week';           // > 2 weeks: show weeks
		return 'day';                                 // Otherwise: show days
	} catch {
		return 'day';
	}
}

/**
 * Formats a timestamp to a period boundary label based on granularity.
 */
function __kustoFormatTimePeriodLabel( ms: any, granularity: any) {
	const v = (typeof ms === 'number') ? ms : Number(ms);
	if (!Number.isFinite(v)) return '';
	const d = new Date(v);
	const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
	const yyyy = String(d.getUTCFullYear());
	const mon = months[d.getUTCMonth()] || 'Jan';
	
	switch (granularity) {
		case 'year':
			return yyyy;
		case 'quarter': {
			const q = Math.floor(d.getUTCMonth() / 3) + 1;
			return `Q${q} ${yyyy}`;
		}
		case 'month':
			return `${mon} ${yyyy}`;
		case 'week': {
			// Show the week start date (Monday)
			const dayOfWeek = d.getUTCDay();
			const diff = d.getUTCDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1);
			const weekStart = new Date(d);
			weekStart.setUTCDate(diff);
			const dd = String(weekStart.getUTCDate()).padStart(2, '0');
			const mm = months[weekStart.getUTCMonth()] || 'Jan';
			return `${dd}-${mm}`;
		}
		default: {
			// day granularity
			const dd = String(d.getUTCDate()).padStart(2, '0');
			return `${dd}-${mon}`;
		}
	}
}

/**
 * Generates axis labels for continuous time scale, showing only period boundaries.
 * Returns an array of labels with the same length as timeKeys, with empty strings for non-boundary points.
 */
function __kustoGenerateContinuousTimeLabels( timeKeys: any, granularity: any) {
	try {
		if (!timeKeys || !timeKeys.length) return [];
		
		const labels = [];
		let lastPeriodLabel = null;
		
		for (const t of timeKeys) {
			const periodLabel = __kustoFormatTimePeriodLabel(t, granularity);
			// Only show label if it's different from the previous period
			if (periodLabel !== lastPeriodLabel) {
				labels.push(periodLabel);
				lastPeriodLabel = periodLabel;
			} else {
				labels.push(''); // Empty label for points within the same period
			}
		}
		
		return labels;
	} catch {
		return timeKeys.map(() => '');
	}
}

function __kustoShouldShowTimeForUtcAxis( timeMsValues: any) {
	try {
		for (const t of (timeMsValues || [])) {
			const v = (typeof t === 'number') ? t : Number(t);
			if (!Number.isFinite(v)) continue;
			const d = new Date(v);
			if (d.getUTCHours() !== 0 || d.getUTCMinutes() !== 0 || d.getUTCSeconds() !== 0 || d.getUTCMilliseconds() !== 0) {
				return true;
			}
		}
	} catch { /* ignore */ }
	return false;
}

function __kustoComputeTimeAxisLabelRotation( axisPixelWidth: any, labelCount: any, showTime: any) {
	const w = (typeof axisPixelWidth === 'number' && Number.isFinite(axisPixelWidth)) ? axisPixelWidth : 0;
	const n = (typeof labelCount === 'number' && Number.isFinite(labelCount)) ? Math.max(0, Math.floor(labelCount)) : 0;
	if (!w || !n) return 0;

	// Our UTC format is either:
	// - DD-MMM-YYYY (11 chars)
	// - DD-MMM-YYYY HH:MM (17 chars)
	const approxChars = showTime ? 17 : 11;
	const approxCharPx = 7; // heuristic in typical VS Code fonts
	const approxLabelPx = approxChars * approxCharPx + 10; // add a bit of padding
	const maxNoRotate = Math.max(1, Math.floor(w / Math.max(1, approxLabelPx)));

	// If we have many labels relative to available width, rotate.
	// Note: bar/line/area charts use category axes where all labels are rendered,
	// so we must use the actual count — no artificial cap.
	if (n > maxNoRotate * 2) return 60;
	if (n > maxNoRotate * 1.3) return 45;
	return 0;
}

/**
 * Compute the optimal X-axis label rotation for category (non-time) labels.
 * Uses the actual label string lengths to estimate whether labels will overlap,
 * and returns an appropriate tilt angle.
 *
 * @param {number} axisPixelWidth - Available pixel width for the X axis.
 * @param {number} labelCount     - Number of labels.
 * @param {number} avgLabelChars  - Average character count across labels.
 * @param {number} maxLabelChars  - Max character count among labels.
 * @returns {number} Rotation angle in degrees (0, 30, 45, 60, or 75).
 */
function __kustoComputeCategoryLabelRotation( axisPixelWidth: any, labelCount: any, avgLabelChars: any, maxLabelChars: any) {
	const w = (typeof axisPixelWidth === 'number' && Number.isFinite(axisPixelWidth)) ? axisPixelWidth : 0;
	const n = (typeof labelCount === 'number' && Number.isFinite(labelCount)) ? Math.max(0, Math.floor(labelCount)) : 0;
	if (!w || !n) return 0;

	const avg = (typeof avgLabelChars === 'number' && Number.isFinite(avgLabelChars)) ? avgLabelChars : 6;
	const mx  = (typeof maxLabelChars === 'number' && Number.isFinite(maxLabelChars)) ? maxLabelChars : avg;

	const approxCharPx = 7; // heuristic for monospace font in VS Code webviews
	// Blend average and max so one abnormally long label doesn't dominate,
	// but we still account for it.
	const effectiveLabelChars = Math.ceil(avg * 0.6 + mx * 0.4);
	const approxLabelPx = effectiveLabelChars * approxCharPx + 12; // with padding
	const maxNoRotate = Math.max(1, Math.floor(w / Math.max(1, approxLabelPx)));

	if (n > maxNoRotate * 3) return 75;
	if (n > maxNoRotate * 2) return 60;
	if (n > maxNoRotate * 1.3) return 45;
	if (n > maxNoRotate) return 30;
	return 0;
}

/**
 * Measure label character stats from an array of label strings.
 * Returns { avgLabelChars, maxLabelChars }.
 */
function __kustoMeasureLabelChars( labels: any) {
	let total = 0, mx = 0;
	const len = labels ? labels.length : 0;
	for (let i = 0; i < len; i++) {
		const c = String(labels[i] || '').length;
		total += c;
		if (c > mx) mx = c;
	}
	return { avgLabelChars: len ? total / len : 6, maxLabelChars: mx || 6 };
}

let __kustoEchartsThemeObserverStarted = false;
let __kustoLastAppliedEchartsIsDarkTheme: any = null;

function __kustoRefreshChartsForThemeChange() {
	let dark = true;
	try { dark = __kustoGetIsDarkThemeForEcharts(); } catch { dark = true; }
	if (__kustoLastAppliedEchartsIsDarkTheme === dark) return;
	__kustoLastAppliedEchartsIsDarkTheme = dark;
	try {
		for (const id of (chartBoxes || [])) {
			try { __kustoDisposeChartEcharts(id); } catch { /* ignore */ }
			try { __kustoRenderChart(id); } catch { /* ignore */ }
			try { __kustoUpdateLegendPositionButtonUI(id); } catch { /* ignore */ }
		}
	} catch { /* ignore */ }
}

function __kustoStartEchartsThemeObserver() {
	if (__kustoEchartsThemeObserverStarted) return;
	__kustoEchartsThemeObserverStarted = true;
	try { __kustoRefreshChartsForThemeChange(); } catch { /* ignore */ }

	let pending = false;
	const schedule = () => {
		if (pending) return;
		pending = true;
		setTimeout(() => {
			pending = false;
			try { __kustoRefreshChartsForThemeChange(); } catch { /* ignore */ }
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
	} catch { /* ignore */ }
}

function __kustoDisposeChartEcharts( boxId: any) {
	try {
		const st = __kustoGetChartState(boxId);
		if (st && st.__echarts && st.__echarts.instance) {
			try { st.__echarts.instance.dispose(); } catch { /* ignore */ }
		}
		if (st) {
			try {
				if (st.__resizeObserver && typeof st.__resizeObserver.disconnect === 'function') {
					st.__resizeObserver.disconnect();
				}
			} catch { /* ignore */ }
			try { delete st.__lastTimeAxis; } catch { /* ignore */ }
			try { delete st.__echarts; } catch { /* ignore */ }
			try { delete st.__resizeObserver; } catch { /* ignore */ }
		}
	} catch {
		// ignore
	}
}

function __kustoRenderChart( boxId: any) {
	const id = String(boxId || '');
	if (!id) return;
	try { __kustoStartEchartsThemeObserver(); } catch { /* ignore */ }
	const st = __kustoGetChartState(id);
	
	// Track previous rendering state to detect transitions
	const wasRendering = st.__wasRendering || false;

	// Defensive: ensure dataSourceId is synced from the DOM dropdown in case state became stale.
	try {
		const dsEl = document.getElementById(id + '_chart_ds') as any;
		if (dsEl && dsEl.value) {
			st.dataSourceId = String(dsEl.value || '');
		}
	} catch { /* ignore */ }

	try {
		const wrapper = document.getElementById(id + '_chart_wrapper') as any;
		if (wrapper && wrapper.style && String(wrapper.style.display || '').toLowerCase() === 'none') {
			return;
		}
	} catch { /* ignore */ }
	const canvasId = __kustoGetChartActiveCanvasElementId(id);
	const canvas = document.getElementById(canvasId) as any;
	if (!canvas) return;

	// If ECharts isn't loaded yet, show a simple placeholder.
	if (!(window as any).echarts || typeof (window as any).echarts.init !== 'function') {
		try { canvas.textContent = 'Loading chart…'; } catch { /* ignore */ }
		return;
	}

	// Find dataset.
	let dsState = null;
	try {
		if (typeof _win.__kustoGetResultsState === 'function' && typeof st.dataSourceId === 'string' && st.dataSourceId) {
			dsState = _win.__kustoGetResultsState(st.dataSourceId);
		}
	} catch { /* ignore */ }
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
		} catch { /* ignore sorting errors */ }
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
		} catch { /* ignore */ }
		try {
			canvas.innerHTML = '<div class="error-message" style="white-space:pre-wrap">' + ((typeof _win.escapeHtml === 'function') ? _win.escapeHtml(String(msg || '')) : String(msg || '')) + '</div>';
		} catch { /* ignore */ }
		// Reduce canvas min-height when showing placeholder text to avoid overflow.
		try { canvas.style.minHeight = '60px'; } catch { /* ignore */ }
		// Track that we're now showing a message, not a chart
		const isNowRendering = false;
		st.__wasRendering = isNowRendering;
		// Auto-fit section when transitioning from rendering to not-rendering
		if (wasRendering !== isNowRendering) {
			try { __kustoMaximizeChartBox(id); } catch { /* ignore */ }
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
	try { canvas.style.minHeight = '140px'; } catch { /* ignore */ }
	try {
		const isDark = __kustoGetIsDarkThemeForEcharts();
		const themeName = isDark ? 'dark' : undefined;
		const prev = st.__echarts && st.__echarts.instance ? st.__echarts : null;
		if (!prev || prev.canvasId !== canvasId || prev.isDark !== isDark) {
			try { if (prev && prev.instance) prev.instance.dispose(); } catch { /* ignore */ }
			st.__echarts = { instance: (window as any).echarts.init(canvas, themeName), canvasId, isDark };
			// Canvas changed (Edit <-> Preview). Rebind resize observer.
			try {
				if (st.__resizeObserver && typeof st.__resizeObserver.disconnect === 'function') {
					st.__resizeObserver.disconnect();
				}
			} catch { /* ignore */ }
			try { delete st.__resizeObserver; } catch { /* ignore */ }
		}
	} catch { /* ignore */ }

	const inst = st.__echarts && st.__echarts.instance ? st.__echarts.instance : null;
	if (!inst) return;

	let canvasWidthPx = 0;
	try {
		const r = canvas.getBoundingClientRect();
		canvasWidthPx = r && typeof r.width === 'number' ? r.width : 0;
	} catch { /* ignore */ }
	if (!canvasWidthPx) {
		try { canvasWidthPx = canvas && typeof canvas.clientWidth === 'number' ? canvas.clientWidth : 0; } catch { /* ignore */ }
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
				if (typeof _win.escapeHtml === 'function') return _win.escapeHtml(String(v ?? ''));
			} catch { /* ignore */ }
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
			} catch { /* ignore */ }
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
						if (av == null && bv == null) return 0;
						if (av == null) return 1;
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
					} catch { /* ignore */ }
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
					try { delete st.__lastTimeAxis; } catch { /* ignore */ }
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
						} catch { /* ignore */ }
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
					} catch { /* ignore sorting errors */ }
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
								} catch { /* ignore */ }
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
						try { delete st.__lastCategoryAxis; } catch { /* ignore */ }
				} else {
					try { delete st.__lastTimeAxis; } catch { /* ignore */ }
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
						try { inst.resize(); } catch { /* ignore */ }
					});
					try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
				}
			} catch { /* ignore */ }
		}
		st.__wasRendering = isNowRendering;
	} catch { /* ignore */ }
	try {
		requestAnimationFrame(() => {
			try { inst.resize(); } catch { /* ignore */ }
		});
	} catch { /* ignore */ }

	// Keep the chart responsive to wrapper/canvas resizes.
	try {
		if (!st.__resizeObserver && typeof ResizeObserver !== 'undefined') {
			st.__resizeObserver = new ResizeObserver(() => {
				try { inst.resize(); } catch { /* ignore */ }
				try {
					const w = canvas && typeof canvas.clientWidth === 'number' ? canvas.clientWidth : 0;
					if (st.__lastTimeAxis) {
						const rotate = __kustoComputeTimeAxisLabelRotation(w, st.__lastTimeAxis.labelCount, st.__lastTimeAxis.showTime);
						if (rotate !== st.__lastTimeAxis.rotate) {
							st.__lastTimeAxis.rotate = rotate;
							try {
								inst.setOption({ xAxis: { axisLabel: { rotate } } });
							} catch { /* ignore */ }
						}
					} else if (st.__lastCategoryAxis) {
						const ca = st.__lastCategoryAxis;
						const rotate = __kustoComputeCategoryLabelRotation(w, ca.labelCount, ca.avgLabelChars, ca.maxLabelChars);
						if (rotate !== ca.rotate) {
							ca.rotate = rotate;
							try {
								inst.setOption({ xAxis: { axisLabel: { rotate } } });
							} catch { /* ignore */ }
						}
					}
				} catch { /* ignore */ }
			});
			try { st.__resizeObserver.observe(canvas); } catch { /* ignore */ }
			try {
				const wrapper = document.getElementById(id + '_chart_wrapper') as any;
				if (wrapper) st.__resizeObserver.observe(wrapper);
			} catch { /* ignore */ }
		}
	} catch { /* ignore */ }
}

function __kustoUpdateChartModeButtons( boxId: any) {
	try {
		const st = chartStateByBoxId && chartStateByBoxId[boxId] ? chartStateByBoxId[boxId] : null;
		const mode = st && st.mode ? String(st.mode) : 'edit';
		const editBtn = document.getElementById(boxId + '_chart_mode_edit') as any;
		const prevBtn = document.getElementById(boxId + '_chart_mode_preview') as any;
		if (editBtn) {
			editBtn.classList.toggle('is-active', mode === 'edit');
			editBtn.setAttribute('aria-selected', mode === 'edit' ? 'true' : 'false');
		}
		if (prevBtn) {
			prevBtn.classList.toggle('is-active', mode === 'preview');
			prevBtn.setAttribute('aria-selected', mode === 'preview' ? 'true' : 'false');
		}
		// Update dropdown text
		const dropdownText = document.getElementById(boxId + '_chart_mode_dropdown_text') as any;
		if (dropdownText) {
			dropdownText.textContent = mode === 'preview' ? 'Preview' : 'Edit';
		}
	} catch {
		// ignore
	}
}

function __kustoApplyChartMode( boxId: any) {
	try {
		const st = chartStateByBoxId && chartStateByBoxId[boxId] ? chartStateByBoxId[boxId] : null;
		const mode = st && st.mode ? String(st.mode) : 'edit';
		const editHost = document.getElementById(boxId + '_chart_edit') as any;
		const prevHost = document.getElementById(boxId + '_chart_preview') as any;
		if (editHost) editHost.style.display = (mode === 'edit') ? '' : 'none';
		if (prevHost) prevHost.style.display = (mode === 'preview') ? '' : 'none';
		__kustoUpdateChartModeButtons(boxId);
		try { __kustoRenderChart(boxId); } catch { /* ignore */ }
	} catch {
		// ignore
	}
}

function __kustoSetChartMode( boxId: any, mode: any) {
	const id = String(boxId || '');
	const m = String(mode || '').toLowerCase();
	if (!id) return;
	if (m !== 'edit' && m !== 'preview') return;
	const st = __kustoGetChartState(id);
	st.mode = m;
	try { __kustoApplyChartMode(id); } catch { /* ignore */ }
	try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
}

function __kustoUpdateChartVisibilityToggleButton( boxId: any) {
	try {
		const btn = document.getElementById(boxId + '_chart_toggle') as any;
		const st = chartStateByBoxId && chartStateByBoxId[boxId] ? chartStateByBoxId[boxId] : null;
		if (!btn) return;
		const expanded = !!(st ? st.expanded : true);
		btn.classList.toggle('is-active', expanded);
		btn.setAttribute('aria-selected', expanded ? 'true' : 'false');
		btn.title = expanded ? 'Hide' : 'Show';
		btn.setAttribute('aria-label', expanded ? 'Hide' : 'Show');
	} catch {
		// ignore
	}
}

function __kustoApplyChartBoxVisibility( boxId: any) {
	try {
		const st = chartStateByBoxId && chartStateByBoxId[boxId] ? chartStateByBoxId[boxId] : null;
		const expanded = !!(st ? st.expanded : true);
		const box = document.getElementById(boxId) as any;
		if (box) {
			box.classList.toggle('is-collapsed', !expanded);
		}
		const wrapper = document.getElementById(boxId + '_chart_wrapper') as any;
		if (wrapper) {
			wrapper.style.display = expanded ? '' : 'none';
		}
		// Hide/show Edit and Preview buttons, the divider, and max button when minimized
		const editBtn = document.getElementById(boxId + '_chart_mode_edit') as any;
		const previewBtn = document.getElementById(boxId + '_chart_mode_preview') as any;
		const divider = document.getElementById(boxId + '_chart_mode_divider') as any;
		const maxBtn = document.getElementById(boxId + '_chart_max') as any;
		if (editBtn) editBtn.style.display = expanded ? '' : 'none';
		if (previewBtn) previewBtn.style.display = expanded ? '' : 'none';
		if (divider) divider.style.display = expanded ? '' : 'none';
		if (maxBtn) maxBtn.style.display = expanded ? '' : 'none';
		__kustoUpdateChartVisibilityToggleButton(boxId);
		if (expanded) {
			try { __kustoRenderChart(boxId); } catch { /* ignore */ }
		}
	} catch {
		// ignore
	}
}

function toggleChartBoxVisibility( boxId: any) {
	const id = String(boxId || '');
	if (!id) return;
	const st = __kustoGetChartState(id);
	st.expanded = !st.expanded;
	try { __kustoApplyChartBoxVisibility(id); } catch { /* ignore */ }
	try { __kustoRenderChart(id); } catch { /* ignore */ }
	try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
}

function __kustoMaximizeChartBox( boxId: any) {
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
		try { delete wrapper.dataset.kustoUserResized; } catch { /* ignore */ }
		
		// NOTE: Do NOT call __kustoRenderChart here - it would create an infinite loop
		// because __kustoRenderChart calls __kustoMaximizeChartBox on state transitions.
		// The chart will be rendered by the caller that triggered the state transition.
		// Instead, just resize the existing ECharts instance if one exists.
		try {
			if (st && st.__echarts && st.__echarts.instance) {
				requestAnimationFrame(() => {
					try { st.__echarts.instance.resize(); } catch { /* ignore */ }
				});
			}
		} catch { /* ignore */ }
		try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
	} catch {
		// ignore
	}
}

// Check if the chart canvas is partially clipped and auto-fit if needed.
// Does NOT auto-fit if the user has explicitly resized the chart box.
function __kustoAutoFitChartIfClipped( boxId: any) {
	try {
		const wrapper = document.getElementById(boxId + '_chart_wrapper') as any;
		if (!wrapper) return;
		
		// Respect user's explicit resize; do not auto-fit in that case.
		if (wrapper.dataset && wrapper.dataset.kustoUserResized === 'true') return;
		
		const st = __kustoGetChartState(boxId);
		const isPreview = st.mode === 'preview';
		
		// Get the active canvas
		const canvasId = isPreview ? (boxId + '_chart_canvas_preview') : (boxId + '_chart_canvas_edit');
		const canvas = document.getElementById(canvasId) as any;
		if (!canvas) return;
		
		// Get minimum height from inline style (default 140px)
		let minHeight = 140;
		try {
			const inlineMinHeight = canvas.style.minHeight;
			if (inlineMinHeight) {
				const parsed = parseInt(inlineMinHeight, 10);
				if (parsed > 0) minHeight = parsed;
			}
		} catch { /* ignore */ }
		
		// Check if the canvas is being clipped
		const wrapperRect = wrapper.getBoundingClientRect();
		const canvasRect = canvas.getBoundingClientRect();
		
		// If canvas bottom extends past wrapper bottom, or canvas height is less than minHeight, auto-fit
		const isClipped = (canvasRect.bottom > wrapperRect.bottom + 2) || (canvasRect.height < minHeight - 2);
		
		if (isClipped) {
			// Defer to avoid layout thrashing during control updates
			requestAnimationFrame(() => {
				try { __kustoMaximizeChartBox(boxId); } catch { /* ignore */ }
			});
		}
	} catch {
		// ignore
	}
}

function addChartBox( options: any) {
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
	resizerEl.title = 'Drag to resize';
	chartWrapper.appendChild(resizerEl);

	litEl.appendChild(chartWrapper);

	// Apply options to the Lit element
	if (typeof litEl.applyOptions === 'function') {
		litEl.applyOptions(options || {});
	}

	// Listen for section-remove event
	litEl.addEventListener('section-remove', (e: any) => {
		try {
			const detail = e && e.detail ? e.detail : {};
			const removeId = detail.boxId || id;
			removeChartBox(removeId);
		} catch { /* ignore */ }
	});

	container.insertAdjacentElement('beforeend', litEl);

	// Set up drag-resize on the light-DOM resizer
	try {
		if (chartWrapper && resizerEl) {
			resizerEl.addEventListener('mousedown', (e: any) => {
				try { e.preventDefault(); e.stopPropagation(); } catch { /* ignore */ }
				try { chartWrapper.dataset.kustoUserResized = 'true'; } catch { /* ignore */ }
				resizerEl.classList.add('is-dragging');
				const prevCursor = document.body.style.cursor;
				const prevUserSelect = document.body.style.userSelect;
				document.body.style.cursor = 'ns-resize';
				document.body.style.userSelect = 'none';
				const startPageY = e.clientY + (typeof _win.__kustoGetScrollY === 'function' ? _win.__kustoGetScrollY() : 0);
				const startHeight = chartWrapper.getBoundingClientRect().height;
				try { chartWrapper.style.height = Math.max(0, Math.ceil(startHeight)) + 'px'; } catch { /* ignore */ }
				const minH = typeof __kustoGetChartMinResizeHeight === 'function' ? __kustoGetChartMinResizeHeight(id) : 80;
				const maxH = 900;
				const onMove = (moveEvent: any) => {
					try {
						if (typeof _win.__kustoMaybeAutoScrollWhileDragging === 'function') {
							_win.__kustoMaybeAutoScrollWhileDragging(moveEvent.clientY);
						}
					} catch { /* ignore */ }
					const pageY = moveEvent.clientY + (typeof _win.__kustoGetScrollY === 'function' ? _win.__kustoGetScrollY() : 0);
					const delta = pageY - startPageY;
					const currentMinH = typeof __kustoGetChartMinResizeHeight === 'function' ? __kustoGetChartMinResizeHeight(id) : 80;
					const nextHeight = Math.max(currentMinH, Math.min(maxH, startHeight + delta));
					chartWrapper.style.height = nextHeight + 'px';
					try { __kustoRenderChart(id); } catch { /* ignore */ }
				};
				const onUp = () => {
					document.removeEventListener('mousemove', onMove, true);
					document.removeEventListener('mouseup', onUp, true);
					resizerEl.classList.remove('is-dragging');
					document.body.style.cursor = prevCursor;
					document.body.style.userSelect = prevUserSelect;
					try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
					try { __kustoRenderChart(id); } catch { /* ignore */ }
				};
				document.addEventListener('mousemove', onMove, true);
				document.addEventListener('mouseup', onUp, true);
			});
		}
	} catch { /* ignore */ }

	try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
	try {
		const controls = document.querySelector('.add-controls');
		if (controls && typeof controls.scrollIntoView === 'function') {
			controls.scrollIntoView({ block: 'end' });
		}
	} catch { /* ignore */ }
	return id;
}

function __kustoOnChartDataSourceChanged( boxId: any) {
	const id = String(boxId || '');
	if (!id) return;
	const st = __kustoGetChartState(id);
	try {
		const el = document.getElementById(id + '_chart_ds') as any;
		st.dataSourceId = el ? String(el.value || '') : '';
	} catch { /* ignore */ }
	try { __kustoUpdateChartBuilderUI(id); } catch { /* ignore */ }
	try { __kustoRenderChart(id); } catch { /* ignore */ }
	try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
}

function __kustoOnChartTypeChanged( boxId: any) {
	const id = String(boxId || '');
	if (!id) return;
	const st = __kustoGetChartState(id);
	try {
		const el = document.getElementById(id + '_chart_type') as any;
		st.chartType = el ? String(el.value || '') : '';
	} catch { /* ignore */ }
	try { __kustoUpdateChartBuilderUI(id); } catch { /* ignore */ }
	try { __kustoRenderChart(id); } catch { /* ignore */ }
	try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
}

function __kustoSelectChartType( boxId: any, chartType: any) {
	const id = String(boxId || '');
	const type = String(chartType || '');
	if (!id) return;
	const st = __kustoGetChartState(id);
	st.chartType = type;
	try { __kustoUpdateChartBuilderUI(id); } catch { /* ignore */ }
	try { __kustoRenderChart(id); } catch { /* ignore */ }
	try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
}

function __kustoOnChartLabelsToggled( boxId: any) {
	const id = String(boxId || '');
	if (!id) return;
	const st = __kustoGetChartState(id);
	// Toggle the showDataLabels state
	st.showDataLabels = !st.showDataLabels;
	// Update both toggle switches (XY and Pie) to reflect new state
	try {
		const labelsToggle = document.getElementById(id + '_chart_labels_toggle') as any;
		if (labelsToggle) {
			labelsToggle.classList.toggle('is-active', st.showDataLabels);
			labelsToggle.setAttribute('aria-checked', st.showDataLabels ? 'true' : 'false');
		}
		const labelsTogglePie = document.getElementById(id + '_chart_labels_pie_toggle') as any;
		if (labelsTogglePie) {
			labelsTogglePie.classList.toggle('is-active', st.showDataLabels);
			labelsTogglePie.setAttribute('aria-checked', st.showDataLabels ? 'true' : 'false');
		}
	} catch { /* ignore */ }
	try { __kustoRenderChart(id); } catch { /* ignore */ }
	try { __kustoUpdateLabelSettingsIndicator(id); } catch { /* ignore */ }
	try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
}

/** Handler for when the pie/funnel label mode dropdown changes */
function __kustoOnChartLabelModeChanged( boxId: any) {
	const id = String(boxId || '');
	if (!id) return;
	const st = __kustoGetChartState(id);
	const el = document.getElementById(id + '_chart_label_mode') as any;
	if (el) {
		st.labelMode = String(el.value || 'auto');
	}
	// Update the button text display
	try {
		const textEl = document.getElementById(id + '_chart_label_mode_text') as any;
		if (textEl && el) {
			const opt = el.options[el.selectedIndex];
			textEl.textContent = opt ? opt.text : 'Auto (smart)';
		}
	} catch { /* ignore */ }
	// Show/hide density slider based on mode
	try {
		const densityRow = document.getElementById(id + '_chart_label_density_row') as any;
		if (densityRow) {
			densityRow.style.display = (st.labelMode === 'auto') ? '' : 'none';
		}
	} catch { /* ignore */ }
	try { __kustoRenderChart(id); } catch { /* ignore */ }
	try { __kustoUpdateLabelSettingsIndicator(id); } catch { /* ignore */ }
	try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
}

/** Handler for when the pie/funnel label density slider changes */
function __kustoOnChartLabelDensityChanged( boxId: any, value: any) {
	const id = String(boxId || '');
	if (!id) return;
	const st = __kustoGetChartState(id);
	const densityValue = Math.max(0, Math.min(100, typeof value === 'number' ? value : 50));
	st.labelDensity = densityValue;
	// Update the display value
	try {
		const valueEl = document.getElementById(id + '_chart_label_density_value') as any;
		if (valueEl) {
			valueEl.textContent = densityValue + '%';
		}
	} catch { /* ignore */ }
	try { __kustoRenderChart(id); } catch { /* ignore */ }
	try { __kustoUpdateLabelSettingsIndicator(id); } catch { /* ignore */ }
	try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
}

function __kustoOnChartMappingChanged( boxId: any) {
	const id = String(boxId || '');
	if (!id) return;
	const st = __kustoGetChartState(id);
	const oldX = st.xColumn;
	try { st.xColumn = String(((document.getElementById(id + '_chart_x') as any || {}).value || '')); } catch { /* ignore */ }
	// Y columns are now handled by checkbox dropdown via __kustoOnChartYCheckboxChanged.
	try { st.legendColumn = String(((document.getElementById(id + '_chart_legend') as any || {}).value || '')); } catch { /* ignore */ }
	try { st.labelColumn = String(((document.getElementById(id + '_chart_label') as any || {}).value || '')); } catch { /* ignore */ }
	try { st.valueColumn = String(((document.getElementById(id + '_chart_value') as any || {}).value || '')); } catch { /* ignore */ }
	// Update legend position button visibility based on whether a legend column is selected.
	try { __kustoUpdateLegendPositionButtonUI(id); } catch { /* ignore */ }
	// If X column changed, rebuild Y column options (excluding the new X) to keep UI in sync.
	if (oldX !== st.xColumn) {
		try { __kustoUpdateChartBuilderUI(id); } catch { /* ignore */ }
	}
	try { __kustoRenderChart(id); } catch { /* ignore */ }
	try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
}

// Handler for Y column checkbox dropdown changes.
function __kustoOnChartYCheckboxChanged( dropdownId: any) {
	// dropdownId is like "boxId_chart_y"
	const parts = String(dropdownId || '').split('_chart_y');
	const boxId = parts[0] || '';
	if (!boxId) return;
	const st = __kustoGetChartState(boxId);
	const menuId = boxId + '_chart_y_menu';
	try {
		const selected = (window as any).__kustoDropdown.getCheckboxSelections(menuId);
		st.yColumns = selected;
		st.yColumn = selected.length ? selected[0] : '';
		// If multiple Y columns are selected, Legend grouping is not supported.
		try {
			const legendSelect = document.getElementById(boxId + '_chart_legend') as any;
			const legendBtn = document.getElementById(boxId + '_chart_legend_btn') as any;
			const disableLegend = (selected.length > 1);
			if (disableLegend) {
				st.legendColumn = '';
				if (legendSelect) {
					legendSelect.value = '';
				}
			}
			if (legendSelect) {
				legendSelect.disabled = disableLegend;
			}
			// Sync the button's disabled state and text.
			if (legendBtn) {
				legendBtn.disabled = disableLegend;
				legendBtn.setAttribute('aria-disabled', disableLegend ? 'true' : 'false');
			}
			try { (window as any).__kustoDropdown.syncSelectBackedDropdown(boxId + '_chart_legend'); } catch { /* ignore */ }
			// Update legend position button visibility when legend column is cleared.
			try { __kustoUpdateLegendPositionButtonUI(boxId); } catch { /* ignore */ }
		} catch { /* ignore */ }
		// Update button text.
		(window as any).__kustoDropdown.updateCheckboxButtonText(boxId + '_chart_y_text', selected, 'Select...');
	} catch { /* ignore */ }
	// Update series colors UI in Y-axis settings popup (in case it's open)
	try {
		const st2 = __kustoGetChartState(boxId);
		__kustoUpdateSeriesColorsUI(boxId, st2.yAxisSettings || {});
	} catch { /* ignore */ }
	try { __kustoRenderChart(boxId); } catch { /* ignore */ }
	try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
}

// Handler for Tooltip column checkbox dropdown changes.
function __kustoOnChartTooltipCheckboxChanged( dropdownId: any) {
	// dropdownId is like "boxId_chart_tooltip" or "boxId_chart_tooltip_pie"
	const raw = String(dropdownId || '');
	let boxId = '';
	let menuId = '';
	let textId = '';
	try {
		if (raw.includes('_chart_tooltip_pie')) {
			boxId = raw.split('_chart_tooltip_pie')[0] || '';
			menuId = boxId + '_chart_tooltip_pie_menu';
			textId = boxId + '_chart_tooltip_pie_text';
		} else {
			boxId = raw.split('_chart_tooltip')[0] || '';
			menuId = boxId + '_chart_tooltip_menu';
			textId = boxId + '_chart_tooltip_text';
		}
	} catch { /* ignore */ }
	if (!boxId) return;
	const st = __kustoGetChartState(boxId);
	try {
		const selected = (window as any).__kustoDropdown.getCheckboxSelections(menuId);
		st.tooltipColumns = selected;
		(window as any).__kustoDropdown.updateCheckboxButtonText(textId, selected, '(none)');
	} catch { /* ignore */ }
	try { __kustoRenderChart(boxId); } catch { /* ignore */ }
	try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
}

// Handler for funnel sort column dropdown changes.
function __kustoOnChartFunnelSortChanged( boxId: any) {
	const id = String(boxId || '');
	if (!id) return;
	const st = __kustoGetChartState(id);
	try {
		const selectEl = document.getElementById(id + '_chart_funnel_sort') as any;
		const newValue = selectEl ? String(selectEl.value || '') : '';
		st.sortColumn = newValue;
		// If sort column is cleared, also clear direction.
		if (!newValue) {
			st.sortDirection = '';
		} else if (!st.sortDirection) {
			// Default to descending when a column is first selected.
			st.sortDirection = 'desc';
		}
		// Update the UI to show/hide direction button and update its state.
		__kustoUpdateFunnelSortUI(id);
	} catch { /* ignore */ }
	try { __kustoRenderChart(id); } catch { /* ignore */ }
	try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
}

// Handler for funnel sort direction toggle button.
function __kustoOnChartFunnelSortDirToggle( boxId: any) {
	const id = String(boxId || '');
	if (!id) return;
	const st = __kustoGetChartState(id);
	// Only toggle if a sort column is selected.
	if (!st.sortColumn) return;
	try {
		// Toggle between 'asc' and 'desc'.
		st.sortDirection = (st.sortDirection === 'asc') ? 'desc' : 'asc';
		__kustoUpdateFunnelSortUI(id);
	} catch { /* ignore */ }
	try { __kustoRenderChart(id); } catch { /* ignore */ }
	try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
}

// Update the funnel sort UI (direction button visibility and icon state).
function __kustoUpdateFunnelSortUI( boxId: any) {
	const id = String(boxId || '');
	if (!id) return;
	const st = __kustoGetChartState(id);
	const hasSortColumn = !!(st.sortColumn);
	const sortDir = st.sortDirection || 'desc';
	
	// Update the wrapper class to show/hide direction button.
	const wrapper = document.getElementById(id + '_chart_funnel_sort_wrapper') as any;
	if (wrapper) {
		wrapper.classList.toggle('has-sort-column', hasSortColumn);
	}
	
	// Update the group to add class for layout.
	const group = document.getElementById(id + '_chart_funnel_sort_group') as any;
	if (group) {
		group.classList.toggle('has-sort-column', hasSortColumn);
	}
	
	// Update direction button state.
	const dirBtn = document.getElementById(id + '_chart_funnel_sort_dir_btn') as any;
	if (dirBtn) {
		dirBtn.style.display = hasSortColumn ? '' : 'none';
		dirBtn.classList.toggle('is-asc', sortDir === 'asc');
		dirBtn.classList.toggle('is-desc', sortDir === 'desc');
		dirBtn.title = sortDir === 'asc' ? 'Ascending (click to change)' : 'Descending (click to change)';
		dirBtn.setAttribute('aria-label', sortDir === 'asc' ? 'Sort ascending, click to change to descending' : 'Sort descending, click to change to ascending');
	}
}

function removeChartBox( boxId: any) {
	try { __kustoDisposeChartEcharts(boxId); } catch { /* ignore */ }
	try { delete chartStateByBoxId[boxId]; } catch { /* ignore */ }
	try { __kustoCleanupSectionModeResizeObserver(boxId); } catch { /* ignore */ }
	chartBoxes = (chartBoxes || []).filter((id: any) => id !== boxId);
	const box = document.getElementById(boxId) as any;
	if (box && box.parentNode) {
		box.parentNode.removeChild(box);
	}
	try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
}

// Pending reveal requests from the extension host (e.g., Search result click).
// Keyed by markdown boxId.
let __kustoPendingMarkdownRevealByBoxId: any = {};

function __kustoTryApplyPendingMarkdownReveal( boxId: any) {
	try {
		const pending = __kustoPendingMarkdownRevealByBoxId && __kustoPendingMarkdownRevealByBoxId[boxId];
		if (!pending) {
			return;
		}
		try { delete __kustoPendingMarkdownRevealByBoxId[boxId]; } catch { /* ignore */ }
		try {
			if (typeof (window as any).__kustoRevealMarkdownRangeInBox === 'function') {
				(window as any).__kustoRevealMarkdownRangeInBox(boxId, pending);
			}
		} catch { /* ignore */ }
	} catch {
		// ignore
	}
}

// Called by main.js when the extension host asks us to reveal a range.
// For .md compatibility mode, there is exactly one markdown section; reveal in that first box.
try {
	if (typeof (window as any).__kustoRevealTextRangeFromHost !== 'function') {
		(window as any).__kustoRevealTextRangeFromHost = (message: any) => {
			try {
				const kind = String((window as any).__kustoDocumentKind || '');
				if (kind !== 'md') {
					return;
				}
				const start = message && message.start ? message.start : null;
				const end = message && message.end ? message.end : null;
				const sl = start && typeof start.line === 'number' ? start.line : 0;
				const sc = start && typeof start.character === 'number' ? start.character : 0;
				const el = end && typeof end.line === 'number' ? end.line : sl;
				const ec = end && typeof end.character === 'number' ? end.character : sc;
				const matchText = message && typeof message.matchText === 'string' ? String(message.matchText) : '';
				const startOffset = message && typeof message.startOffset === 'number' ? message.startOffset : undefined;
				const endOffset = message && typeof message.endOffset === 'number' ? message.endOffset : undefined;

				const boxId = (markdownBoxes && markdownBoxes.length) ? String(markdownBoxes[0] || '') : '';
				if (!boxId) {
					return;
				}
				const payload = { startLine: sl, startChar: sc, endLine: el, endChar: ec, matchText, startOffset, endOffset };
				const api = markdownEditors && markdownEditors[boxId] ? markdownEditors[boxId] : null;
				if (!api || !api._toastui) {
					try {
						if (typeof _win.vscode !== 'undefined' && _win.vscode && typeof (_win.vscode as any).postMessage === 'function') {
							(_win.vscode as any).postMessage({
								type: 'debugMdSearchReveal',
								phase: 'markdownReveal(queued)',
								detail: `${String((window as any).__kustoDocumentUri || '')} boxId=${boxId} ${sl}:${sc}-${el}:${ec} matchLen=${matchText ? matchText.length : 0}`
							});
						}
					} catch { /* ignore */ }
					__kustoPendingMarkdownRevealByBoxId[boxId] = payload;
					return;
				}
				try {
					if (typeof _win.vscode !== 'undefined' && _win.vscode && typeof (_win.vscode as any).postMessage === 'function') {
						(_win.vscode as any).postMessage({
							type: 'debugMdSearchReveal',
							phase: 'markdownReveal(apply)',
							detail: `${String((window as any).__kustoDocumentUri || '')} boxId=${boxId} ${sl}:${sc}-${el}:${ec} matchLen=${matchText ? matchText.length : 0}`
						});
					}
				} catch { /* ignore */ }
				if (typeof (window as any).__kustoRevealMarkdownRangeInBox === 'function') {
					(window as any).__kustoRevealMarkdownRangeInBox(boxId, payload);
				}
			} catch {
				// ignore
			}
		};
	}
} catch {
	// ignore
}

// Reveal a markdown range inside a specific markdown box, by switching to markdown mode
// (so line/character mapping is stable) and then using ToastUI's selection API.
try {
	if (typeof (window as any).__kustoRevealMarkdownRangeInBox !== 'function') {
		(window as any).__kustoRevealMarkdownRangeInBox = (boxId: any, payload: any) => {
			const id = String(boxId || '');
			if (!id) return;
			const sl = payload && typeof payload.startLine === 'number' ? payload.startLine : 0;
			const sc = payload && typeof payload.startChar === 'number' ? payload.startChar : 0;
			const el = payload && typeof payload.endLine === 'number' ? payload.endLine : sl;
			const ec = payload && typeof payload.endChar === 'number' ? payload.endChar : sc;
			const matchText = payload && typeof payload.matchText === 'string' ? String(payload.matchText) : '';
			const startOffset = payload && typeof payload.startOffset === 'number' ? payload.startOffset : undefined;
			const endOffset = payload && typeof payload.endOffset === 'number' ? payload.endOffset : undefined;
			const desiredUiMode = (typeof (window as any).__kustoGetMarkdownMode === 'function')
				? String((window as any).__kustoGetMarkdownMode(id) || 'wysiwyg')
				: 'wysiwyg';

			try {
				const boxEl = document.getElementById(id) as any;
				if (boxEl && typeof boxEl.scrollIntoView === 'function') {
					boxEl.scrollIntoView({ block: 'center' });
				}
			} catch { /* ignore */ }

			const api = markdownEditors && markdownEditors[id] ? markdownEditors[id] : null;
			const toast = api && api._toastui ? api._toastui : null;
			if (!toast || typeof toast.setSelection !== 'function' || typeof toast.changeMode !== 'function') {
				__kustoPendingMarkdownRevealByBoxId[id] = { startLine: sl, startChar: sc, endLine: el, endChar: ec, matchText, startOffset, endOffset };
				return;
			}

			// IMPORTANT:
			// - In markdown mode, ToastUI selection takes [line, char].
			// - In WYSIWYG mode, ToastUI selection takes ProseMirror positions (numbers).
			// ToastUI provides convertPosToMatchEditorMode() which can convert a markdown position
			// into the corresponding WYSIWYG ProseMirror position.
			// Prefer a stable, mode-agnostic strategy:
			// - Find the match text in the editor's markdown content.
			// - Use the host-provided offsets to pick the correct occurrence.
			// - Convert to the appropriate selection coordinates for the current mode.
			const mdText = (() => {
				try {
					if (typeof toast.getMarkdown === 'function') {
						return String(toast.getMarkdown() || '');
					}
				} catch { /* ignore */ }
				try {
					if (typeof api.getValue === 'function') {
						return String(api.getValue() || '');
					}
				} catch { /* ignore */ }
				return '';
			})();

			const findText = (matchText && matchText.trim()) ? matchText : '';
			const computeLineChar1Based = (text: any, offset0: any) => {
				try {
					const t = String(text || '');
					const off = Math.max(0, Math.min(t.length, Math.floor(offset0)));
					const before = t.slice(0, off);
					const line = before.split('\n').length; // 1-based
					const lastNl = before.lastIndexOf('\n');
					const ch = off - (lastNl >= 0 ? (lastNl + 1) : 0) + 1; // 1-based
					return [Math.max(1, line), Math.max(1, ch)];
				} catch {
					return [1, 1];
				}
			};

			const computeOccurrenceIndex = (text: any, needle: any, atIndex: any) => {
				try {
					if (!needle) return 0;
					let occ = 0;
					let i = 0;
					while (true) {
						const next = text.indexOf(needle, i);
						if (next < 0 || next >= atIndex) break;
						occ++;
						i = next + Math.max(1, needle.length);
					}
					return occ;
				} catch {
					return 0;
				}
			};

			let foundStart = 0;
			let foundEnd = 0;
			let occurrence = 0;
			if (findText) {
				const preferred = (typeof startOffset === 'number' && Number.isFinite(startOffset)) ? Math.max(0, Math.floor(startOffset)) : undefined;
				let idx = -1;
				try {
					if (typeof preferred === 'number' && mdText.startsWith(findText, preferred)) {
						idx = preferred;
					} else if (typeof preferred === 'number') {
						const forward = mdText.indexOf(findText, preferred);
						const back = mdText.lastIndexOf(findText, preferred);
						if (forward < 0) {
							idx = back;
						} else if (back < 0) {
							idx = forward;
						} else {
							idx = (Math.abs(forward - preferred) <= Math.abs(preferred - back)) ? forward : back;
						}
					} else {
						idx = mdText.indexOf(findText);
					}
				} catch {
					idx = -1;
				}
			}

			// Hoist mdStart/mdEnd so both applySelectionNow and applySelectionInDesiredMode can see them.
			const mdStart: any = (findText && foundEnd > foundStart)
				? computeLineChar1Based(mdText, foundStart)
				: (payload.__kustoMdStartFallback || [Math.max(1, sl + 1), Math.max(1, sc + 1)]);
			const mdEnd: any = (findText && foundEnd > foundStart)
				? computeLineChar1Based(mdText, foundEnd)
				: (payload.__kustoMdEndFallback || [Math.max(1, el + 1), Math.max(1, ec + 1)]);

			const applySelectionNow = () => {
				// If we're in preview mode, highlight + scroll using the rendered DOM.
				if (desiredUiMode === 'preview') {
					try {
						const viewerHost = document.getElementById(id + '_md_viewer') as any;
						if (!viewerHost) return;
						if (!findText) return;
						const selectInPreviewByOccurrence = () => {
							try {
								const root = viewerHost;
								const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
								let seen = 0;
								while (walker.nextNode()) {
									const n = walker.currentNode;
									const text = n && typeof n.nodeValue === 'string' ? n.nodeValue : '';
									if (!text) continue;
									let i = 0;
									while (true) {
										const at = text.indexOf(findText, i);
										if (at < 0) break;
										if (seen === occurrence) {
											const range = document.createRange();
											range.setStart(n, at);
											range.setEnd(n, at + findText.length);
											try {
												const sel = window.getSelection && window.getSelection();
												if (sel) {
													sel.removeAllRanges();
													sel.addRange(range);
												}
											} catch { /* ignore */ }
											try {
												const el2 = range.startContainer && range.startContainer.parentElement ? range.startContainer.parentElement : null;
												if (el2 && typeof el2.scrollIntoView === 'function') {
													el2.scrollIntoView({ block: 'center' });
												}
											} catch { /* ignore */ }
											return true;
										}
										seen++;
										i = at + Math.max(1, findText.length);
									}
								}
							} catch {
								// ignore
							}
							return false;
						};
						setTimeout(() => {
							const ok = selectInPreviewByOccurrence();
							if (!ok) {
								try { (window as any).find && (window as any).find(findText); } catch { /* ignore */ }
							}
						}, 0);
					} catch { /* ignore */ }
					return;
				}

				// Editor modes: keep the current mode; apply selection in a mode-appropriate way.
				// (mdStart/mdEnd hoisted to outer scope)

				try {
					if (desiredUiMode === 'wysiwyg') {
						let from = 0;
						let to = 0;
						try {
							if (typeof toast.convertPosToMatchEditorMode === 'function') {
								const converted = toast.convertPosToMatchEditorMode(mdStart, mdEnd, 'wysiwyg');
								if (converted && typeof converted[0] === 'number' && typeof converted[1] === 'number') {
									from = converted[0];
									to = converted[1];
								}
							}
						} catch { /* ignore */ }
						try { toast.setSelection(from, to); } catch { /* ignore */ }
					} else {
						try { toast.setSelection(mdStart, mdEnd); } catch { /* ignore */ }
					}
				} catch { /* ignore */ }
				try { if (typeof toast.focus === 'function') toast.focus(); } catch { /* ignore */ }
			};

			// Apply now, and retry a couple times in case the editor is still settling.
			try {
				applySelectionNow();
				setTimeout(applySelectionNow, 50);
				setTimeout(applySelectionNow, 150);
			} catch { /* ignore */ }
			const applySelectionInDesiredMode = () => {
				const mode = (desiredUiMode === 'markdown' || desiredUiMode === 'wysiwyg') ? desiredUiMode : 'wysiwyg';
				try { toast.changeMode(mode, true); } catch { /* ignore */ }
				try {
					setTimeout(() => {
						try {
							if (mode === 'wysiwyg') {
								let from = 0;
								let to = 0;
								try {
									if (typeof toast.convertPosToMatchEditorMode === 'function') {
										const converted = toast.convertPosToMatchEditorMode(mdStart, mdEnd, 'wysiwyg');
										if (converted && typeof converted[0] === 'number' && typeof converted[1] === 'number') {
											from = converted[0];
											to = converted[1];
										}
									}
								} catch { /* ignore */ }
								try { toast.setSelection(from, to); } catch { /* ignore */ }
							} else {
								try { toast.setSelection(mdStart, mdEnd); } catch { /* ignore */ }
							}
						} catch { /* ignore */ }
						try { if (typeof toast.focus === 'function') toast.focus(); } catch { /* ignore */ }
					}, 0);
				} catch { /* ignore */ }
			};

			try {
				// Ensure we are not in preview mode; preview hides the editor surface.
				if (desiredUiMode === 'preview' && typeof (window as any).__kustoSetMarkdownMode === 'function') {
					(window as any).__kustoSetMarkdownMode(id, 'wysiwyg');
				}
			} catch { /* ignore */ }
			applySelectionInDesiredMode();
		};
	}
} catch {
	// ignore
}

let toastUiThemeObserverStarted = false;
let lastAppliedToastUiIsDarkTheme: any = null;

let markdownMarkedResolvePromise: any = null;

function __kustoIsDarkTheme() {
	// Prefer the body classes VS Code toggles on theme change.
	try {
		const cls = document && document.body && document.body.classList;
		if (cls) {
			if (cls.contains('vscode-light') || cls.contains('vscode-high-contrast-light')) {
				return false;
			}
			if (cls.contains('vscode-dark') || cls.contains('vscode-high-contrast')) {
				return true;
			}
		}
	} catch {
		// ignore
	}

	// Fall back to luminance of the editor background.
	const parseCssColorToRgb = (value: any) => {
		const v = String(value || '').trim();
		if (!v) return null;
		let m = v.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
		if (m) {
			return { r: parseInt(m[1], 10), g: parseInt(m[2], 10), b: parseInt(m[3], 10) };
		}
		m = v.match(/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i);
		if (m) {
			const hex = m[1];
			if (hex.length === 3) {
				const r = parseInt(hex[0] + hex[0], 16);
				const g = parseInt(hex[1] + hex[1], 16);
				const b = parseInt(hex[2] + hex[2], 16);
				return { r, g, b };
			}
			const r = parseInt(hex.slice(0, 2), 16);
			const g = parseInt(hex.slice(2, 4), 16);
			const b = parseInt(hex.slice(4, 6), 16);
			return { r, g, b };
		}
		return null;
	};

	let bg = '';
	try {
		bg = getComputedStyle(document.body).getPropertyValue('--vscode-editor-background').trim();
		if (!bg) {
			bg = getComputedStyle(document.documentElement).getPropertyValue('--vscode-editor-background').trim();
		}
	} catch {
		bg = '';
	}
	const rgb = parseCssColorToRgb(bg);
	if (!rgb) {
		return true;
	}
	const luminance = (0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b) / 255;
	return luminance < 0.5;
}

function __kustoApplyToastUiThemeToHost( hostEl: any, isDark: any) {
	if (!hostEl || !hostEl.querySelectorAll) {
		return;
	}
	try {
		const roots = hostEl.querySelectorAll('.toastui-editor-defaultUI');
		for (const el of roots) {
			try {
				if (el && el.classList) {
					el.classList.toggle('toastui-editor-dark', !!isDark);
				}
			} catch { /* ignore */ }
		}
	} catch {
		// ignore
	}
}

function __kustoApplyToastUiThemeAll() {
	let isDark = true;
	try { isDark = __kustoIsDarkTheme(); } catch { isDark = true; }
	if (lastAppliedToastUiIsDarkTheme === isDark) {
		return;
	}
	lastAppliedToastUiIsDarkTheme = isDark;

	try {
		for (const boxId of markdownBoxes || []) {
			const editorHost = document.getElementById(String(boxId) + '_md_editor');
			const viewerHost = document.getElementById(String(boxId) + '_md_viewer');
			__kustoApplyToastUiThemeToHost(editorHost, isDark);
			__kustoApplyToastUiThemeToHost(viewerHost, isDark);
		}
	} catch {
		// ignore
	}
}

function __kustoStartToastUiThemeObserver() {
	if (toastUiThemeObserverStarted) {
		return;
	}
	toastUiThemeObserverStarted = true;

	// Apply once now.
	try { __kustoApplyToastUiThemeAll(); } catch { /* ignore */ }

	let pending = false;
	const schedule = () => {
		if (pending) return;
		pending = true;
		setTimeout(() => {
			pending = false;
			try { __kustoApplyToastUiThemeAll(); } catch { /* ignore */ }
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
	} catch {
		// ignore
	}
}

function __kustoMaximizeMarkdownBox( boxId: any) {
	const id = String(boxId || '').trim();
	if (!id) return;
	const editorHost = document.getElementById(id + '_md_editor') as any;
	const viewerHost = document.getElementById(id + '_md_viewer') as any;
	const wrapper = editorHost && editorHost.closest ? editorHost.closest('.query-editor-wrapper') : null;
	if (!wrapper) return;
	const FIT_SLACK_PX = 5;

	const tryComputeDesiredWrapperHeight = (mode: any) => {
		try {
			const container = editorHost;
			const ui = container && container.querySelector ? container.querySelector('.toastui-editor-defaultUI') : null;
			if (!ui) return undefined;
			const toolbar = ui.querySelector('.toastui-editor-defaultUI-toolbar');
			const toolbarH = toolbar && toolbar.getBoundingClientRect ? toolbar.getBoundingClientRect().height : 0;

			let contentH = 0;
			const m = String(mode || '').toLowerCase();
			if (m === 'wysiwyg') {
				// IMPORTANT: measure intrinsic content height, not a scroll container's scrollHeight.
				// scrollHeight is >= clientHeight, which prevents shrinking when the wrapper is oversized.
				const prose = ui.querySelector('.toastui-editor-ww-container .ProseMirror');
				if (prose) {
					try {
						// Preferred: compute from layout offsets so the result is NOT affected by the
						// current scroll position or viewport size.
						let minTop = Infinity;
						let maxBottom = 0;
						const kids = prose.children ? Array.from(prose.children) as any[] : [];
						for (const child of kids) {
							try {
								if (!child || child.nodeType !== 1) continue;
								const top = (typeof child.offsetTop === 'number') ? child.offsetTop : 0;
								const h = (typeof child.offsetHeight === 'number') ? child.offsetHeight : 0;
								let mt = 0;
								let mb = 0;
								try {
									const cs = getComputedStyle(child);
									mt = parseFloat(cs.marginTop || '0') || 0;
									mb = parseFloat(cs.marginBottom || '0') || 0;
								} catch { /* ignore */ }
								minTop = Math.min(minTop, Math.max(0, top - mt));
								maxBottom = Math.max(maxBottom, Math.max(0, top + h + mb));
							} catch { /* ignore */ }
						}
						let docH = 0;
						if (Number.isFinite(minTop) && maxBottom > minTop) {
							docH = Math.max(0, maxBottom - minTop);
						}
						try {
							const cs = getComputedStyle(prose);
							docH += (parseFloat(cs.paddingTop || '0') || 0) + (parseFloat(cs.paddingBottom || '0') || 0);
						} catch { /* ignore */ }
						if (docH && Number.isFinite(docH)) {
							contentH = Math.max(contentH, Math.ceil(docH));
						}
					} catch { /* ignore */ }
					// Fallback: only use scrollHeight if it actually indicates overflow content;
					// otherwise it will just mirror the viewport height and create a feedback loop.
					if (!contentH) {
						try {
							if (typeof prose.scrollHeight === 'number' && typeof prose.clientHeight === 'number') {
								if (prose.scrollHeight > prose.clientHeight + 1) {
									contentH = Math.max(contentH, prose.scrollHeight);
								}
							}
						} catch { /* ignore */ }
					}
				}
				// Fallback: if ProseMirror isn't found, use any contents node's scrollHeight.
				if (!contentH) {
					const wwContents = ui.querySelector('.toastui-editor-ww-container .toastui-editor-contents');
					if (wwContents && typeof wwContents.scrollHeight === 'number' && typeof wwContents.clientHeight === 'number') {
						if (wwContents.scrollHeight > wwContents.clientHeight + 1) {
							contentH = Math.max(contentH, wwContents.scrollHeight);
						}
					}
				}
			} else {
				// Markdown mode uses CodeMirror.
				// Prefer the sizer height (intrinsic document height) so Fit can shrink.
				const cmSizer = ui.querySelector('.toastui-editor-md-container .CodeMirror .CodeMirror-sizer');
				if (cmSizer) {
					try {
						const oh = (typeof cmSizer.offsetHeight === 'number') ? cmSizer.offsetHeight : 0;
						if (oh && Number.isFinite(oh)) contentH = Math.max(contentH, oh);
					} catch { /* ignore */ }
					try {
						const rh = cmSizer.getBoundingClientRect ? (cmSizer.getBoundingClientRect().height || 0) : 0;
						if (rh && Number.isFinite(rh)) contentH = Math.max(contentH, rh);
					} catch { /* ignore */ }
				}
				// Fallback to scrollHeight if the sizer isn't available.
				if (!contentH) {
					const cmScroll = ui.querySelector('.toastui-editor-md-container .CodeMirror .CodeMirror-scroll');
					if (cmScroll && typeof cmScroll.scrollHeight === 'number') {
						contentH = Math.max(contentH, cmScroll.scrollHeight);
					}
				}
				// Fallback: any visible contents area.
				const mdContents = ui.querySelector('.toastui-editor-md-container .toastui-editor-contents');
				if (mdContents && typeof mdContents.scrollHeight === 'number') {
					contentH = Math.max(contentH, mdContents.scrollHeight);
				}
			}
			// Last-ditch fallback (may include hidden containers, so keep it last).
			if (!contentH) {
				const anyContents = ui.querySelector('.toastui-editor-contents');
				if (anyContents && typeof anyContents.scrollHeight === 'number') {
					contentH = Math.max(contentH, anyContents.scrollHeight);
				}
			}
			if (!contentH) return undefined;

			const resizerH = 12;
			// Reduced by 30px to account for removed top padding in preview mode CSS, plus mode-specific adjustments
			const padding = (m === 'wysiwyg') ? -1 : 13; // WYSIWYG: -7+6, Markdown: -7+20
			const minH = 120;
			return Math.max(minH, Math.ceil(toolbarH + contentH + resizerH + padding + FIT_SLACK_PX));
		} catch {
			return undefined;
		}
	};

	const mode = __kustoGetMarkdownMode(id);
	if (mode === 'preview') {
		// Max for preview is the full rendered content: use auto-expand.
		try {
			wrapper.style.height = '';
			if (wrapper.dataset) {
				try { delete wrapper.dataset.kustoUserResized; } catch { /* ignore */ }
				try { delete wrapper.dataset.kustoPrevHeightMd; } catch { /* ignore */ }
			}
		} catch { /* ignore */ }
		try { __kustoUpdateMarkdownPreviewSizing(id); } catch { /* ignore */ }
		try {
			// Ensure viewer is up-to-date before measuring/laying out.
			if (viewerHost && viewerHost.style && viewerHost.style.display !== 'none') {
				const md = markdownEditors && markdownEditors[id] ? String(markdownEditors[id].getValue() || '') : '';
				initMarkdownViewer(id, md);
			}
		} catch { /* ignore */ }
		try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
		return;
	}

	// Markdown/WYSIWYG: max is the editing cap.
	const modeForMeasure = (() => {
		try { return __kustoGetMarkdownMode(id); } catch { return 'wysiwyg'; }
	})();
	const applyOnce = () => {
		try {
			// No max cap for markdown/wysiwyg: grow to fit the current content.
			const desired = tryComputeDesiredWrapperHeight(modeForMeasure);
			if (typeof desired === 'number' && Number.isFinite(desired) && desired > 0) {
				wrapper.style.height = Math.round(desired) + 'px';
			} else {
				// Fallback: if we can't measure, do not change height (avoid runaway growth).
				return;
			}
		} catch { /* ignore */ }
		try {
			const ed = markdownEditors && markdownEditors[id] ? markdownEditors[id] : null;
			if (ed && typeof ed.layout === 'function') {
				ed.layout();
			}
		} catch { /* ignore */ }
	};
	// WYSIWYG layout/scrollHeight can settle a tick later; retry a few times.
	try {
		applyOnce();
		setTimeout(applyOnce, 50);
		setTimeout(applyOnce, 150);
		setTimeout(applyOnce, 350);
	} catch { /* ignore */ }
	try { if (wrapper.dataset) wrapper.dataset.kustoUserResized = 'true'; } catch { /* ignore */ }
	try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
}

function __kustoAutoExpandMarkdownBoxToContent( boxId: any) {
	try {
		if (String((window as any).__kustoDocumentKind || '') !== 'md') {
			return;
		}
		const id = String(boxId || '').trim();
		if (!id) return;
		const editorHost = document.getElementById(id + '_md_editor') as any;
		const wrapper = editorHost && editorHost.closest ? editorHost.closest('.query-editor-wrapper') : null;
		if (!wrapper) return;

		const computeDesired = () => {
			try {
				const ui = editorHost.querySelector ? editorHost.querySelector('.toastui-editor-defaultUI') : null;
				if (!ui) return undefined;
				const toolbar = ui.querySelector('.toastui-editor-defaultUI-toolbar');
				const toolbarH = toolbar && toolbar.getBoundingClientRect ? toolbar.getBoundingClientRect().height : 0;
				const mode = (typeof __kustoGetMarkdownMode === 'function') ? String(__kustoGetMarkdownMode(id) || '') : 'wysiwyg';
				let contentH = 0;
				if (mode === 'wysiwyg') {
					const prose = ui.querySelector('.toastui-editor-ww-container .ProseMirror');
					if (prose) {
						try {
							const r = prose.getBoundingClientRect ? prose.getBoundingClientRect() : null;
							const top = r ? (r.top || 0) : 0;
							let maxBottom = 0;
							const kids = prose.children ? Array.from(prose.children) as any[] : [];
							for (const child of kids) {
								try {
									const cr = child.getBoundingClientRect ? child.getBoundingClientRect() : null;
									const b = cr ? (cr.bottom || 0) : 0;
									if (b && Number.isFinite(b)) maxBottom = Math.max(maxBottom, b);
								} catch { /* ignore */ }
							}
							let docH = 0;
							if (maxBottom > top) {
								docH = Math.max(0, maxBottom - top);
							}
							try {
								const cs = getComputedStyle(prose);
								docH += (parseFloat(cs.paddingTop || '0') || 0) + (parseFloat(cs.paddingBottom || '0') || 0);
							} catch { /* ignore */ }
							if (docH && Number.isFinite(docH)) {
								contentH = Math.max(contentH, Math.ceil(docH));
							}
						} catch { /* ignore */ }
						if (!contentH) {
							try {
								if (typeof prose.scrollHeight === 'number') {
									contentH = Math.max(contentH, prose.scrollHeight);
								}
							} catch { /* ignore */ }
						}
					}
					if (!contentH) {
						const wwContents = ui.querySelector('.toastui-editor-ww-container .toastui-editor-contents');
						if (wwContents && typeof wwContents.scrollHeight === 'number') {
							contentH = Math.max(contentH, wwContents.scrollHeight);
						}
					}
				} else if (mode === 'markdown') {
					const cmSizer = ui.querySelector('.toastui-editor-md-container .CodeMirror .CodeMirror-sizer');
					if (cmSizer) {
						try {
							const oh = (typeof cmSizer.offsetHeight === 'number') ? cmSizer.offsetHeight : 0;
							if (oh && Number.isFinite(oh)) contentH = Math.max(contentH, oh);
						} catch { /* ignore */ }
						try {
							const rh = cmSizer.getBoundingClientRect ? (cmSizer.getBoundingClientRect().height || 0) : 0;
							if (rh && Number.isFinite(rh)) contentH = Math.max(contentH, rh);
						} catch { /* ignore */ }
					}
					if (!contentH) {
						const cmScroll = ui.querySelector('.toastui-editor-md-container .CodeMirror .CodeMirror-scroll');
						if (cmScroll && typeof cmScroll.scrollHeight === 'number') {
							contentH = Math.max(contentH, cmScroll.scrollHeight);
						}
					}
					const mdContents = ui.querySelector('.toastui-editor-md-container .toastui-editor-contents');
					if (mdContents && typeof mdContents.scrollHeight === 'number') {
						contentH = Math.max(contentH, mdContents.scrollHeight);
					}
				}
				if (!contentH) {
					const anyContents = ui.querySelector('.toastui-editor-contents');
					if (anyContents && typeof anyContents.scrollHeight === 'number') {
						contentH = Math.max(contentH, anyContents.scrollHeight);
					}
				}
				if (!contentH) return undefined;
				const padding = 18;
				return Math.max(120, Math.ceil(toolbarH + contentH + padding));
			} catch {
				return undefined;
			}
		};

		const apply = () => {
			try {
				const desired = computeDesired();
				if (typeof desired === 'number' && Number.isFinite(desired) && desired > 0) {
					wrapper.style.height = Math.round(desired) + 'px';
					// Do NOT mark user resized; this is automatic.
					try {
						const ed = markdownEditors && markdownEditors[id] ? markdownEditors[id] : null;
						if (ed && typeof ed.layout === 'function') {
							ed.layout();
						}
					} catch { /* ignore */ }
				}
			} catch { /* ignore */ }
		};

		apply();
		setTimeout(apply, 50);
		setTimeout(apply, 150);
		setTimeout(apply, 350);
	} catch {
		// ignore
	}
}

function __kustoScheduleMdAutoExpand( boxId: any) {
	try {
		if (String((window as any).__kustoDocumentKind || '') !== 'md') {
			return;
		}
		const id = String(boxId || '').trim();
		if (!id) return;
		(window as any).__kustoMdAutoExpandTimersByBoxId = (window as any).__kustoMdAutoExpandTimersByBoxId || {};
		const map = (window as any).__kustoMdAutoExpandTimersByBoxId;
		if (map[id]) {
			try { clearTimeout(map[id]); } catch { /* ignore */ }
		}
		map[id] = setTimeout(() => {
			try { __kustoAutoExpandMarkdownBoxToContent(id); } catch { /* ignore */ }
		}, 80);
	} catch {
		// ignore
	}
}

function __kustoMaximizePythonBox( boxId: any) {
	const id = String(boxId || '').trim();
	if (!id) return;
	const editorEl = document.getElementById(id + '_py_editor') as any;
	const wrapper = editorEl && editorEl.closest ? editorEl.closest('.query-editor-wrapper') : null;
	if (!wrapper) return;
	const applyFitToContent = () => {
		try {
			const ed = (typeof pythonEditors === 'object' && pythonEditors) ? pythonEditors[id] : null;
			if (!ed) return;

			// IMPORTANT: use content height, not scroll height.
			// Monaco's getScrollHeight is often >= the viewport height, which prevents shrinking.
			let contentHeight = 0;
			try {
				const ch = (typeof ed.getContentHeight === 'function') ? ed.getContentHeight() : 0;
				if (ch && Number.isFinite(ch)) contentHeight = Math.max(contentHeight, ch);
			} catch { /* ignore */ }
			if (!contentHeight || !Number.isFinite(contentHeight) || contentHeight <= 0) return;

			let chrome = 0;
			try {
				for (const child of Array.from(wrapper.children || []) as any[]) {
					if (!child || child === editorEl) continue;
					try {
						const cs = getComputedStyle(child);
						if (cs && cs.display === 'none') continue;
					} catch { /* ignore */ }
					chrome += (child.getBoundingClientRect ? (child.getBoundingClientRect().height || 0) : 0);
				}
			} catch { /* ignore */ }
			try {
				const csw = getComputedStyle(wrapper);
				chrome += (parseFloat(csw.paddingTop || '0') || 0) + (parseFloat(csw.paddingBottom || '0') || 0);
				chrome += (parseFloat(csw.borderTopWidth || '0') || 0) + (parseFloat(csw.borderBottomWidth || '0') || 0);
			} catch { /* ignore */ }

			const desired = Math.max(120, Math.min(20000, Math.ceil(chrome + contentHeight)));
			try {
				wrapper.style.height = desired + 'px';
				wrapper.style.minHeight = '0';
			} catch { /* ignore */ }
			try { if (wrapper.dataset) wrapper.dataset.kustoUserResized = 'true'; } catch { /* ignore */ }
			try { if (typeof ed.layout === 'function') ed.layout(); } catch { /* ignore */ }
		} catch { /* ignore */ }
	};

	try {
		applyFitToContent();
		setTimeout(applyFitToContent, 50);
		setTimeout(applyFitToContent, 150);
	} catch { /* ignore */ }
	try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
}

function __kustoEnsureMarkdownModeMap() {
	try {
		if (!(window as any).__kustoMarkdownModeByBoxId || typeof (window as any).__kustoMarkdownModeByBoxId !== 'object') {
			(window as any).__kustoMarkdownModeByBoxId = {};
		}
	} catch {
		// ignore
	}
	return (window as any).__kustoMarkdownModeByBoxId;
}

function __kustoGetMarkdownMode( boxId: any) {
	try {
		const map = __kustoEnsureMarkdownModeMap();
		const v = map && boxId ? String(map[boxId] || '') : '';
		if (v === 'preview' || v === 'markdown' || v === 'wysiwyg') {
			return v;
		}
	} catch {
		// ignore
	}
	return 'wysiwyg';
}

function __kustoSetMarkdownMode( boxId: any, mode: any) {
	const m = (String(mode || '').toLowerCase() === 'preview')
		? 'preview'
		: (String(mode || '').toLowerCase() === 'markdown')
			? 'markdown'
			: 'wysiwyg';
	try {
		const map = __kustoEnsureMarkdownModeMap();
		map[boxId] = m;
	} catch {
		// ignore
	}
	try { __kustoApplyMarkdownEditorMode(boxId); } catch { /* ignore */ }
	try { __kustoScheduleMdAutoExpand(boxId); } catch { /* ignore */ }
	try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
}

function __kustoUpdateMarkdownModeButtons( boxId: any) {
	const mode = __kustoGetMarkdownMode(boxId);
	const ids: any = {
		preview: boxId + '_md_mode_preview',
		markdown: boxId + '_md_mode_markdown',
		wysiwyg: boxId + '_md_mode_wysiwyg'
	};
	for (const key of Object.keys(ids)) {
		const btn = document.getElementById(ids[key]) as any;
		if (!btn) continue;
		const active = key === mode;
		try { btn.classList.toggle('is-active', active); } catch { /* ignore */ }
		try { btn.setAttribute('aria-selected', active ? 'true' : 'false'); } catch { /* ignore */ }
	}
	// Update the dropdown text for narrow widths
	try {
		const dropdownText = document.getElementById(boxId + '_md_mode_dropdown_text') as any;
		if (dropdownText) {
			const labels = { wysiwyg: 'WYSIWYG', markdown: 'Markdown', preview: 'Preview' };
			dropdownText.textContent = labels[mode] || 'Mode';
		}
	} catch { /* ignore */ }
}

// Toggle the markdown mode dropdown menu visibility
function __kustoToggleMdModeDropdown( boxId: any, ev: any) {
	try {
		// Stop propagation to prevent the document click handler from closing the menu
		if (ev && typeof ev.stopPropagation === 'function') {
			ev.stopPropagation();
		}
		const menu = document.getElementById(boxId + '_md_mode_dropdown_menu') as any;
		const btn = document.getElementById(boxId + '_md_mode_dropdown_btn') as any;
		if (!menu || !btn) return;
		const isOpen = menu.style.display !== 'none';
		// Close all other dropdowns first
		try { (window as any).__kustoDropdown && (window as any).__kustoDropdown.closeAllMenus(); } catch { /* ignore */ }
		if (isOpen) {
			menu.style.display = 'none';
			btn.setAttribute('aria-expanded', 'false');
		} else {
			menu.style.display = 'block';
			btn.setAttribute('aria-expanded', 'true');
		}
	} catch { /* ignore */ }
}

// Close the markdown mode dropdown menu
function __kustoCloseMdModeDropdown( boxId: any) {
	try {
		const menu = document.getElementById(boxId + '_md_mode_dropdown_menu') as any;
		const btn = document.getElementById(boxId + '_md_mode_dropdown_btn') as any;
		if (menu) menu.style.display = 'none';
		if (btn) btn.setAttribute('aria-expanded', 'false');
	} catch { /* ignore */ }
}

// Close all md-mode dropdowns when clicking outside
try {
	document.addEventListener('click', (ev: any) => {
		try {
			const target = ev.target;
			if (!target) return;
			// Check if the click was inside any md-mode dropdown
			const inDropdown = target.closest && target.closest('.md-mode-dropdown');
			if (!inDropdown) {
				// Close all md-mode dropdown menus
				const menus = document.querySelectorAll('.md-mode-dropdown-menu');
				const btns = document.querySelectorAll('.md-mode-dropdown-btn');
				for (const m of menus as any) {
					try { m.style.display = 'none'; } catch { /* ignore */ }
				}
				for (const b of btns) {
					try { b.setAttribute('aria-expanded', 'false'); } catch { /* ignore */ }
				}
			}
		} catch { /* ignore */ }
	});
} catch { /* ignore */ }

// Width thresholds for responsive mode buttons
const __kustoMdModeNarrowThreshold = 450;
const __kustoMdModeVeryNarrowThreshold = 250;

// Track ResizeObservers for markdown sections
const __kustoMdModeResizeObservers: any = {};

// Check if a markdown section should show the dropdown vs buttons
function __kustoUpdateMdModeResponsive( boxId: any) {
	try {
		const box = document.getElementById(boxId) as any;
		if (!box) return;
		const width = box.offsetWidth || 0;
		const isNarrow = width > 0 && width < __kustoMdModeNarrowThreshold;
		const isVeryNarrow = width > 0 && width < __kustoMdModeVeryNarrowThreshold;
		box.classList.toggle('is-md-narrow', isNarrow);
		box.classList.toggle('is-md-very-narrow', isVeryNarrow);
	} catch { /* ignore */ }
}

// Set up ResizeObserver for a markdown section to handle responsive mode buttons
function __kustoSetupMdModeResizeObserver( boxId: any) {
	try {
		if (__kustoMdModeResizeObservers[boxId]) return; // Already set up
		const box = document.getElementById(boxId) as any;
		if (!box) return;
		if (typeof ResizeObserver === 'undefined') return;
		const observer = new ResizeObserver(() => {
			try { __kustoUpdateMdModeResponsive(boxId); } catch { /* ignore */ }
		});
		observer.observe(box);
		__kustoMdModeResizeObservers[boxId] = observer;
		// Initial check
		__kustoUpdateMdModeResponsive(boxId);
	} catch { /* ignore */ }
}

// Clean up ResizeObserver when a markdown section is removed
function __kustoCleanupMdModeResizeObserver( boxId: any) {
	try {
		const observer = __kustoMdModeResizeObservers[boxId];
		if (observer && typeof observer.disconnect === 'function') {
			observer.disconnect();
		}
		delete __kustoMdModeResizeObservers[boxId];
	} catch { /* ignore */ }
}

// ============================================================================
// Generic section mode dropdown (for Chart and Transformation sections)
// ============================================================================

// Toggle the section mode dropdown menu visibility
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
		try { (window as any).__kustoDropdown && (window as any).__kustoDropdown.closeAllMenus(); } catch { /* ignore */ }
		if (isOpen) {
			menu.style.display = 'none';
			btn.setAttribute('aria-expanded', 'false');
		} else {
			menu.style.display = 'block';
			btn.setAttribute('aria-expanded', 'true');
		}
	} catch { /* ignore */ }
}

// Close the section mode dropdown menu
function __kustoCloseSectionModeDropdown( boxId: any, prefix: any) {
	try {
		const menu = document.getElementById(boxId + '_' + prefix + '_mode_dropdown_menu') as any;
		const btn = document.getElementById(boxId + '_' + prefix + '_mode_dropdown_btn') as any;
		if (menu) menu.style.display = 'none';
		if (btn) btn.setAttribute('aria-expanded', 'false');
	} catch { /* ignore */ }
}

// Track ResizeObservers for chart/transformation sections
const __kustoSectionModeResizeObservers: any = {};

// Check if a section should show the dropdown vs buttons
function __kustoUpdateSectionModeResponsive( boxId: any) {
	try {
		const box = document.getElementById(boxId) as any;
		if (!box) return;
		const width = box.offsetWidth || 0;
		const isNarrow = width > 0 && width < __kustoMdModeNarrowThreshold;
		const isVeryNarrow = width > 0 && width < __kustoMdModeVeryNarrowThreshold;
		box.classList.toggle('is-section-narrow', isNarrow);
		box.classList.toggle('is-section-very-narrow', isVeryNarrow);
	} catch { /* ignore */ }
}

// Set up ResizeObserver for a chart/transformation section
function __kustoSetupSectionModeResizeObserver( boxId: any) {
	try {
		if (__kustoSectionModeResizeObservers[boxId]) return;
		const box = document.getElementById(boxId) as any;
		if (!box) return;
		if (typeof ResizeObserver === 'undefined') return;
		const observer = new ResizeObserver(() => {
			try { __kustoUpdateSectionModeResponsive(boxId); } catch { /* ignore */ }
		});
		observer.observe(box);
		__kustoSectionModeResizeObservers[boxId] = observer;
		// Initial check
		__kustoUpdateSectionModeResponsive(boxId);
	} catch { /* ignore */ }
}

// Clean up ResizeObserver when a chart/transformation section is removed
function __kustoCleanupSectionModeResizeObserver( boxId: any) {
	try {
		const observer = __kustoSectionModeResizeObservers[boxId];
		if (observer && typeof observer.disconnect === 'function') {
			observer.disconnect();
		}
		delete __kustoSectionModeResizeObservers[boxId];
	} catch { /* ignore */ }
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
					try { m.style.display = 'none'; } catch { /* ignore */ }
				}
				for (const b of btns) {
					try { b.setAttribute('aria-expanded', 'false'); } catch { /* ignore */ }
				}
			}
		} catch { /* ignore */ }
	});
} catch { /* ignore */ }

function __kustoUpdateMarkdownPreviewSizing( boxId: any) {
	const box = document.getElementById(boxId) as any;
	const editorHost = document.getElementById(boxId + '_md_editor') as any;
	if (!box || !editorHost) {
		return;
	}
	const mode = __kustoGetMarkdownMode(boxId);
	if (mode !== 'preview') {
		try { box.classList.remove('is-md-preview-auto'); } catch { /* ignore */ }
		try { box.classList.remove('is-md-preview-fixed'); } catch { /* ignore */ }
		return;
	}
	let wrapper = null;
	try {
		wrapper = editorHost.closest ? editorHost.closest('.query-editor-wrapper') : null;
	} catch {
		wrapper = null;
	}
	if (!wrapper) {
		return;
	}

	let userResized = false;
	let hasInlinePx = false;
	try {
		userResized = !!(wrapper.dataset && wrapper.dataset.kustoUserResized === 'true');
	} catch { /* ignore */ }
	try {
		const h = String(wrapper.style && wrapper.style.height ? wrapper.style.height : '').trim();
		hasInlinePx = /^\d+px$/i.test(h);
	} catch { /* ignore */ }

	// Treat an explicit inline px height as a fixed size (even if dataset isn't set yet).
	const fixed = userResized || hasInlinePx;
	try { box.classList.toggle('is-md-preview-fixed', fixed); } catch { /* ignore */ }
	try { box.classList.toggle('is-md-preview-auto', !fixed); } catch { /* ignore */ }
}

function __kustoApplyMarkdownEditorMode( boxId: any) {
	__kustoUpdateMarkdownModeButtons(boxId);

	const box = document.getElementById(boxId) as any;
	const editorHost = document.getElementById(boxId + '_md_editor') as any;
	const viewerHost = document.getElementById(boxId + '_md_viewer') as any;
	if (!box || !editorHost || !viewerHost) {
		return;
	}

	const mode = __kustoGetMarkdownMode(boxId);
	const isPreview = mode === 'preview';

	// Preview sizing behavior:
	// - if user has resized (or we have an explicit px height), keep it fixed and make the viewer scroll
	// - otherwise, clear inline height so it can auto-expand to full content
	try {
		const wrapper = editorHost.closest ? editorHost.closest('.query-editor-wrapper') : null;
		if (wrapper && wrapper.style) {
			if (isPreview) {
				let fixed = false;
				try {
					fixed = !!(wrapper.dataset && wrapper.dataset.kustoUserResized === 'true');
				} catch { /* ignore */ }
				if (!fixed) {
					try {
						const h = String(wrapper.style.height || '').trim();
						fixed = /^\d+px$/i.test(h);
						// If it was set via restore or older flows, mark as user-resized so behavior stays consistent.
						if (fixed) {
							try { wrapper.dataset.kustoUserResized = 'true'; } catch { /* ignore */ }
						}
					} catch { /* ignore */ }
				}
				if (!fixed) {
					// Auto-expand: remove inline height so CSS can size to content.
					wrapper.style.height = '';
				}
			}
		}
	} catch {
		// ignore
	}

	try { box.classList.toggle('is-md-preview', isPreview); } catch { /* ignore */ }
	try { viewerHost.style.display = isPreview ? '' : 'none'; } catch { /* ignore */ }
	try { editorHost.style.display = isPreview ? 'none' : ''; } catch { /* ignore */ }
	try { __kustoUpdateMarkdownPreviewSizing(boxId); } catch { /* ignore */ }

	if (isPreview) {
		let md = '';
		try {
			md = markdownEditors && markdownEditors[boxId] ? String(markdownEditors[boxId].getValue() || '') : '';
		} catch {
			md = '';
		}
		try { initMarkdownViewer(boxId, md); } catch { /* ignore */ }

		// After switching to Preview, auto-run "Fit to contents" so the user
		// immediately sees the full rendered markdown without needing to click.
		// Use a couple retries to handle async preview rendering/layout.
		try {
			const fitToContents = () => {
				try {
					if (typeof __kustoMaximizeMarkdownBox === 'function') {
						__kustoMaximizeMarkdownBox(boxId);
					}
				} catch { /* ignore */ }
			};
			fitToContents();
			setTimeout(fitToContents, 50);
			setTimeout(fitToContents, 150);
			setTimeout(fitToContents, 350);
		} catch { /* ignore */ }

		// In .md files, reset scroll position to prevent layout shift.
		try {
			if (document.body && document.body.dataset && document.body.dataset.kustoDocumentKind === 'md') {
				document.body.scrollTop = 0;
				document.documentElement.scrollTop = 0;
			}
		} catch { /* ignore */ }
		return;
	}

	// Editor modes (Markdown/WYSIWYG)
	let toastEditor = null;
	try {
		toastEditor = markdownEditors && markdownEditors[boxId] ? markdownEditors[boxId]._toastui : null;
	} catch {
		toastEditor = null;
	}
	if (!toastEditor || typeof toastEditor.changeMode !== 'function') {
		return;
	}
	try {
		toastEditor.changeMode(mode, true);
	} catch { /* ignore */ }
	try {
		if (markdownEditors[boxId] && typeof markdownEditors[boxId].layout === 'function') {
			markdownEditors[boxId].layout();
		}
	} catch { /* ignore */ }

	// In .md files, the body shouldn't scroll but Toast UI's changeMode may trigger
	// scrollIntoView internally. Reset scroll position to prevent layout shift.
	try {
		if (document.body && document.body.dataset && document.body.dataset.kustoDocumentKind === 'md') {
			document.body.scrollTop = 0;
			document.documentElement.scrollTop = 0;
		}
	} catch { /* ignore */ }
}

function isLikelyDarkTheme() {
	try {
		const value = getComputedStyle(document.documentElement)
			.getPropertyValue('--vscode-editor-background')
			.trim();
		if (!value) {
			return false;
		}
		let r, g, b;
		if (value.startsWith('#')) {
			const hex = value.slice(1);
			if (hex.length === 3) {
				r = parseInt(hex[0] + hex[0], 16);
				g = parseInt(hex[1] + hex[1], 16);
				b = parseInt(hex[2] + hex[2], 16);
			} else if (hex.length === 6) {
				r = parseInt(hex.slice(0, 2), 16);
				g = parseInt(hex.slice(2, 4), 16);
				b = parseInt(hex.slice(4, 6), 16);
			} else {
				return false;
			}
		} else {
			const m = value.match(/rgba?\((\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
			if (!m) {
				return false;
			}
			r = parseInt(m[1], 10);
			g = parseInt(m[2], 10);
			b = parseInt(m[3], 10);
		}
		const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
		return luma < 128;
	} catch {
		return false;
	}
}

function getToastUiPlugins( ToastEditor: any) {
	try {
		const colorSyntax = ToastEditor && ToastEditor.plugin && typeof ToastEditor.plugin.colorSyntax === 'function'
			? ToastEditor.plugin.colorSyntax
			: null;
		if (colorSyntax) {
			return [[colorSyntax, {}]];
		}
	} catch {
		// ignore
	}
	return [];
}

function ensureMarkedGlobal() {
	// Marked may have registered itself as an AMD module (because Monaco installs `define.amd`)
	// instead of attaching to `window.marked`. Preview rendering expects `marked` to exist,
	// so if it's missing, try to resolve it from the AMD loader.
	try {
		if (typeof (_win.marked as any) !== 'undefined' && (_win.marked as any)) {
			return Promise.resolve((_win.marked as any));
		}
	} catch {
		// ignore
	}

	if (markdownMarkedResolvePromise) {
		return markdownMarkedResolvePromise;
	}

	markdownMarkedResolvePromise = new Promise((resolve: any) => {
		try {
			if (typeof require === 'function') {
				(require as any)(
					['marked'],
					(m: any) => {
						try {
							if (typeof (_win.marked as any) === 'undefined' || !(_win.marked as any)) {
								// Best-effort: make it available as a global for the existing renderer.
								(window as any).marked = m;
							}
						} catch {
							// ignore
						}
						resolve(m);
					},
					() => resolve(null)
				);
				return;
			}
		} catch {
			// ignore
		}
		resolve(null);
	});

	return markdownMarkedResolvePromise;
}

function addMarkdownBox( options: any) {
	const id = (options && options.id) ? String(options.id) : ('markdown_' + Date.now());
	markdownBoxes.push(id);

	// Allow restore/persistence to set an initial mode before the editor/viewer initializes.
	try {
		const rawMode = options && typeof options.mode !== 'undefined' ? String(options.mode || '').toLowerCase() : '';
		if (rawMode === 'preview' || rawMode === 'markdown' || rawMode === 'wysiwyg') {
			const map = __kustoEnsureMarkdownModeMap();
			map[id] = rawMode;
		}
	} catch {
		// ignore
	}

	// Ensure initial markdown text is available before TOAST UI initializes.
	try {
		const initialText = options && typeof options.text === 'string' ? options.text : undefined;
		if (typeof initialText === 'string') {
			(window as any).__kustoPendingMarkdownTextByBoxId = (window as any).__kustoPendingMarkdownTextByBoxId || {};
			(window as any).__kustoPendingMarkdownTextByBoxId[id] = initialText;
		}
	} catch {
		// ignore
	}

	const container = document.getElementById('queries-container') as any;
	if (!container) {
		return;
	}

	const litEl = document.createElement('kw-markdown-section');
	litEl.id = id;
	litEl.setAttribute('box-id', id);

	// For plain .md files, enable full-page mode (no section chrome).
	try {
		if (String((window as any).__kustoDocumentKind || '') === 'md' || (options && options.mdAutoExpand)) {
			litEl.setAttribute('plain-md', '');
		}
	} catch { /* ignore */ }

	// Pass initial text if available.
	const pendingText = (window as any).__kustoPendingMarkdownTextByBoxId && (window as any).__kustoPendingMarkdownTextByBoxId[id];
	if (typeof pendingText === 'string') {
		litEl.setAttribute('initial-text', pendingText);
	}

	// Create light-DOM containers that TOAST UI will render into (via <slot>).
	const editorDiv = document.createElement('div');
	editorDiv.className = 'kusto-markdown-editor';
	editorDiv.id = id + '_md_editor';
	editorDiv.slot = 'editor';
	litEl.appendChild(editorDiv);

	const viewerDiv = document.createElement('div');
	viewerDiv.className = 'markdown-viewer';
	viewerDiv.id = id + '_md_viewer';
	viewerDiv.slot = 'viewer';
	viewerDiv.style.display = 'none';
	litEl.appendChild(viewerDiv);

	// Handle remove event from the Lit component.
	litEl.addEventListener('section-remove', function (e: any) {
		try { removeMarkdownBox(e.detail.boxId); } catch { /* ignore */ }
	});

	container.appendChild(litEl);

	// Apply persisted height.
	try {
		const h = options && typeof options.editorHeightPx === 'number' ? options.editorHeightPx : undefined;
		const isPlainMd = String((window as any).__kustoDocumentKind || '') === 'md';
		if (!isPlainMd && typeof h === 'number' && Number.isFinite(h) && h > 0) {
			litEl.setAttribute('editor-height-px', String(h));
		}
	} catch { /* ignore */ }

	// Apply persisted mode.
	try {
		const rawMode = options && typeof options.mode !== 'undefined' ? String(options.mode || '').toLowerCase() : '';
		if (rawMode === 'preview' || rawMode === 'markdown' || rawMode === 'wysiwyg') {
			if (typeof litEl.setMarkdownMode === 'function') {
				litEl.setMarkdownMode(rawMode);
			}
		}
	} catch { /* ignore */ }

	try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
	try {
		const isPlainMd = String((window as any).__kustoDocumentKind || '') === 'md';
		if (!isPlainMd) {
			const controls = document.querySelector('.add-controls');
			if (controls && typeof controls.scrollIntoView === 'function') {
				controls.scrollIntoView({ block: 'end' });
			}
		}
	} catch {
		// ignore
	}
	return id;
}

function __kustoAutoFitMarkdownBoxHeight( boxId: any) {
	const tryFit = () => {
		try {
			const container = document.getElementById(boxId + '_md_editor') as any;
			if (!container || !container.closest) {
				return false;
			}
			const wrapper = container.closest('.query-editor-wrapper');
			if (!wrapper) {
				return false;
			}
			// Never override user resizing.
			try {
				if (wrapper.dataset && wrapper.dataset.kustoUserResized === 'true') {
					return true;
				}
			} catch { /* ignore */ }

			const ui = container.querySelector('.toastui-editor-defaultUI');
			if (!ui) {
				return false;
			}
			const toolbar = ui.querySelector('.toastui-editor-defaultUI-toolbar');
			const toolbarH = toolbar && toolbar.getBoundingClientRect ? toolbar.getBoundingClientRect().height : 0;

			let contentH = 0;
			const prose = ui.querySelector('.toastui-editor-main .ProseMirror');
			if (prose && typeof prose.scrollHeight === 'number') {
				contentH = prose.scrollHeight;
			}
			if (!contentH) {
				const contents = ui.querySelector('.toastui-editor-contents');
				if (contents && typeof contents.scrollHeight === 'number') {
					contentH = contents.scrollHeight;
				}
			}
			if (!contentH) {
				return false;
			}

			const resizerH = 12;
			const minH = 120;
			const maxH = (() => {
				try {
					const vh = typeof window !== 'undefined' ? (window.innerHeight || 0) : 0;
					if (vh > 0) {
						return Math.max(240, Math.min(640, Math.floor(vh * 0.7)));
					}
				} catch { /* ignore */ }
				return 520;
			})();

			// Add a small padding to avoid clipping the last line.
			const padding = 18;
			const desired = Math.min(maxH, Math.max(minH, Math.ceil(toolbarH + contentH + resizerH + padding)));
			wrapper.style.height = desired + 'px';
			return true;
		} catch {
			return false;
		}
	};

	// Toast UI initializes asynchronously; retry a few times.
	let attempt = 0;
	const delays = [0, 50, 150, 300, 600, 1200];
	const step = () => {
		attempt++;
		const ok = tryFit();
		if (ok) {
			return;
		}
		if (attempt >= delays.length) {
			return;
		}
		try {
			setTimeout(step, delays[attempt]);
		} catch {
			// ignore
		}
	};
	step();
}

function removeMarkdownBox( boxId: any) {
	if (markdownEditors[boxId]) {
		try { markdownEditors[boxId].dispose(); } catch { /* ignore */ }
		delete markdownEditors[boxId];
	}
	if (markdownViewers[boxId]) {
		try { markdownViewers[boxId].dispose(); } catch { /* ignore */ }
		delete markdownViewers[boxId];
	}
	try { __kustoCleanupMdModeResizeObserver(boxId); } catch { /* ignore */ }
	markdownBoxes = markdownBoxes.filter((id: any) => id !== boxId);
	const box = document.getElementById(boxId) as any;
	if (box && box.parentNode) {
		box.parentNode.removeChild(box);
	}
	try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
	try {
		if ((window as any).__kustoMarkdownModeByBoxId && typeof (window as any).__kustoMarkdownModeByBoxId === 'object') {
			delete (window as any).__kustoMarkdownModeByBoxId[boxId];
		}
	} catch { /* ignore */ }
}

function __kustoUpdateMarkdownVisibilityToggleButton( boxId: any) {
	const btn = document.getElementById(boxId + '_toggle') as any;
	if (!btn) {
		return;
	}
	let expanded = true;
	try {
		expanded = !((window as any).__kustoMarkdownExpandedByBoxId && (window as any).__kustoMarkdownExpandedByBoxId[boxId] === false);
	} catch { /* ignore */ }
	btn.classList.toggle('is-active', expanded);
	btn.setAttribute('aria-selected', expanded ? 'true' : 'false');
	btn.title = expanded ? 'Hide' : 'Show';
	btn.setAttribute('aria-label', expanded ? 'Hide' : 'Show');
}

function __kustoApplyMarkdownBoxVisibility( boxId: any) {
	const box = document.getElementById(boxId) as any;
	if (!box) {
		return;
	}
	let expanded = true;
	try {
		expanded = !((window as any).__kustoMarkdownExpandedByBoxId && (window as any).__kustoMarkdownExpandedByBoxId[boxId] === false);
	} catch { /* ignore */ }
	try {
		box.classList.toggle('is-collapsed', !expanded);
	} catch { /* ignore */ }
	if (expanded) {
		try {
			setTimeout(() => {
				try {
					const ed = (typeof markdownEditors === 'object' && markdownEditors) ? markdownEditors[boxId] : null;
					if (ed && typeof ed.layout === 'function') {
						ed.layout();
					}
				} catch { /* ignore */ }
			}, 0);
		} catch { /* ignore */ }
	}
}

function toggleMarkdownBoxVisibility( boxId: any) {
	try {
		if (!(window as any).__kustoMarkdownExpandedByBoxId || typeof (window as any).__kustoMarkdownExpandedByBoxId !== 'object') {
			(window as any).__kustoMarkdownExpandedByBoxId = {};
		}
		const current = !((window as any).__kustoMarkdownExpandedByBoxId[boxId] === false);
		(window as any).__kustoMarkdownExpandedByBoxId[boxId] = !current;
	} catch { /* ignore */ }
	try { __kustoUpdateMarkdownVisibilityToggleButton(boxId); } catch { /* ignore */ }
	try { __kustoApplyMarkdownBoxVisibility(boxId); } catch { /* ignore */ }
	try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
}

function initMarkdownViewer( boxId: any, initialValue: any) {
	const container = document.getElementById(boxId + '_md_viewer') as any;
	if (!container) {
		return;
	}

	// If a viewer exists, ensure it's still attached to this container.
	try {
		const existing = markdownViewers && markdownViewers[boxId] ? markdownViewers[boxId] : null;
		if (existing) {
			const attached = !!(container.querySelector && container.querySelector('.toastui-editor-contents'));
			if (attached) {
				if (typeof initialValue === 'string' && typeof existing.setValue === 'function') {
					try { existing.setValue(initialValue); } catch { /* ignore */ }
				}
				return;
			}
			try { existing.dispose && existing.dispose(); } catch { /* ignore */ }
			try { delete markdownViewers[boxId]; } catch { /* ignore */ }
		}
	} catch {
		// ignore
	}

	let ToastEditor = null;
	try {
		ToastEditor = ((window as any).toastui && (window as any).toastui.Editor) ? (window as any).toastui.Editor : null;
	} catch {
		ToastEditor = null;
	}

	if (!ToastEditor) {
		// Webview scripts load sequentially, but keep a small retry loop for safety.
		let attempt = 0;
		try {
			(window as any).__kustoToastUiViewerInitRetryCountByBoxId = (window as any).__kustoToastUiViewerInitRetryCountByBoxId || {};
			attempt = ((window as any).__kustoToastUiViewerInitRetryCountByBoxId[boxId] || 0) + 1;
			(window as any).__kustoToastUiViewerInitRetryCountByBoxId[boxId] = attempt;
		} catch {
			attempt = 1;
		}

		const delays = [50, 250, 1000, 2000, 4000];
		const delay = delays[Math.min(attempt - 1, delays.length - 1)];
		if (attempt <= delays.length) {
			try {
				setTimeout(() => {
					try { initMarkdownViewer(boxId, initialValue); } catch { /* ignore */ }
				}, delay);
			} catch {
				// ignore
			}
		} else {
			try { console.error('TOAST UI Editor is not available (markdown viewer).'); } catch { /* ignore */ }
		}
		return;
	}

	// Ensure a clean mount point.
	try { container.textContent = ''; } catch { /* ignore */ }

	let instance = null;
	try {
		const opts: any = {
			usageStatistics: false,
			initialValue: typeof initialValue === 'string' ? initialValue : '',
			plugins: getToastUiPlugins(ToastEditor),
			events: {
				afterPreviewRender: () => {
					try { __kustoRewriteToastUiImagesInContainer(container); } catch { /* ignore */ }
				}
			}
		};
		if (isLikelyDarkTheme()) {
			opts.theme = 'dark';
		}
		instance = (typeof ToastEditor.factory === 'function') ? ToastEditor.factory(opts) : new ToastEditor(opts);
	} catch (e: any) {
		try { console.error('Failed to initialize TOAST UI Editor (markdown viewer).', e); } catch { /* ignore */ }
		return;
	}

	try { __kustoRewriteToastUiImagesInContainer(container); } catch { /* ignore */ }

	markdownViewers[boxId] = {
		setValue: (value: any) => {
			try {
				if (instance && typeof instance.setMarkdown === 'function') {
					instance.setMarkdown(String(value || ''));
				}
			} catch {
				// ignore
			}
		},
		dispose: () => {
			try {
				if (instance && typeof instance.destroy === 'function') {
					instance.destroy();
				}
			} catch {
				// ignore
			}
		}
	};

	// Ensure theme switches (dark/light) are reflected without recreating the viewer.
	try { __kustoStartToastUiThemeObserver(); } catch { /* ignore */ }
	try { __kustoApplyToastUiThemeAll(); } catch { /* ignore */ }
}

function initMarkdownEditor( boxId: any) {
	const container = document.getElementById(boxId + '_md_editor') as any;
	const viewer = document.getElementById(boxId + '_md_viewer') as any;
	if (!container || !viewer) {
		return;
	}

	const isLikelyDarkTheme = () => {
		try {
			const value = getComputedStyle(document.documentElement)
				.getPropertyValue('--vscode-editor-background')
				.trim();
			if (!value) {
				return false;
			}
			let r, g, b;
			if (value.startsWith('#')) {
				const hex = value.slice(1);
				if (hex.length === 3) {
					r = parseInt(hex[0] + hex[0], 16);
					g = parseInt(hex[1] + hex[1], 16);
					b = parseInt(hex[2] + hex[2], 16);
				} else if (hex.length === 6) {
					r = parseInt(hex.slice(0, 2), 16);
					g = parseInt(hex.slice(2, 4), 16);
					b = parseInt(hex.slice(4, 6), 16);
				} else {
					return false;
				}
			} else {
				const m = value.match(/rgba?\((\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
				if (!m) {
					return false;
				}
				r = parseInt(m[1], 10);
				g = parseInt(m[2], 10);
				b = parseInt(m[3], 10);
			}
			const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
			return luma < 128;
		} catch {
			return false;
		}
	};

	// If an editor exists, ensure it's still attached to this container.
	try {
		const existing = markdownEditors && markdownEditors[boxId] ? markdownEditors[boxId] : null;
		if (existing) {
			const attached = !!(container.querySelector && container.querySelector('.toastui-editor-defaultUI'));
			if (attached) {
				return;
			}
			try { existing.dispose && existing.dispose(); } catch { /* ignore */ }
			try { delete markdownEditors[boxId]; } catch { /* ignore */ }
		}
	} catch {
		// ignore
	}

	let ToastEditor = null;
	try {
		ToastEditor = ((window as any).toastui && (window as any).toastui.Editor) ? (window as any).toastui.Editor : null;
	} catch {
		ToastEditor = null;
	}

	if (!ToastEditor) {
		// Webview scripts load sequentially, but keep a small retry loop for safety.
		let attempt = 0;
		try {
			(window as any).__kustoToastUiInitRetryCountByBoxId = (window as any).__kustoToastUiInitRetryCountByBoxId || {};
			attempt = ((window as any).__kustoToastUiInitRetryCountByBoxId[boxId] || 0) + 1;
			(window as any).__kustoToastUiInitRetryCountByBoxId[boxId] = attempt;
		} catch {
			attempt = 1;
		}

		const delays = [50, 250, 1000, 2000, 4000];
		const delay = delays[Math.min(attempt - 1, delays.length - 1)];
		if (attempt <= delays.length) {
			try {
				setTimeout(() => {
					try { initMarkdownEditor(boxId); } catch { /* ignore */ }
				}, delay);
			} catch {
				// ignore
			}
		} else {
			try { console.error('TOAST UI Editor is not available (markdown editor).'); } catch { /* ignore */ }
		}
		return;
	}

	container.style.minHeight = '0';
	container.style.minWidth = '0';

	// Avoid setMarkdown() during init; pass initial value into the constructor.
	let initialValue = '';
	try {
		const pending = (window as any).__kustoPendingMarkdownTextByBoxId && (window as any).__kustoPendingMarkdownTextByBoxId[boxId];
		if (typeof pending === 'string') {
			initialValue = pending;
			try { delete (window as any).__kustoPendingMarkdownTextByBoxId[boxId]; } catch { /* ignore */ }
		}
	} catch {
		// ignore
	}

	try {
		// Ensure a clean mount point.
		container.textContent = '';
	} catch {
		// ignore
	}

	// Create undo/redo toolbar button elements.
	// These are custom toolbar items that trigger ProseMirror's undo/redo commands.
	let undoButton = null;
	let redoButton = null;
	let toastEditorRef: any = null; // Will be set after editor creation
	try {
		// Undo button
		undoButton = document.createElement('button');
		undoButton.type = 'button';
		undoButton.className = 'toastui-editor-toolbar-icons undo';
		undoButton.setAttribute('aria-label', 'Undo');
		undoButton.title = 'Undo (Ctrl+Z)';
		undoButton.style.backgroundImage = 'none';
		undoButton.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/></svg>';
		undoButton.addEventListener('click', () => {
			try {
				if (toastEditorRef) {
					const modeEditor = toastEditorRef.getCurrentModeEditor ? toastEditorRef.getCurrentModeEditor() : null;
					if (modeEditor && modeEditor.commands && typeof modeEditor.commands.undo === 'function') {
						modeEditor.commands.undo();
					}
				}
			} catch { /* ignore */ }
		});

		// Redo button
		redoButton = document.createElement('button');
		redoButton.type = 'button';
		redoButton.className = 'toastui-editor-toolbar-icons redo';
		redoButton.setAttribute('aria-label', 'Redo');
		redoButton.title = 'Redo (Ctrl+Y)';
		redoButton.style.backgroundImage = 'none';
		redoButton.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 7v6h-6"/><path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3L21 13"/></svg>';
		redoButton.addEventListener('click', () => {
			try {
				if (toastEditorRef) {
					const modeEditor = toastEditorRef.getCurrentModeEditor ? toastEditorRef.getCurrentModeEditor() : null;
					if (modeEditor && modeEditor.commands && typeof modeEditor.commands.redo === 'function') {
						modeEditor.commands.redo();
					}
				}
			} catch { /* ignore */ }
		});
	} catch { /* ignore */ }

	let toastEditor = null;
	try {
		// Build the toolbarItems array with undo/redo as the first group
		const toolbarItemsConfig = [];
		
		// First group: undo/redo buttons (custom elements)
		if (undoButton && redoButton) {
			toolbarItemsConfig.push([
				{ name: 'undo', el: undoButton, tooltip: 'Undo (Ctrl+Z)' },
				{ name: 'redo', el: redoButton, tooltip: 'Redo (Ctrl+Y)' }
			]);
		}
		
		// Default toolbar groups
		toolbarItemsConfig.push(
			['heading', 'bold', 'italic', 'strike'],
			['hr', 'quote'],
			['ul', 'ol', 'task', 'indent', 'outdent'],
			['table', 'image', 'link'],
			['code', 'codeblock']
		);

		const editorOptions: any = {
			el: container,
			height: '100%',
			initialEditType: 'wysiwyg',
			previewStyle: 'vertical',
			hideModeSwitch: true,
			usageStatistics: false,
			initialValue,
			toolbarItems: toolbarItemsConfig,
			plugins: getToastUiPlugins(ToastEditor),
			events: {
				change: () => {
					try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
					try { __kustoScheduleMdAutoExpand && __kustoScheduleMdAutoExpand(boxId); } catch { /* ignore */ }
				},
				afterPreviewRender: () => {
					try { __kustoRewriteToastUiImagesInContainer(container); } catch { /* ignore */ }
				}
			}
		};
		if (isLikelyDarkTheme()) {
			editorOptions.theme = 'dark';
		}

		toastEditor = new ToastEditor({
			...editorOptions
		});
		
		// Set the reference so toolbar buttons can access the editor
		toastEditorRef = toastEditor;
	} catch (e: any) {
		try { console.error('Failed to initialize TOAST UI Editor (markdown editor).', e); } catch { /* ignore */ }
		return;
	}

	// ─────────────────────────────────────────────────────────────────────────────
	// Keyboard shortcut conflict resolution for VS Code webview.
	//
	// VS Code intercepts certain keyboard shortcuts globally (e.g., Ctrl+B toggles sidebar).
	// When editing markdown, we want shortcuts like Ctrl+B (bold), Ctrl+I (italic), etc.
	// to be handled by the markdown editor, not VS Code.
	//
	// IMPORTANT: We only intercept shortcuts when the markdown editor is FOCUSED.
	// When focus is elsewhere (Monaco editor, results table, etc.), VS Code shortcuts
	// continue to work normally.
	//
	// Strategy:
	// - For markdown formatting shortcuts (Ctrl+B, Ctrl+I, Ctrl+U, etc.): prevent VS Code
	//   from seeing them by stopping propagation and letting ToastUI handle them.
	// - For Ctrl+S (save): intercept it from ToastUI (which uses it for strikethrough)
	//   and re-dispatch to VS Code for file save functionality.
	// - For Ctrl+Z/Y (undo/redo) and Ctrl+V (paste): prevent VS Code from performing
	//   document-level undo/redo/paste which would cause a full editor reload.
	// ─────────────────────────────────────────────────────────────────────────────
	try {
		// Shortcuts that the markdown editor should handle (not VS Code).
		// Ctrl+B = bold (VS Code: toggle sidebar)
		// Ctrl+I = italic
		// Ctrl+U = underline (VS Code: view source in some contexts)
		// Ctrl+E = code (VS Code: quick open recent)
		// Ctrl+K = link (VS Code: chord starter for many commands)
		// Ctrl+L = ordered list (VS Code: select line)
		// Ctrl+Shift+L = unordered list
		// Ctrl+D = strikethrough in some editors (VS Code: add selection to next find match)
		const markdownFormattingKeys = new Set(['b', 'i', 'u', 'e', 'k', 'l', 'd']);

		// Helper to check if focus is inside the markdown editor.
		// ToastUI uses ProseMirror which creates contenteditable elements.
		const isMarkdownEditorFocused = () => {
			try {
				const active = document.activeElement;
				if (!active) return false;
				// Check if focus is inside this ToastUI container.
				// ToastUI's editable area has class 'ProseMirror' or is inside '.toastui-editor'.
				return container.contains(active) && (
					active.classList.contains('ProseMirror') ||
					active.closest('.ProseMirror') ||
					active.closest('.toastui-editor-contents') ||
					(active as any).isContentEditable
				);
			} catch { return false; }
		};

		// Capture phase handler - intercepts keyboard shortcuts before they reach VS Code.
		// For undo/redo, we intercept and then let the event continue to ToastUI's ProseMirror.
		container.addEventListener('keydown', (ev: any) => {
			try {
				const key = ev.key.toLowerCase();
				const hasCtrlOrMeta = ev.ctrlKey || ev.metaKey;

				if (!hasCtrlOrMeta) {
					return; // Not a shortcut we care about
				}

				// Only intercept shortcuts when the markdown editor is focused.
				// This ensures VS Code shortcuts work normally when focus is elsewhere
				// (e.g., Monaco editor, results table, schema panel, etc.).
				if (!isMarkdownEditorFocused()) {
					return;
				}

				// Special case: Ctrl+S - redirect to VS Code for file save.
				// ToastUI/ProseMirror uses Ctrl+S for strikethrough, which conflicts.
				if (key === 's') {
					// Stop ToastUI from receiving this event entirely.
					ev.stopPropagation();
					ev.stopImmediatePropagation();
					ev.preventDefault();
					
					// Re-dispatch to document level so VS Code can handle save.
					try {
						const newEvent = new KeyboardEvent('keydown', {
							key: ev.key,
							code: ev.code,
							keyCode: ev.keyCode,
							which: ev.which,
							ctrlKey: ev.ctrlKey,
							metaKey: ev.metaKey,
							shiftKey: ev.shiftKey,
							altKey: ev.altKey,
							bubbles: true,
							cancelable: true
						});
						document.dispatchEvent(newEvent);
					} catch { /* ignore */ }
					return;
				}

				// Handle Ctrl+Z (undo) - execute via ToastUI commands API, block VS Code
				if (key === 'z' && !ev.shiftKey) {
					ev.stopPropagation();
					ev.stopImmediatePropagation();
					ev.preventDefault();
					// Execute undo directly via ToastUI's commands API
					try {
						const modeEditor = toastEditor && toastEditor.getCurrentModeEditor ? toastEditor.getCurrentModeEditor() : null;
						if (modeEditor && modeEditor.commands && typeof modeEditor.commands.undo === 'function') {
							modeEditor.commands.undo();
						}
					} catch { /* ignore */ }
					return;
				}

				// Handle Ctrl+Shift+Z (redo) - execute via ToastUI commands API, block VS Code
				if (key === 'z' && ev.shiftKey) {
					ev.stopPropagation();
					ev.stopImmediatePropagation();
					ev.preventDefault();
					// Execute redo directly via ToastUI's commands API
					try {
						const modeEditor = toastEditor && toastEditor.getCurrentModeEditor ? toastEditor.getCurrentModeEditor() : null;
						if (modeEditor && modeEditor.commands && typeof modeEditor.commands.redo === 'function') {
							modeEditor.commands.redo();
						}
					} catch { /* ignore */ }
					return;
				}

				// Handle Ctrl+Y (redo) - execute via ToastUI commands API, block VS Code
				// Note: ProseMirror uses Ctrl+Shift+Z for redo, but users expect Ctrl+Y to work too
				if (key === 'y' && !ev.shiftKey) {
					ev.stopPropagation();
					ev.stopImmediatePropagation();
					ev.preventDefault();
					// Execute redo directly via ToastUI's commands API
					try {
						const modeEditor = toastEditor && toastEditor.getCurrentModeEditor ? toastEditor.getCurrentModeEditor() : null;
						if (modeEditor && modeEditor.commands && typeof modeEditor.commands.redo === 'function') {
							modeEditor.commands.redo();
						}
					} catch { /* ignore */ }
					return;
				}

				// Markdown formatting shortcuts - let ToastUI handle them, block VS Code.
				// These are shortcuts where the user intends to format text, not trigger
				// VS Code commands like toggling the sidebar.
				if (markdownFormattingKeys.has(key)) {
					// Stop the event from bubbling to VS Code's webview keyboard handler.
					// This prevents VS Code from seeing Ctrl+B, Ctrl+I, etc.
					ev.stopPropagation();
					// Note: We do NOT call preventDefault() here - ToastUI needs to handle the key.
					// We also do NOT call stopImmediatePropagation() - ToastUI's handlers should run.
				}

				// Block cut/paste from reaching VS Code (let ToastUI handle via default behavior)
				if (key === 'v' || key === 'x') {
					ev.stopPropagation();
				}
			} catch { /* ignore */ }
		}, true); // capture phase - fires before propagation to parent (VS Code)
	} catch { /* ignore */ }

	// Initial pass (in case the preview has already rendered by the time the hook is attached).
	try { __kustoRewriteToastUiImagesInContainer(container); } catch { /* ignore */ }

	const api = {
		getValue: () => {
			try { return toastEditor && typeof toastEditor.getMarkdown === 'function' ? String(toastEditor.getMarkdown() || '') : ''; } catch { return ''; }
		},
		setValue: (value: any) => {
			try {
				if (toastEditor && typeof toastEditor.setMarkdown === 'function') {
					toastEditor.setMarkdown(String(value || ''));
				}
			} catch { /* ignore */ }
		},
		// Undo the last edit in the ToastUI editor.
		// Calls the ProseMirror undo command directly via ToastUI's commands API.
		undo: () => {
			try {
				if (!toastEditor) return false;
				const modeEditor = toastEditor.getCurrentModeEditor ? toastEditor.getCurrentModeEditor() : null;
				if (!modeEditor) return false;
				// ToastUI exposes ProseMirror commands via the commands property
				if (modeEditor.commands && typeof modeEditor.commands.undo === 'function') {
					modeEditor.commands.undo();
					return true;
				}
				return false;
			} catch { return false; }
		},
		// Redo the last undone edit in the ToastUI editor.
		// Calls the ProseMirror redo command directly via ToastUI's commands API.
		redo: () => {
			try {
				if (!toastEditor) return false;
				const modeEditor = toastEditor.getCurrentModeEditor ? toastEditor.getCurrentModeEditor() : null;
				if (!modeEditor) return false;
				// ToastUI exposes ProseMirror commands via the commands property
				if (modeEditor.commands && typeof modeEditor.commands.redo === 'function') {
					modeEditor.commands.redo();
					return true;
				}
				return false;
			} catch { return false; }
		},
		layout: () => {
			try {
				if (!toastEditor || typeof toastEditor.setHeight !== 'function') {
					return;
				}
				const wrapper = container.closest ? container.closest('.query-editor-wrapper') : null;
				const resizer = document.getElementById(boxId + '_md_resizer') as any;
				if (!wrapper) {
					return;
				}
				let h = wrapper.getBoundingClientRect().height;
				try {
					if (resizer) {
						h -= resizer.getBoundingClientRect().height;
					}
				} catch { /* ignore */ }
				h = Math.max(120, h);
				toastEditor.setHeight(Math.round(h) + 'px');
			} catch { /* ignore */ }
		},
		dispose: () => {
			try {
				if (toastEditor && typeof toastEditor.destroy === 'function') {
					toastEditor.destroy();
				}
			} catch { /* ignore */ }
			try { container.textContent = ''; } catch { /* ignore */ }
		},
		_toastui: toastEditor
	};

	markdownEditors[boxId] = api;
	
	// Check for any pending text that might have been set during async initialization
	// (e.g., if toolUpdateMarkdownSection was called while we were creating the editor)
	try {
		const latePending = (window as any).__kustoPendingMarkdownTextByBoxId && (window as any).__kustoPendingMarkdownTextByBoxId[boxId];
		if (typeof latePending === 'string') {
			api.setValue(latePending);
			try { delete (window as any).__kustoPendingMarkdownTextByBoxId[boxId]; } catch { /* ignore */ }
		}
	} catch { /* ignore */ }
	
	try { __kustoApplyMarkdownEditorMode(boxId); } catch { /* ignore */ }
	try { __kustoTryApplyPendingMarkdownReveal(boxId); } catch { /* ignore */ }

	// For multi-section files (.kqlx, .mdx), fix the double-border issue by removing
	// the Toast UI's border (the section wrapper already provides the border).
	try {
		const isPlainMd = String((window as any).__kustoDocumentKind || '') === 'md';
		if (!isPlainMd) {
			const defaultUI = container.querySelector('.toastui-editor-defaultUI');
			if (defaultUI) {
				defaultUI.style.setProperty('border', 'none', 'important');
				defaultUI.style.setProperty('border-radius', '0', 'important');
			}
			const toolbar = container.querySelector('.toastui-editor-defaultUI-toolbar');
			if (toolbar) {
				// Use negative margin to overlap the wrapper border
				toolbar.style.setProperty('margin', '-1px -1px 0 -1px', 'important');
				toolbar.style.setProperty('border-radius', '0', 'important');
			}
		}
	} catch (e: any) { /* ignore border fix error */ }

	// Ensure theme switches (dark/light) are reflected without recreating the editor.
	try { __kustoStartToastUiThemeObserver(); } catch { /* ignore */ }
	try { __kustoApplyToastUiThemeAll(); } catch { /* ignore */ }

	// Drag handle resize (same pattern as the KQL editor).
	try {
		const wrapper = container.closest ? container.closest('.query-editor-wrapper') : null;
		const resizer = document.getElementById(boxId + '_md_resizer') as any;
		if (wrapper && resizer) {
			resizer.addEventListener('mousedown', (e: any) => {
				try {
					e.preventDefault();
					e.stopPropagation();
				} catch {
					// ignore
				}
				try { wrapper.dataset.kustoUserResized = 'true'; } catch { /* ignore */ }

				resizer.classList.add('is-dragging');
				const previousCursor = document.body.style.cursor;
				const previousUserSelect = document.body.style.userSelect;
				document.body.style.cursor = 'ns-resize';
				document.body.style.userSelect = 'none';

				const startPageY = e.clientY + (typeof _win.__kustoGetScrollY === 'function' ? _win.__kustoGetScrollY() : 0);
				const startHeight = wrapper.getBoundingClientRect().height;

				const onMove = (moveEvent: any) => {
					try {
						if (typeof _win.__kustoMaybeAutoScrollWhileDragging === 'function') {
							_win.__kustoMaybeAutoScrollWhileDragging(moveEvent.clientY);
						}
					} catch { /* ignore */ }
					const pageY = moveEvent.clientY + (typeof _win.__kustoGetScrollY === 'function' ? _win.__kustoGetScrollY() : 0);
					const delta = pageY - startPageY;
					let nextHeight = 0;
					try {
						const mode = (typeof __kustoGetMarkdownMode === 'function') ? __kustoGetMarkdownMode(boxId) : 'wysiwyg';
						// Preview mode can auto-expand; markdown/wysiwyg has no max height cap.
						nextHeight = Math.max(120, startHeight + delta);
						if (mode === 'preview') {
							// keep same behavior
						}
					} catch {
						nextHeight = Math.max(120, startHeight + delta);
					}
					wrapper.style.height = nextHeight + 'px';
					try { __kustoUpdateMarkdownPreviewSizing(boxId); } catch { /* ignore */ }
					try { api.layout(); } catch { /* ignore */ }
				};
				const onUp = () => {
					document.removeEventListener('mousemove', onMove, true);
					document.removeEventListener('mouseup', onUp, true);
					resizer.classList.remove('is-dragging');
					document.body.style.cursor = previousCursor;
					document.body.style.userSelect = previousUserSelect;
					try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
				};

				document.addEventListener('mousemove', onMove, true);
				document.addEventListener('mouseup', onUp, true);
			});

			// Double-click to fit editor to contents - delegate to the button's function
			// which already handles all modes (wysiwyg, markdown, preview) correctly with
			// proper fallbacks and retries for async layout settling.
			resizer.addEventListener('dblclick', (e: any) => {
				try {
					e.preventDefault();
					e.stopPropagation();
					if (typeof __kustoMaximizeMarkdownBox === 'function') {
						__kustoMaximizeMarkdownBox(boxId);
					}
				} catch { /* ignore */ }
			});
		}
	} catch {
		// ignore
	}

	// Ensure correct initial sizing.
	try { api.layout(); } catch { /* ignore */ }
}

function __kustoRewriteToastUiImagesInContainer( rootEl: any) {
	try {
		if (!rootEl || !rootEl.querySelectorAll) {
			return;
		}
		const baseUri = (() => {
			try {
				return (typeof (window as any).__kustoDocumentUri === 'string') ? String((window as any).__kustoDocumentUri) : '';
			} catch {
				return '';
			}
		})();
		if (!baseUri) {
			return;
		}

		// Cache across renders to avoid spamming the extension host.
		(window as any).__kustoResolvedImageSrcCache = (window as any).__kustoResolvedImageSrcCache || {};
		const cache = (window as any).__kustoResolvedImageSrcCache;

		const imgs = rootEl.querySelectorAll('img');
		for (const img of imgs) {
			try {
				if (!img || !img.getAttribute) {
					continue;
				}
				const src = String(img.getAttribute('src') || '').trim();
				if (!src) {
					continue;
				}
				const lower = src.toLowerCase();
				if (
					lower.startsWith('http://') ||
					lower.startsWith('https://') ||
					lower.startsWith('blob:') ||
					lower.startsWith('vscode-webview://') ||
					lower.startsWith('vscode-resource:')
				) {
					continue;
				}
				// If ToastUI already rewrote it or we already processed it, skip.
				try {
					if (img.dataset && img.dataset.kustoResolvedSrc === src) {
						continue;
					}
				} catch { /* ignore */ }

				const key = baseUri + '::' + src;
				if (cache && typeof cache[key] === 'string' && cache[key]) {
					img.setAttribute('src', cache[key]);
					try { if (img.dataset) img.dataset.kustoResolvedSrc = src; } catch { /* ignore */ }
					continue;
				}

				const resolver = (window as any).__kustoResolveResourceUri;
				if (typeof resolver !== 'function') {
					continue;
				}

				// Fire-and-forget async resolve; preview is re-rendered frequently.
				resolver({ path: src, baseUri }).then((resolved: any) => {
					try {
						if (!resolved || typeof resolved !== 'string') {
							return;
						}
						cache[key] = resolved;
						img.setAttribute('src', resolved);
						try { if (img.dataset) img.dataset.kustoResolvedSrc = src; } catch { /* ignore */ }
					} catch { /* ignore */ }
				});
			} catch {
				// ignore
			}
		}
	} catch {
		// ignore
	}
}

function addPythonBox( options: any) {
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
	const pendingCode = (window as any).__kustoPendingPythonCodeByBoxId && (window as any).__kustoPendingPythonCodeByBoxId[id];
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
		try { removePythonBox(e.detail.boxId); } catch { /* ignore */ }
	});

	container.appendChild(litEl);

	try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
	try {
		const controls = document.querySelector('.add-controls');
		if (controls && typeof controls.scrollIntoView === 'function') {
			controls.scrollIntoView({ block: 'end' });
		}
	} catch {
		// ignore
	}
	return id;
}

function removePythonBox( boxId: any) {
	// Legacy editor cleanup (for any old-style boxes still in DOM).
	if (pythonEditors[boxId]) {
		try { pythonEditors[boxId].dispose(); } catch { /* ignore */ }
		delete pythonEditors[boxId];
	}
	pythonBoxes = pythonBoxes.filter((id: any) => id !== boxId);
	const box = document.getElementById(boxId) as any;
	if (box && box.parentNode) {
		box.parentNode.removeChild(box);
	}
	try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
}

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
				try { existing.dispose(); } catch { /* ignore */ }
				try { delete pythonEditors[boxId]; } catch { /* ignore */ }
			}
		} catch {
			// ignore
		}

		container.style.minHeight = '0';
		container.style.minWidth = '0';

		// Avoid editor.setValue() during init; pass initial value into create() to reduce timing races.
		let initialValue = '';
		try {
			const pending = (window as any).__kustoPendingPythonCodeByBoxId && (window as any).__kustoPendingPythonCodeByBoxId[boxId];
			if (typeof pending === 'string') {
				initialValue = pending;
				try { delete (window as any).__kustoPendingPythonCodeByBoxId[boxId]; } catch { /* ignore */ }
			}
		} catch {
			// ignore
		}

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
					try { _win.activeMonacoEditor = editor; } catch { /* ignore */ }
					try {
						if (typeof _win.__kustoForceEditorWritable === 'function') {
							_win.__kustoForceEditorWritable(editor);
						}
					} catch { /* ignore */ }
				});
			}
			if (typeof editor.onDidFocusEditorWidget === 'function') {
				editor.onDidFocusEditorWidget(() => {
					try { _win.activeMonacoEditor = editor; } catch { /* ignore */ }
					try {
						if (typeof _win.__kustoForceEditorWritable === 'function') {
							_win.__kustoForceEditorWritable(editor);
						}
					} catch { /* ignore */ }
				});
			}
		} catch {
			// ignore
		}

		pythonEditors[boxId] = editor;
		// Work around sporadic webview timing issues where Monaco input can end up stuck readonly.
		try {
			if (typeof _win.__kustoEnsureEditorWritableSoon === 'function') {
				_win.__kustoEnsureEditorWritableSoon(editor);
			}
		} catch {
			// ignore
		}
		try {
			if (typeof _win.__kustoInstallWritableGuard === 'function') {
				_win.__kustoInstallWritableGuard(editor);
			}
		} catch {
			// ignore
		}
		// If the editor is stuck non-interactive on click, force writable before focusing.
		try {
			container.addEventListener('mousedown', () => {
				try {
					if (typeof _win.__kustoForceEditorWritable === 'function') {
						_win.__kustoForceEditorWritable(editor);
					}
				} catch { /* ignore */ }
				try { editor.focus(); } catch { /* ignore */ }
			}, true);
		} catch {
			// ignore
		}
		// Auto-resize editor to show full content, until the user manually resizes.
		try {
			if (typeof _win.__kustoAttachAutoResizeToContent === 'function') {
				_win.__kustoAttachAutoResizeToContent(editor, container);
			}
		} catch {
			// ignore
		}
		try {
			editor.onDidChangeModelContent(() => {
				try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
			});
		} catch {
			// ignore
		}

		// Drag handle resize (copied from KQL editor behavior).
		try {
			const wrapper = container.closest ? container.closest('.query-editor-wrapper') : null;
			const resizer = document.getElementById(boxId + '_py_resizer') as any;
			if (wrapper && resizer) {
				resizer.addEventListener('mousedown', (e: any) => {
					try {
						e.preventDefault();
						e.stopPropagation();
					} catch {
						// ignore
					}
					try { wrapper.dataset.kustoUserResized = 'true'; } catch { /* ignore */ }

					resizer.classList.add('is-dragging');
					const previousCursor = document.body.style.cursor;
					const previousUserSelect = document.body.style.userSelect;
					document.body.style.cursor = 'ns-resize';
					document.body.style.userSelect = 'none';

						const startPageY = e.clientY + (typeof _win.__kustoGetScrollY === 'function' ? _win.__kustoGetScrollY() : 0);
					const startHeight = wrapper.getBoundingClientRect().height;

					const onMove = (moveEvent: any) => {
							try {
								if (typeof _win.__kustoMaybeAutoScrollWhileDragging === 'function') {
									_win.__kustoMaybeAutoScrollWhileDragging(moveEvent.clientY);
								}
							} catch { /* ignore */ }
							const pageY = moveEvent.clientY + (typeof _win.__kustoGetScrollY === 'function' ? _win.__kustoGetScrollY() : 0);
							const delta = pageY - startPageY;
						const nextHeight = Math.max(120, Math.min(900, startHeight + delta));
						wrapper.style.height = nextHeight + 'px';
						try { editor.layout(); } catch { /* ignore */ }
					};
					const onUp = () => {
						document.removeEventListener('mousemove', onMove, true);
						document.removeEventListener('mouseup', onUp, true);
						resizer.classList.remove('is-dragging');
						document.body.style.cursor = previousCursor;
						document.body.style.userSelect = previousUserSelect;
						try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
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
						if (typeof __kustoMaximizePythonBox === 'function') {
							__kustoMaximizePythonBox(boxId);
						}
					} catch { /* ignore */ }
				});
			}
		} catch {
			// ignore
		}
	}).catch((e: any) => {
		try {
			if (pythonEditors && pythonEditors[boxId]) {
				return;
			}
		} catch {
			// ignore
		}

		let attempt = 0;
		try {
			(window as any).__kustoMonacoInitRetryCountByBoxId = (window as any).__kustoMonacoInitRetryCountByBoxId || {};
			attempt = ((window as any).__kustoMonacoInitRetryCountByBoxId[boxId] || 0) + 1;
			(window as any).__kustoMonacoInitRetryCountByBoxId[boxId] = attempt;
		} catch {
			attempt = 1;
		}

		const delays = [50, 250, 1000, 2000, 4000];
		const delay = delays[Math.min(attempt - 1, delays.length - 1)];
		if (attempt > delays.length) {
			try { console.error('Monaco init failed (python editor).', e); } catch { /* ignore */ }
			return;
		}
		try {
			setTimeout(() => {
				try { initPythonEditor(boxId); } catch { /* ignore */ }
			}, delay);
		} catch {
			// ignore
		}
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

function onPythonResult( message: any) {
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

function onPythonError( message: any) {
	const boxId = message && message.boxId ? String(message.boxId) : '';
	if (!boxId) {
		return;
	}
	setPythonOutput(boxId, String(message.error || 'Python execution failed.'));
}

function addUrlBox( options: any) {
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
		try { removeUrlBox(e.detail.boxId); } catch { /* ignore */ }
	});

	container.appendChild(litEl);

	try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
	try {
		const controls = document.querySelector('.add-controls');
		if (controls && typeof controls.scrollIntoView === 'function') {
			controls.scrollIntoView({ block: 'end' });
		}
	} catch {
		// ignore
	}

	return id;
}

function removeUrlBox( boxId: any) {
	urlBoxes = urlBoxes.filter((id: any) => id !== boxId);
	const box = document.getElementById(boxId) as any;
	if (box && box.parentNode) {
		box.parentNode.removeChild(box);
	}
	try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
}

// (Legacy URL helpers removed — now handled by <kw-url-section> Lit component.)

// ================================
// Transformations section
// ================================

const __kustoTransformationTypeIcons = {
	derive: '<svg viewBox="0 0 32 32" width="32" height="32" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 24h20"/><path d="M10 24V8h12v16"/><path d="M12 12h8"/><path d="M12 16h8"/><path d="M12 20h8"/></svg>',
	summarize: '<svg viewBox="0 0 32 32" width="32" height="32" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 10h20"/><path d="M6 16h14"/><path d="M6 22h10"/><path d="M24 22v-8"/><path d="M21 17l3-3 3 3"/></svg>',
	distinct: '<svg viewBox="0 0 32 32" width="32" height="32" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 10h12"/><path d="M10 16h12"/><path d="M10 22h12"/><circle cx="8" cy="10" r="1.8"/><circle cx="8" cy="16" r="1.8"/><circle cx="8" cy="22" r="1.8"/></svg>',
	pivot: '<svg viewBox="0 0 32 32" width="32" height="32" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="6" width="20" height="20" rx="2"/><path d="M6 14h20"/><path d="M14 6v20"/><path d="M18 10h6"/><path d="M18 18h6"/></svg>'
};

const __kustoTransformMiniPlusIconSvg =
	'<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">' +
	'<path d="M8 3.2v9.6"/>' +
	'<path d="M3.2 8h9.6"/>' +
	'</svg>';

const __kustoTransformMiniTrashIconSvg =
	'<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">' +
	'<path d="M3 5h10"/>' +
	'<path d="M6 5V3.8c0-.4.3-.8.8-.8h2.4c.4 0 .8.3.8.8V5"/>' +
	'<path d="M5.2 5l.6 8.2c0 .5.4.8.8.8h3c.5 0 .8-.4.8-.8l.6-8.2"/>' +
	'<path d="M7 7.4v4.6"/>' +
	'<path d="M9 7.4v4.6"/>' +
	'</svg>';

// Rich tooltip content for calculated column expression help
const __kustoTransformExpressionHelpHtml =
	'<div class="kusto-transform-expr-help-tooltip">' +
		'<div class="kusto-transform-expr-help-header">' +
			'<span class="kusto-transform-expr-help-title">Expression Syntax</span>' +
		'</div>' +
		'<div class="kusto-transform-expr-help-grid">' +
			// Left column
			'<div class="kusto-transform-expr-help-col">' +
				'<div class="kusto-transform-expr-help-group">' +
					'<span class="kusto-transform-expr-help-label">References</span>' +
					'<span class="kusto-transform-expr-help-item"><code data-ex="[ColumnName]">[Col]</code> or <code data-ex="ColumnName">Col</code></span>' +
				'</div>' +
				'<div class="kusto-transform-expr-help-group">' +
					'<span class="kusto-transform-expr-help-label">Operators</span>' +
					'<span class="kusto-transform-expr-help-ops">' +
						'<code data-ex="[Price] + [Tax]">+</code>' +
						'<code data-ex="[Total] - [Discount]">-</code>' +
						'<code data-ex="[Qty] * [UnitPrice]">*</code>' +
						'<code data-ex="[Amount] / 100">/</code>' +
						'<code data-ex="([A] + [B]) * [C]">( )</code>' +
					'</span>' +
				'</div>' +
				'<div class="kusto-transform-expr-help-group">' +
					'<span class="kusto-transform-expr-help-label">Math</span>' +
					'<span class="kusto-transform-expr-help-funcs">' +
						'<code data-ex="round([Price], 2)">round</code>' +
						'<code data-ex="floor([Value])">floor</code>' +
						'<code data-ex="ceiling([Score])">ceiling</code>' +
						'<code data-ex="abs([Delta])">abs</code>' +
					'</span>' +
				'</div>' +
				'<div class="kusto-transform-expr-help-group">' +
					'<span class="kusto-transform-expr-help-label">String</span>' +
					'<span class="kusto-transform-expr-help-funcs">' +
						'<code data-ex="len([Name])">len</code>' +
						'<code data-ex="trim([Text])">trim</code>' +
						'<code data-ex="toupper([Code])">toupper</code>' +
						'<code data-ex="tolower([Email])">tolower</code>' +
						'<code data-ex="substring([Str], 0, 5)">substring</code>' +
						'<code data-ex="replace([Path], &apos;/&apos;, &apos;-&apos;)">replace</code>' +
						'<code data-ex="indexof([Text], &apos;@&apos;)">indexof</code>' +
					'</span>' +
				'</div>' +
			'</div>' +
			// Right column
			'<div class="kusto-transform-expr-help-col">' +
				'<div class="kusto-transform-expr-help-group">' +
					'<span class="kusto-transform-expr-help-label">Date</span>' +
					'<span class="kusto-transform-expr-help-funcs">' +
						'<code data-ex="now()">now</code>' +
						'<code data-ex="datetime(&apos;2024-01-15&apos;)">datetime</code>' +
						'<code data-ex="format_datetime([Date], &apos;yyyy-MM-dd&apos;)">format_datetime</code>' +
						'<code data-ex="getyear([Date])">getyear</code>' +
						'<code data-ex="getmonth([Date])">getmonth</code>' +
						'<code data-ex="getday([Date])">getday</code>' +
						'<code data-ex="dayofweek([Date])">dayofweek</code>' +
					'</span>' +
				'</div>' +
				'<div class="kusto-transform-expr-help-group">' +
					'<span class="kusto-transform-expr-help-label">Truncate</span>' +
					'<span class="kusto-transform-expr-help-funcs">' +
						'<code data-ex="startofday([Timestamp])">startofday</code>' +
						'<code data-ex="startofweek([Date])">startofweek</code>' +
						'<code data-ex="startofmonth([Date])">startofmonth</code>' +
						'<code data-ex="startofyear([Date])">startofyear</code>' +
					'</span>' +
				'</div>' +
				'<div class="kusto-transform-expr-help-group">' +
					'<span class="kusto-transform-expr-help-label">Date Math</span>' +
					'<span class="kusto-transform-expr-help-funcs">' +
						'<code data-ex="datetime_add(&apos;day&apos;, 7, [Date])">datetime_add</code>' +
						'<code data-ex="datetime_diff(&apos;day&apos;, [End], [Start])">datetime_diff</code>' +
					'</span>' +
				'</div>' +
				'<div class="kusto-transform-expr-help-group">' +
					'<span class="kusto-transform-expr-help-label">Convert</span>' +
					'<span class="kusto-transform-expr-help-funcs">' +
						'<code data-ex="tostring([Id])">tostring</code>' +
						'<code data-ex="tonumber([Str])">tonumber</code>' +
						'<code data-ex="coalesce([Value], 0)">coalesce</code>' +
					'</span>' +
				'</div>' +
			'</div>' +
		'</div>' +
		'<div class="kusto-transform-expr-help-examples">' +
			'<span class="kusto-transform-expr-help-example-text">[Price] * 1.1</span>' +
			'<button class="kusto-transform-expr-help-inject-btn" title="Insert into expression">' +
				'<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
					'<path d="M2 4v8M14 4v8"/>' +
					'<path d="M5 8h6M8 5l3 3-3 3"/>' +
				'</svg>' +
			'</button>' +
		'</div>' +
	'</div>';

const __kustoTransformationTypeLabels = {
	derive: 'Calc. Column',
	summarize: 'Summarize',
	distinct: 'Distinct',
	pivot: 'Pivot'
};

// Tooltip state and functions for expression help
let __kustoExprHelpTooltipEl: any = null;
let __kustoExprHelpTooltipTimer: any = null;
let __kustoExprHelpActiveTextarea: any = null;

function __kustoShowExpressionHelpTooltip( textareaEl: any, event: any) {
	// Clear any pending hide timer
	if (__kustoExprHelpTooltipTimer) {
		clearTimeout(__kustoExprHelpTooltipTimer);
		__kustoExprHelpTooltipTimer = null;
	}

	// Store reference to the textarea for injection
	__kustoExprHelpActiveTextarea = textareaEl;

	// Create tooltip element if it doesn't exist
	if (!__kustoExprHelpTooltipEl) {
		__kustoExprHelpTooltipEl = document.createElement('div');
		__kustoExprHelpTooltipEl.className = 'kusto-transform-expr-help-tooltip-container';
		__kustoExprHelpTooltipEl.innerHTML = __kustoTransformExpressionHelpHtml;
		document.body.appendChild(__kustoExprHelpTooltipEl);

		// Keep tooltip open when hovering over it
		__kustoExprHelpTooltipEl.addEventListener('mouseenter', function() {
			if (__kustoExprHelpTooltipTimer) {
				clearTimeout(__kustoExprHelpTooltipTimer);
				__kustoExprHelpTooltipTimer = null;
			}
		});
		__kustoExprHelpTooltipEl.addEventListener('mouseleave', function() {
			__kustoHideExpressionHelpTooltip();
		});

		// Click handler for function pills to update example
		__kustoExprHelpTooltipEl.addEventListener('click', function(e: any) {
			// Handle inject button click
			const injectBtn = (e.target as any).closest('.kusto-transform-expr-help-inject-btn');
			if (injectBtn) {
				const exampleEl = __kustoExprHelpTooltipEl.querySelector('.kusto-transform-expr-help-example-text');
				if (exampleEl && __kustoExprHelpActiveTextarea) {
					const text = exampleEl.textContent;
					const textarea = __kustoExprHelpActiveTextarea;
					const start = textarea.selectionStart;
					const end = textarea.selectionEnd;
					const before = textarea.value.substring(0, start);
					const after = textarea.value.substring(end);
					textarea.value = before + text + after;
					// Position cursor after inserted text
					const newPos = start + text.length;
					textarea.setSelectionRange(newPos, newPos);
					// Trigger input event so the change is registered
					textarea.dispatchEvent(new Event('input', { bubbles: true }));
					// Focus the textarea and hide tooltip
					textarea.focus();
					__kustoHideExpressionHelpTooltipImmediate();
				}
				return;
			}

			// Handle function pill click
			const code = (e.target as any).closest('code[data-ex]');
			if (code) {
				const example = code.getAttribute('data-ex');
				const exampleEl = __kustoExprHelpTooltipEl.querySelector('.kusto-transform-expr-help-example-text');
				if (exampleEl && example) {
					exampleEl.textContent = example;
					// Brief highlight animation
					exampleEl.classList.remove('kusto-transform-expr-help-example-flash');
					void exampleEl.offsetWidth; // Force reflow
					exampleEl.classList.add('kusto-transform-expr-help-example-flash');
				}
			}
		});
	}

	// Position the tooltip - NEVER cover the textarea
	// Priority: 1) Below if enough space, 2) Above if enough space, 3) Constrain height to fit
	const rect = textareaEl.getBoundingClientRect();
	const tooltipWidth = 340;
	const gap = 6; // space between textarea and tooltip
	const minTooltipHeight = 150; // minimum usable height before it gets too cramped
	const edgePadding = 10; // padding from viewport edges

	// First, make tooltip visible but off-screen to measure its natural height
	__kustoExprHelpTooltipEl.style.left = '-9999px';
	__kustoExprHelpTooltipEl.style.top = '-9999px';
	__kustoExprHelpTooltipEl.style.maxHeight = '';
	__kustoExprHelpTooltipEl.style.overflowY = '';
	__kustoExprHelpTooltipEl.classList.add('is-visible');
	const tooltipNaturalHeight = __kustoExprHelpTooltipEl.offsetHeight;

	// Calculate horizontal position
	let left = rect.left;
	if (left + tooltipWidth > window.innerWidth - edgePadding) {
		left = window.innerWidth - tooltipWidth - edgePadding;
	}
	if (left < edgePadding) left = edgePadding;

	// Calculate available space above and below the textarea
	const spaceBelow = window.innerHeight - rect.bottom - gap - edgePadding;
	const spaceAbove = rect.top - gap - edgePadding;

	let top;
	let constrainedHeight = null;

	if (spaceBelow >= tooltipNaturalHeight) {
		// Plenty of space below - use it at natural height
		top = rect.bottom + gap;
	} else if (spaceAbove >= tooltipNaturalHeight) {
		// Plenty of space above - use it at natural height
		top = rect.top - gap - tooltipNaturalHeight;
	} else if (spaceBelow >= spaceAbove && spaceBelow >= minTooltipHeight) {
		// More space below, constrain height to fit
		top = rect.bottom + gap;
		constrainedHeight = spaceBelow;
	} else if (spaceAbove >= minTooltipHeight) {
		// More space above (or below is too small), constrain height to fit
		constrainedHeight = spaceAbove;
		top = rect.top - gap - constrainedHeight;
	} else {
		// Extreme case: neither direction has minimum space
		// Pick the larger one and use what we can
		if (spaceBelow >= spaceAbove) {
			top = rect.bottom + gap;
			constrainedHeight = Math.max(spaceBelow, 100);
		} else {
			constrainedHeight = Math.max(spaceAbove, 100);
			top = rect.top - gap - constrainedHeight;
		}
	}

	// Apply final positioning and height constraint
	__kustoExprHelpTooltipEl.style.left = left + 'px';
	__kustoExprHelpTooltipEl.style.top = top + 'px';
	if (constrainedHeight !== null) {
		__kustoExprHelpTooltipEl.style.maxHeight = constrainedHeight + 'px';
		__kustoExprHelpTooltipEl.style.overflowY = 'auto';
	} else {
		__kustoExprHelpTooltipEl.style.maxHeight = '';
		__kustoExprHelpTooltipEl.style.overflowY = '';
	}
	// Tooltip is already visible from measurement step
}

function __kustoHideExpressionHelpTooltip() {
	// Delay hiding slightly so user can move mouse to tooltip
	if (__kustoExprHelpTooltipTimer) {
		clearTimeout(__kustoExprHelpTooltipTimer);
	}
	__kustoExprHelpTooltipTimer = setTimeout(function() {
		if (__kustoExprHelpTooltipEl) {
			__kustoExprHelpTooltipEl.classList.remove('is-visible');
		}
		__kustoExprHelpTooltipTimer = null;
	}, 150);
}

function __kustoHideExpressionHelpTooltipImmediate() {
	// Hide immediately when user clicks/focuses on input
	if (__kustoExprHelpTooltipTimer) {
		clearTimeout(__kustoExprHelpTooltipTimer);
		__kustoExprHelpTooltipTimer = null;
	}
	if (__kustoExprHelpTooltipEl) {
		__kustoExprHelpTooltipEl.classList.remove('is-visible');
	}
}

function __kustoGetTransformationState( boxId: any) {
	try {
		const id = String(boxId || '');
		if (!id) return { mode: 'edit', expanded: true };
		if (!transformationStateByBoxId || typeof transformationStateByBoxId !== 'object') {
			transformationStateByBoxId = {};
		}
		if (!transformationStateByBoxId[id] || typeof transformationStateByBoxId[id] !== 'object') {
			transformationStateByBoxId[id] = {
				mode: 'edit',
				expanded: true,
				dataSourceId: '',
				transformationType: 'derive',
				// Calculated columns (derive)
				deriveColumns: [{ name: '', expression: '' }],
				// Back-compat: older code paths may still set single-field derive.
				deriveColumnName: '',
				deriveExpression: '',
				// Distinct
				distinctColumn: '',
				groupByColumns: [],
				aggregations: [{ function: 'count', column: '' }],
				pivotRowKeyColumn: '',
				pivotColumnKeyColumn: '',
				pivotValueColumn: '',
				pivotAggregation: 'sum',
				pivotMaxColumns: 100
			};
		}
		// Back-compat migration: if we have a legacy single derive field but no deriveColumns.
		try {
			const st = transformationStateByBoxId[id];
			if (!Array.isArray(st.deriveColumns) || st.deriveColumns.length === 0) {
				const n = (typeof st.deriveColumnName === 'string') ? st.deriveColumnName : '';
				const e = (typeof st.deriveExpression === 'string') ? st.deriveExpression : '';
				st.deriveColumns = [{ name: n || '', expression: e || '' }];
			}
		} catch { /* ignore */ }
		return transformationStateByBoxId[id];
	} catch {
		return { mode: 'edit', expanded: true };
	}
}

/**
 * Computes the minimum resize height for a Transformation section wrapper.
 * Accounts for: controls panel height (in Edit mode) + results area min-height.
 * @param {string} boxId - The transformation box ID
 * @returns {number} Minimum height in pixels
 */
function __kustoGetTransformationMinResizeHeight( boxId: any) {
	const RESULTS_MIN_HEIGHT = 80; // Minimum height for results table
	const CONTROLS_MARGIN_BOTTOM = 20; // CSS margin-bottom on .kusto-chart-controls
	const FALLBACK_MIN = 80;
	try {
		const id = String(boxId || '');
		if (!id) return FALLBACK_MIN;
		const st = __kustoGetTransformationState(id);
		const isEditMode = st.mode === 'edit';
		
		// In preview mode, we only need space for the results area
		if (!isEditMode) {
			return RESULTS_MIN_HEIGHT;
		}
		
		// In edit mode, account for the controls panel height
		const controlsEl = document.getElementById(id + '_tf_controls') as any;
		const controlsH = controlsEl && controlsEl.getBoundingClientRect
			? Math.ceil(controlsEl.getBoundingClientRect().height || 0)
			: 0;
		
		// Min = controls height + margin-bottom (not captured by getBoundingClientRect) + results min-height
		return Math.max(FALLBACK_MIN, controlsH + CONTROLS_MARGIN_BOTTOM + RESULTS_MIN_HEIGHT);
	} catch {
		return FALLBACK_MIN;
	}
}

function __kustoUpdateTransformationModeButtons( boxId: any) {
	try {
		const st = transformationStateByBoxId && transformationStateByBoxId[boxId] ? transformationStateByBoxId[boxId] : null;
		const mode = st && st.mode ? String(st.mode) : 'edit';
		const editBtn = document.getElementById(boxId + '_tf_mode_edit') as any;
		const prevBtn = document.getElementById(boxId + '_tf_mode_preview') as any;
		if (editBtn) {
			editBtn.classList.toggle('is-active', mode === 'edit');
			editBtn.setAttribute('aria-selected', mode === 'edit' ? 'true' : 'false');
		}
		if (prevBtn) {
			prevBtn.classList.toggle('is-active', mode === 'preview');
			prevBtn.setAttribute('aria-selected', mode === 'preview' ? 'true' : 'false');
		}
		// Update dropdown text
		const dropdownText = document.getElementById(boxId + '_tf_mode_dropdown_text') as any;
		if (dropdownText) {
			dropdownText.textContent = mode === 'preview' ? 'Preview' : 'Edit';
		}
	} catch {
		// ignore
	}
}

function __kustoApplyTransformationMode( boxId: any) {
	try {
		const st = transformationStateByBoxId && transformationStateByBoxId[boxId] ? transformationStateByBoxId[boxId] : null;
		const mode = st && st.mode ? String(st.mode) : 'edit';
		try {
			const boxEl = document.getElementById(boxId) as any;
			if (boxEl) {
				boxEl.classList.toggle('is-preview', mode === 'preview');
				boxEl.classList.toggle('is-edit', mode === 'edit');
			}
		} catch { /* ignore */ }
		const controlsHost = document.getElementById(boxId + '_tf_controls') as any;
		if (controlsHost) controlsHost.style.display = (mode === 'edit') ? '' : 'none';
		__kustoUpdateTransformationModeButtons(boxId);
		try { __kustoRenderTransformation(boxId); } catch { /* ignore */ }
	} catch {
		// ignore
	}
}

function __kustoSetTransformationMode( boxId: any, mode: any) {
	const id = String(boxId || '');
	const m = String(mode || '').toLowerCase();
	if (!id) return;
	if (m !== 'edit' && m !== 'preview') return;
	const st = __kustoGetTransformationState(id);
	st.mode = m;
	try { __kustoApplyTransformationMode(id); } catch { /* ignore */ }
	try {
		if (m === 'preview') {
			const w = document.getElementById(id + '_tf_wrapper') as any;
			if (w) {
				w.dataset.kustoAutoFitActive = 'true';
				w.dataset.kustoAutoFitAllowShrink = 'true';
				// Force layout so measurements reflect the new mode.
				try {
					const resultsWrapper = document.getElementById(id + '_results_wrapper') as any;
					if (resultsWrapper) void resultsWrapper.offsetHeight;
					const controlsHost = document.getElementById(id + '_tf_controls') as any;
					if (controlsHost) void controlsHost.offsetHeight;
				} catch { /* ignore */ }
				try { __kustoMaybeAutoFitTransformationBox(id); } catch { /* ignore */ }
			}
		}
	} catch { /* ignore */ }
	try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
}

function __kustoUpdateTransformationVisibilityToggleButton( boxId: any) {
	try {
		const btn = document.getElementById(boxId + '_tf_toggle') as any;
		const st = transformationStateByBoxId && transformationStateByBoxId[boxId] ? transformationStateByBoxId[boxId] : null;
		if (!btn) return;
		const expanded = !!(st ? st.expanded : true);
		btn.classList.toggle('is-active', expanded);
		btn.setAttribute('aria-selected', expanded ? 'true' : 'false');
		btn.title = expanded ? 'Hide' : 'Show';
		btn.setAttribute('aria-label', expanded ? 'Hide' : 'Show');
	} catch {
		// ignore
	}
}

function __kustoApplyTransformationBoxVisibility( boxId: any) {
	try {
		const st = transformationStateByBoxId && transformationStateByBoxId[boxId] ? transformationStateByBoxId[boxId] : null;
		const expanded = !!(st ? st.expanded : true);
		const wrapper = document.getElementById(boxId + '_tf_wrapper') as any;
		if (wrapper) {
			wrapper.style.display = expanded ? '' : 'none';
		}
		// Hide/show Edit and Preview buttons, the divider, and max button when minimized
		const editBtn = document.getElementById(boxId + '_tf_mode_edit') as any;
		const previewBtn = document.getElementById(boxId + '_tf_mode_preview') as any;
		const divider = document.getElementById(boxId + '_tf_mode_divider') as any;
		const maxBtn = document.getElementById(boxId + '_tf_max') as any;
		if (editBtn) editBtn.style.display = expanded ? '' : 'none';
		if (previewBtn) previewBtn.style.display = expanded ? '' : 'none';
		if (divider) divider.style.display = expanded ? '' : 'none';
		if (maxBtn) maxBtn.style.display = expanded ? '' : 'none';
		__kustoUpdateTransformationVisibilityToggleButton(boxId);
		if (expanded) {
			try { __kustoRenderTransformation(boxId); } catch { /* ignore */ }
		}
	} catch {
		// ignore
	}
}

function toggleTransformationBoxVisibility( boxId: any) {
	const id = String(boxId || '');
	if (!id) return;
	const st = __kustoGetTransformationState(id);
	st.expanded = !st.expanded;
	try { __kustoApplyTransformationBoxVisibility(id); } catch { /* ignore */ }
	try { __kustoRenderTransformation(id); } catch { /* ignore */ }
	try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
}

function __kustoMaximizeTransformationBox( boxId: any) {
	try {
		const wrapper = document.getElementById(boxId + '_tf_wrapper') as any;
		if (!wrapper) return;
		const desired = __kustoComputeTransformationFitHeightPx(boxId);
		if (!desired) return;
		wrapper.style.height = desired + 'px';
		try { wrapper.dataset.kustoUserResized = 'true'; } catch { /* ignore */ }
		try { wrapper.dataset.kustoAutoFitActive = 'true'; } catch { /* ignore */ }
		try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
	} catch {
		// ignore
	}
}

function __kustoComputeTransformationFitHeightPx( boxId: any) {
	try {
		const id = String(boxId || '');
		if (!id) return null;
		const activeHost = document.getElementById(id + '_tf_editor') as any;
		if (!activeHost) return null;
		let desired = 0;
		try {
			// The transformation editor is a flex layout; scrollHeight tends to match current height.
			// Measure controls + results content (like query boxes) so Fit-to-contents doesn't leave gaps.
			const resultsWrapper = document.getElementById(id + '_results_wrapper') as any;
			const resultsEl = document.getElementById(id + '_results') as any;
			let resultsWrapperMargins = 0;
			let resultsWrapperBoxExtra = 0;
			try {
				if (resultsWrapper && window.getComputedStyle) {
					const rsw = window.getComputedStyle(resultsWrapper);
					const mt = parseFloat(rsw.marginTop || '0') || 0;
					const mb = parseFloat(rsw.marginBottom || '0') || 0;
					resultsWrapperMargins = mt + mb;
					resultsWrapperBoxExtra += (parseFloat(rsw.paddingTop || '0') || 0) + (parseFloat(rsw.paddingBottom || '0') || 0);
					resultsWrapperBoxExtra += (parseFloat(rsw.borderTopWidth || '0') || 0) + (parseFloat(rsw.borderBottomWidth || '0') || 0);
				}
			} catch { /* ignore */ }

			const addVisibleRectHeight = (el: any) => {
				try {
					if (!el) return 0;
					try {
						const cs = getComputedStyle(el);
						if (cs && cs.display === 'none') return 0;
						const h = (el.getBoundingClientRect ? (el.getBoundingClientRect().height || 0) : 0);
						let margin = 0;
						try {
							margin += parseFloat(cs.marginTop || '0') || 0;
							margin += parseFloat(cs.marginBottom || '0') || 0;
						} catch { /* ignore */ }
						return Math.max(0, Math.ceil(h + margin));
					} catch { /* ignore */ }
					const h = (el.getBoundingClientRect ? (el.getBoundingClientRect().height || 0) : 0);
					return Math.max(0, Math.ceil(h));
				} catch {
					return 0;
				}
			};

			const controlsH = (() => {
				try {
					let h = 0;
					const stopEl = (resultsWrapper && resultsWrapper.parentElement === activeHost) ? resultsWrapper : null;
					for (const child of Array.from(activeHost.children || []) as any[]) {
						if (stopEl && child === stopEl) break;
						h += addVisibleRectHeight(child);
					}
					try {
						const cse = getComputedStyle(activeHost);
						h += (parseFloat(cse.paddingTop || '0') || 0) + (parseFloat(cse.paddingBottom || '0') || 0);
						h += (parseFloat(cse.borderTopWidth || '0') || 0) + (parseFloat(cse.borderBottomWidth || '0') || 0);
					} catch { /* ignore */ }
					return Math.max(0, Math.ceil(h));
				} catch {
					return 0;
				}
			})();

			let resultsContentH = 0;
			let hasTable = false;
			let tableSlackPx = 0;
			try {
				if (resultsEl) {
					try {
						const csr = getComputedStyle(resultsEl);
						resultsContentH += (parseFloat(csr.paddingTop || '0') || 0) + (parseFloat(csr.paddingBottom || '0') || 0);
						resultsContentH += (parseFloat(csr.borderTopWidth || '0') || 0) + (parseFloat(csr.borderBottomWidth || '0') || 0);
					} catch { /* ignore */ }

					const headerEl = resultsEl.querySelector ? resultsEl.querySelector('.results-header') : null;
					resultsContentH += addVisibleRectHeight(headerEl);

					const bodyEl = resultsEl.querySelector ? resultsEl.querySelector('.results-body') : null;
					if (bodyEl) {
						try {
							const csb = getComputedStyle(bodyEl);
							resultsContentH += (parseFloat(csb.paddingTop || '0') || 0) + (parseFloat(csb.paddingBottom || '0') || 0);
							resultsContentH += (parseFloat(csb.borderTopWidth || '0') || 0) + (parseFloat(csb.borderBottomWidth || '0') || 0);
						} catch { /* ignore */ }

						const dataSearch = bodyEl.querySelector ? bodyEl.querySelector('.data-search') : null;
						const colSearch = bodyEl.querySelector ? bodyEl.querySelector('.column-search') : null;
						resultsContentH += addVisibleRectHeight(dataSearch);
						resultsContentH += addVisibleRectHeight(colSearch);

						const tableContainer = bodyEl.querySelector ? bodyEl.querySelector('.table-container') : null;
						if (tableContainer) {
							hasTable = true;
							let tableH = 0;
							try {
								const tableEl = tableContainer.querySelector ? tableContainer.querySelector('table') : null;
								if (tableEl) {
									// When the table only has a single data row, the rendered height can end up
									// ~1-2px taller than our measured heights (borders/collapsed border rounding).
									// Add a tiny slack to avoid clipping / a 1px scrollbar.
									try {
										let rowCount = 0;
										const tbody = (tableEl.tBodies && tableEl.tBodies.length) ? tableEl.tBodies[0] : null;
										if (tbody && tbody.rows) {
											rowCount = tbody.rows.length;
										} else if (tableEl.querySelectorAll) {
											rowCount = tableEl.querySelectorAll('tbody tr').length;
										}
										if (rowCount <= 1) {
											tableSlackPx = Math.max(tableSlackPx, 2);
										}
									} catch { /* ignore */ }

									const oh = (typeof tableEl.offsetHeight === 'number') ? tableEl.offsetHeight : 0;
									if (oh && Number.isFinite(oh)) tableH = Math.max(tableH, oh);
									const rh = (tableEl.getBoundingClientRect ? (tableEl.getBoundingClientRect().height || 0) : 0);
									if (rh && Number.isFinite(rh)) tableH = Math.max(tableH, rh);
								}
							} catch { /* ignore */ }
							if (!tableH) {
								try {
									const sh = (typeof tableContainer.scrollHeight === 'number') ? tableContainer.scrollHeight : 0;
									if (sh && Number.isFinite(sh)) tableH = Math.max(tableH, sh);
								} catch { /* ignore */ }
							}
							if (!tableH) {
								tableH = addVisibleRectHeight(tableContainer);
							}
							resultsContentH += Math.max(0, Math.ceil(tableH));
						} else {
							try {
								for (const child of Array.from(bodyEl.children || []) as any[]) {
									resultsContentH += addVisibleRectHeight(child);
								}
							} catch { /* ignore */ }
						}
					} else {
						try {
							for (const child of Array.from(resultsEl.children || []) as any[]) {
								resultsContentH += addVisibleRectHeight(child);
							}
						} catch { /* ignore */ }
					}
				}
			} catch { /* ignore */ }

			const extraPad = hasTable ? 38 : 18;
			desired = Math.ceil(Math.max(0, controlsH) + resultsWrapperMargins + resultsWrapperBoxExtra + Math.max(0, resultsContentH) + extraPad + tableSlackPx);
		} catch { /* ignore */ }
		if (!desired || !Number.isFinite(desired)) {
			desired = Math.ceil(activeHost.scrollHeight + 19);
		}
		desired = Math.max(80, Math.min(900, desired));
		return desired;
	} catch {
		return null;
	}
}

function __kustoMaybeAutoFitTransformationBox( boxId: any) {
	try {
		const id = String(boxId || '');
		if (!id) return;
		const wrapper = document.getElementById(id + '_tf_wrapper') as any;
		if (!wrapper) return;
		const desired = __kustoComputeTransformationFitHeightPx(id);
		if (!desired) return;
		const current = wrapper.getBoundingClientRect().height;
		const active = String(wrapper.dataset.kustoAutoFitActive || '') === 'true';
		const allowShrink = String(wrapper.dataset.kustoAutoFitAllowShrink || '') === 'true';
		// If the user has the section at least "fit" size, keep auto-fit active.
		if (!active && current >= desired - 2) {
			try { wrapper.dataset.kustoAutoFitActive = 'true'; } catch { /* ignore */ }
		}
		const nowActive = String(wrapper.dataset.kustoAutoFitActive || '') === 'true';
		if (!nowActive) return;
		// Default is grow-only to avoid jitter while editing; allowShrink is a one-shot override.
		if (desired > current + 2 || (allowShrink && desired < current - 2)) {
			wrapper.style.height = desired + 'px';
			try { wrapper.dataset.kustoUserResized = 'true'; } catch { /* ignore */ }
			try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
		}
		if (allowShrink) {
			try { delete wrapper.dataset.kustoAutoFitAllowShrink; } catch { /* ignore */ }
		}
	} catch { /* ignore */ }
}

function removeTransformationBox( boxId: any) {
	const id = String(boxId || '');
	if (!id) return;
	try { __kustoCleanupSectionModeResizeObserver(id); } catch { /* ignore */ }
	try {
		const el = document.getElementById(id) as any;
		if (el && el.parentElement) {
			el.parentElement.removeChild(el);
		}
	} catch { /* ignore */ }
	try {
		transformationBoxes = Array.isArray(transformationBoxes) ? transformationBoxes.filter((x: any) => x !== id) : [];
	} catch { /* ignore */ }
	try {
		if (transformationStateByBoxId && typeof transformationStateByBoxId === 'object') {
			delete transformationStateByBoxId[id];
		}
	} catch { /* ignore */ }
	try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
}

function __kustoSetTransformationType( boxId: any, type: any) {
	const id = String(boxId || '');
	const t = String(type || '').toLowerCase();
	if (!id) return;
	if (!(t in __kustoTransformationTypeLabels)) return;
	const st = __kustoGetTransformationState(id);
	st.transformationType = t;
	try { __kustoUpdateTransformationBuilderUI(id); } catch { /* ignore */ }
	try { __kustoRenderTransformation(id); } catch { /* ignore */ }
	// Changing transformation types can significantly change the controls height.
	// If the section is in auto-fit mode (Fit to contents), re-measure after the DOM updates.
	try {
		const runFit = () => {
			try {
				const w = document.getElementById(id + '_tf_wrapper') as any;
				if (!w) return;
				const active = String(w.dataset.kustoAutoFitActive || '') === 'true';
				const userResized = String(w.dataset.kustoUserResized || '') === 'true';
				// If auto-fit is active, allow a one-shot shrink/grow. If the user hasn't resized,
				// keep it fitting as the UI changes.
				if (active || !userResized) {
					w.dataset.kustoAutoFitActive = 'true';
					w.dataset.kustoAutoFitAllowShrink = 'true';
					// Force layout so measurements reflect the new type's control visibility.
					try {
						const resultsWrapper = document.getElementById(id + '_results_wrapper') as any;
						if (resultsWrapper) void resultsWrapper.offsetHeight;
						const controlsHost = document.getElementById(id + '_tf_controls') as any;
						if (controlsHost) void controlsHost.offsetHeight;
					} catch { /* ignore */ }
					try { __kustoMaybeAutoFitTransformationBox(id); } catch { /* ignore */ }
				}
			} catch { /* ignore */ }
		};
		setTimeout(runFit, 0);
		setTimeout(runFit, 80);
	} catch { /* ignore */ }
	try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
}

function __kustoOnTransformationDataSourceChanged( boxId: any) {
	const id = String(boxId || '');
	if (!id) return;
	try {
		const sel = document.getElementById(id + '_tf_ds') as any;
		const st = __kustoGetTransformationState(id);
		st.dataSourceId = sel ? String(sel.value || '') : '';
	} catch { /* ignore */ }
	try { __kustoUpdateTransformationBuilderUI(id); } catch { /* ignore */ }
	try { __kustoRenderTransformation(id); } catch { /* ignore */ }
	try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
}

function __kustoSetCheckboxDropdownText( btnTextEl: any, selectedValues: any) {
	try {
		if (!btnTextEl) return;
		const vals = Array.isArray(selectedValues) ? selectedValues.filter((v: any) => v) : [];
		if (!vals.length) {
			btnTextEl.textContent = '(none)';
			try { btnTextEl.title = '(none)'; } catch { /* ignore */ }
			return;
		}

		const all = vals.map((v: any) => String(v)).filter((v: any) => v).join(', ');
		btnTextEl.textContent = all;
		try { btnTextEl.title = all; } catch { /* ignore */ }

		// If it doesn't fit, include as many values as will fit and add an ellipsis.
		try {
			const fits = () => {
				try {
					const cw = btnTextEl.clientWidth || 0;
					const sw = btnTextEl.scrollWidth || 0;
					return cw <= 0 || sw <= cw + 1;
				} catch {
					return true;
				}
			};

			if (fits()) return;

			let shown = '';
			for (let i = 0; i < vals.length; i++) {
				const next = String(vals[i] || '');
				if (!next) continue;
				const candidateBase = shown ? (shown + ', ' + next) : next;
				const hasMore = i < vals.length - 1;
				const candidate = hasMore ? (candidateBase + '…') : candidateBase;
				btnTextEl.textContent = candidate;
				if (fits()) {
					shown = candidateBase;
					continue;
				}
				// If adding this one doesn't fit, revert and keep current.
				btnTextEl.textContent = shown ? (shown + '…') : (next + '…');
				break;
			}
		} catch { /* ignore */ }
	} catch { /* ignore */ }
}

function __kustoBuildCheckboxMenuHtml( boxId: any, options: any, selectedSet: any) {
	let html = '';
	for (const opt of options) {
		const v = String(opt || '');
		if (!v) continue;
		const checked = selectedSet && selectedSet.has(v);
		const esc = (typeof _win.escapeHtml === 'function') ? _win.escapeHtml(v) : v;
		const js = String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
		html +=
			'<div class="kusto-checkbox-item" role="option" aria-selected="' + (checked ? 'true' : 'false') + '" onclick="try{__kustoToggleGroupByColumn(\'' + String(boxId).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + '\',\'' + js + '\')}catch{}">' +
			'<input type="checkbox" ' + (checked ? 'checked' : '') + ' tabindex="-1" />' +
			'<span>' + esc + '</span>' +
			'</div>';
	}
	if (!html) {
		html = '<div class="kusto-checkbox-item" style="opacity:0.7">(no columns)</div>';
	}
	return html;
}

function __kustoToggleGroupByColumn( boxId: any, columnName: any) {
	const id = String(boxId || '');
	const col = String(columnName || '');
	if (!id || !col) return;
	const st = __kustoGetTransformationState(id);
	if (!Array.isArray(st.groupByColumns)) st.groupByColumns = [];
	const set = new Set(st.groupByColumns.map((c: any) => String(c)));
	if (set.has(col)) set.delete(col); else set.add(col);
	st.groupByColumns = Array.from(set);
	try { __kustoUpdateTransformationBuilderUI(id); } catch { /* ignore */ }
	try { __kustoRenderTransformation(id); } catch { /* ignore */ }
	try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
}

function __kustoUpdateTransformationBuilderUI( boxId: any) {
	const id = String(boxId || '');
	if (!id) return;

	// Lit elements handle their own UI — skip legacy DOM updates.
	try {
		const el = document.getElementById(id) as any;
		if (el && typeof el.refresh === 'function') return;
	} catch { /* ignore */ }

	const st = __kustoGetTransformationState(id);

	// Type picker
	try {
		const picker = document.getElementById(id + '_tf_type_picker') as any;
		if (picker) {
			const btns = picker.querySelectorAll('button[data-type]');
			for (const b of btns) {
				try {
					const t = String(b.getAttribute('data-type') || '');
					b.classList.toggle('is-active', t && t === String(st.transformationType || ''));
				} catch { /* ignore */ }
			}
		}
	} catch { /* ignore */ }

	// Data source dropdown
	const datasets = __kustoGetChartDatasetsInDomOrder();
	const dsSelect = document.getElementById(id + '_tf_ds') as any;
	try {
		if (dsSelect) {
			const labelMap: any = {};
			const values = datasets.map((d: any) => {
				labelMap[d.id] = d.label;
				return d.id;
			});
			__kustoSetSelectOptions(dsSelect, values, String(st.dataSourceId || ''), labelMap);
			try {
				const txt = document.getElementById(id + '_tf_ds_text') as any;
				if (txt) {
					const selected = String(dsSelect.value || '');
					txt.textContent = (selected && labelMap[selected]) ? labelMap[selected] : (selected || '(select)');
				}
			} catch { /* ignore */ }
		}
	} catch { /* ignore */ }

	// Config sections
	try {
		const deriveHost = document.getElementById(id + '_tf_cfg_derive') as any;
		const sumHost = document.getElementById(id + '_tf_cfg_summarize') as any;
		const distinctHost = document.getElementById(id + '_tf_cfg_distinct') as any;
		const pivotHost = document.getElementById(id + '_tf_cfg_pivot') as any;
		if (deriveHost) deriveHost.style.display = (st.transformationType === 'derive') ? '' : 'none';
		if (sumHost) sumHost.style.display = (st.transformationType === 'summarize') ? '' : 'none';
		if (distinctHost) distinctHost.style.display = (st.transformationType === 'distinct') ? '' : 'none';
		if (pivotHost) pivotHost.style.display = (st.transformationType === 'pivot') ? '' : 'none';
	} catch { /* ignore */ }

	// Column-dependent controls
	const ds = datasets.find((d: any) => String(d.id) === String(st.dataSourceId || ''));
	const colNames = ds ? (ds.columns || []).map(__kustoNormalizeResultsColumnName).filter((c: any) => c) : [];

	// Derive
	try {
		const host = document.getElementById(id + '_tf_derive_rows') as any;
		if (host) {
			// Ensure deriveColumns exists
			if (!Array.isArray(st.deriveColumns) || st.deriveColumns.length === 0) {
				st.deriveColumns = [{ name: '', expression: '' }];
			}
			let html = '';
			for (let i = 0; i < st.deriveColumns.length; i++) {
				const row = st.deriveColumns[i] || {};
				const name = String(row.name || '');
				const expr = String(row.expression || '');
				const escName = (typeof _win.escapeHtml === 'function') ? _win.escapeHtml(name) : name;
				const escExpr = (typeof _win.escapeHtml === 'function') ? _win.escapeHtml(expr) : expr;
				const nameInputId = id + '_tf_derive_name_' + i;
				const exprInputId = id + '_tf_derive_expr_' + i;
				html +=
					'<div class="kusto-transform-derive-row" data-kusto-no-editor-focus="true" ondragover="try{__kustoOnDeriveDragOver(\'' + id + '\',' + i + ', event)}catch{}" ondrop="try{__kustoOnDeriveDrop(\'' + id + '\',' + i + ', event)}catch{}">' +
						'<input id="' + nameInputId + '" type="text" class="kusto-transform-input kusto-transform-derive-name" value="' + escName + '" placeholder="Column name" aria-label="New column name" oninput="try{__kustoOnCalculatedColumnChanged(\'' + id + '\',' + i + ',\'name\', this.value)}catch{}" />' +
						'<span class="kusto-transform-derive-eq" aria-hidden="true">=</span>' +
						'<textarea id="' + exprInputId + '" class="kusto-transform-textarea kusto-transform-derive-expr" rows="1" placeholder="Expression (e.g. [Amount] * 1.2)" aria-label="Expression" oninput="try{__kustoOnCalculatedColumnChanged(\'' + id + '\',' + i + ',\'expression\', this.value)}catch{}" onmouseenter="__kustoShowExpressionHelpTooltip(this, event)" onmouseleave="__kustoHideExpressionHelpTooltip()" onfocus="__kustoHideExpressionHelpTooltipImmediate()">' + escExpr + '</textarea>' +
						'<div class="kusto-transform-derive-row-actions" data-kusto-no-editor-focus="true">' +
							'<button type="button" class="unified-btn-secondary unified-btn-icon-only kusto-transform-mini-btn" onclick="try{__kustoAddCalculatedColumn(\'' + id + '\',' + i + ')}catch{}" title="Add column" aria-label="Add column">' + __kustoTransformMiniPlusIconSvg + '</button>' +
							'<button type="button" class="unified-btn-secondary unified-btn-icon-only kusto-transform-mini-btn" onclick="try{__kustoRemoveCalculatedColumn(\'' + id + '\',' + i + ')}catch{}" ' + (st.deriveColumns.length <= 1 ? 'disabled' : '') + ' title="Remove column" aria-label="Remove column">' + __kustoTransformMiniTrashIconSvg + '</button>' +
							'<button type="button" class="section-drag-handle kusto-transform-derive-drag-handle" draggable="true" title="Drag to reorder" aria-label="Reorder column" ondragstart="try{__kustoOnDeriveDragStart(\'' + id + '\',' + i + ', event)}catch{}" ondragend="try{__kustoOnDeriveDragEnd(\'' + id + '\', event)}catch{}"><span class="section-drag-handle-glyph" aria-hidden="true">⋮</span></button>' +
						'</div>' +
					'</div>';
			}
			host.innerHTML = html;
		}
	} catch { /* ignore */ }

	// Summarize: group-by rows (multiple columns with add/remove)
	try {
		const host = document.getElementById(id + '_tf_groupby_rows') as any;
		if (host) {
			if (!Array.isArray(st.groupByColumns) || st.groupByColumns.length === 0) {
				st.groupByColumns = [''];
			}
			const groupByCols = Array.isArray(st.groupByColumns) ? st.groupByColumns : [''];
			let html = '';
			for (let i = 0; i < groupByCols.length; i++) {
				const col = String(groupByCols[i] || '');
				const selectId = id + '_tf_groupby_col_' + i;
				html +=
					'<div class="kusto-transform-groupby-row" data-kusto-no-editor-focus="true" ondragover="try{__kustoOnGroupByDragOver(\'' + id + '\',' + i + ', event)}catch{}" ondrop="try{__kustoOnGroupByDrop(\'' + id + '\',' + i + ', event)}catch{}">' +
						'<select id="' + selectId + '" class="kusto-transform-select kusto-transform-groupby-select" onchange="try{__kustoOnGroupByColumnChanged(\'' + id + '\',' + i + ', this.value)}catch{}">' +
							'<option value=""' + (col ? '' : ' selected') + '>(select column)</option>';
				for (const c of colNames) {
					const esc = (typeof _win.escapeHtml === 'function') ? _win.escapeHtml(c) : c;
					html += '<option value="' + esc + '"' + (c === col ? ' selected' : '') + '>' + esc + '</option>';
				}
				html +=
						'</select>' +
						'<div class="kusto-transform-groupby-row-actions" data-kusto-no-editor-focus="true">' +
							'<button type="button" class="unified-btn-secondary unified-btn-icon-only kusto-transform-mini-btn" onclick="try{__kustoAddGroupByColumn(\'' + id + '\',' + i + ')}catch{}" title="Add group-by column" aria-label="Add group-by column">' + __kustoTransformMiniPlusIconSvg + '</button>' +
							'<button type="button" class="unified-btn-secondary unified-btn-icon-only kusto-transform-mini-btn" onclick="try{__kustoRemoveGroupByColumn(\'' + id + '\',' + i + ')}catch{}" ' + (groupByCols.length <= 1 ? 'disabled' : '') + ' title="Remove group-by column" aria-label="Remove group-by column">' + __kustoTransformMiniTrashIconSvg + '</button>' +
							'<button type="button" class="section-drag-handle kusto-transform-groupby-drag-handle" draggable="true" title="Drag to reorder" aria-label="Reorder group-by column" ondragstart="try{__kustoOnGroupByDragStart(\'' + id + '\',' + i + ', event)}catch{}" ondragend="try{__kustoOnGroupByDragEnd(\'' + id + '\', event)}catch{}"><span class="section-drag-handle-glyph" aria-hidden="true">⋮</span></button>' +
						'</div>' +
					'</div>';
			}
			host.innerHTML = html;
		}
	} catch { /* ignore */ }

	// Summarize: aggregations list
	try {
		const host = document.getElementById(id + '_tf_aggs') as any;
		if (host) {
			if (!Array.isArray(st.aggregations) || st.aggregations.length === 0) {
				st.aggregations = [{ name: '', function: 'count', column: '' }];
			}
			const aggs = Array.isArray(st.aggregations) ? st.aggregations : [];
			let html = '';
			for (let i = 0; i < aggs.length; i++) {
				const a = aggs[i] || {};
				const nm = String(a.name || '');
				const fn = String(a.function || 'count');
				const col = String(a.column || '');
				const escName = (typeof _win.escapeHtml === 'function') ? _win.escapeHtml(nm) : nm;
				const fnSelectId = id + '_tf_agg_fn_' + i;
				const colSelectId = id + '_tf_agg_col_' + i;
				const nameInputId = id + '_tf_agg_name_' + i;
				html +=
					'<div class="kusto-transform-agg-row" data-kusto-no-editor-focus="true" ondragover="try{__kustoOnAggDragOver(\'' + id + '\',' + i + ', event)}catch{}" ondrop="try{__kustoOnAggDrop(\'' + id + '\',' + i + ', event)}catch{}">' +
					'<input id="' + nameInputId + '" type="text" class="kusto-transform-input kusto-transform-agg-name" value="' + escName + '" placeholder="Column name" aria-label="Output column name" oninput="try{__kustoOnTransformationAggChanged(\'' + id + '\',' + i + ', null, null, this.value)}catch{}" />' +
					'<span class="kusto-transform-agg-eq" aria-hidden="true">=</span>' +
					'<select id="' + fnSelectId + '" class="kusto-transform-select" onchange="try{__kustoOnTransformationAggChanged(\'' + id + '\',' + i + ', this.value, null)}catch{}">' +
						'<option value="count" ' + (fn === 'count' ? 'selected' : '') + '>count</option>' +
						'<option value="sum" ' + (fn === 'sum' ? 'selected' : '') + '>sum</option>' +
						'<option value="avg" ' + (fn === 'avg' ? 'selected' : '') + '>avg</option>' +
						'<option value="min" ' + (fn === 'min' ? 'selected' : '') + '>min</option>' +
						'<option value="max" ' + (fn === 'max' ? 'selected' : '') + '>max</option>' +
						'<option value="distinct" ' + (fn === 'distinct' ? 'selected' : '') + '>distinct</option>' +
					'</select>' +
					'<select id="' + colSelectId + '" class="kusto-transform-select" onchange="try{__kustoOnTransformationAggChanged(\'' + id + '\',' + i + ', null, this.value, null)}catch{}" ' + (fn === 'count' ? 'disabled' : '') + '>';
				html += '<option value=""' + (col ? '' : ' selected') + '>(select)</option>';
				for (const c of colNames) {
					const esc = (typeof _win.escapeHtml === 'function') ? _win.escapeHtml(c) : c;
					html += '<option value="' + esc + '"' + (c === col ? ' selected' : '') + '>' + esc + '</option>';
				}
				html +=
					'</select>' +
					'<div class="kusto-transform-agg-row-actions" data-kusto-no-editor-focus="true">' +
						'<button type="button" class="unified-btn-secondary unified-btn-icon-only kusto-transform-mini-btn" onclick="try{__kustoAddTransformationAgg(\'' + id + '\',' + i + ')}catch{}" title="Add aggregation" aria-label="Add aggregation">' + __kustoTransformMiniPlusIconSvg + '</button>' +
						'<button type="button" class="unified-btn-secondary unified-btn-icon-only kusto-transform-mini-btn" onclick="try{__kustoRemoveTransformationAgg(\'' + id + '\',' + i + ')}catch{}" ' + (aggs.length <= 1 ? 'disabled' : '') + ' title="Remove aggregation" aria-label="Remove aggregation">' + __kustoTransformMiniTrashIconSvg + '</button>' +
						'<button type="button" class="section-drag-handle kusto-transform-agg-drag-handle" draggable="true" title="Drag to reorder" aria-label="Reorder aggregation" ondragstart="try{__kustoOnAggDragStart(\'' + id + '\',' + i + ', event)}catch{}" ondragend="try{__kustoOnAggDragEnd(\'' + id + '\', event)}catch{}"><span class="section-drag-handle-glyph" aria-hidden="true">⋮</span></button>' +
					'</div>' +
					'</div>';
			}
			host.innerHTML = html;
		}
	} catch { /* ignore */ }

	// Pivot selects
	try {
		const rowSel = document.getElementById(id + '_tf_pivot_row') as any;
		const colSel = document.getElementById(id + '_tf_pivot_col') as any;
		const valSel = document.getElementById(id + '_tf_pivot_val') as any;
		if (rowSel) __kustoSetSelectOptions(rowSel, colNames, String(st.pivotRowKeyColumn || ''), null);
		if (colSel) __kustoSetSelectOptions(colSel, colNames, String(st.pivotColumnKeyColumn || ''), null);
		if (valSel) __kustoSetSelectOptions(valSel, colNames, String(st.pivotValueColumn || ''), null);
		const aggSel = document.getElementById(id + '_tf_pivot_agg') as any;
		if (aggSel && typeof st.pivotAggregation === 'string') aggSel.value = st.pivotAggregation;
		// Sync dropdown button text for custom dropdowns
		try {
			const rowTxt = document.getElementById(id + '_tf_pivot_row_text') as any;
			if (rowTxt && rowSel) rowTxt.textContent = String(rowSel.value || '') || '(select)';
			const colTxt = document.getElementById(id + '_tf_pivot_col_text') as any;
			if (colTxt && colSel) colTxt.textContent = String(colSel.value || '') || '(select)';
			const valTxt = document.getElementById(id + '_tf_pivot_val_text') as any;
			if (valTxt && valSel) valTxt.textContent = String(valSel.value || '') || '(select)';
			const aggTxt = document.getElementById(id + '_tf_pivot_agg_text') as any;
			if (aggTxt && aggSel) aggTxt.textContent = String(aggSel.value || '') || 'sum';
		} catch { /* ignore */ }
	} catch { /* ignore */ }

	// Distinct select
	try {
		const sel = document.getElementById(id + '_tf_distinct_col') as any;
		if (sel) {
			__kustoSetSelectOptions(sel, colNames, String(st.distinctColumn || ''), null);
			try {
				const txt = document.getElementById(id + '_tf_distinct_col_text') as any;
				if (txt) {
					const selected = String(sel.value || '');
					txt.textContent = selected || '(select)';
				}
			} catch { /* ignore */ }
		}
	} catch { /* ignore */ }

	// If the section is already fit-sized, keep content visible as UI grows.
	try {
		setTimeout(() => {
			try {
				const w = document.getElementById(id + '_tf_wrapper') as any;
				if (w && !(w.dataset && w.dataset.kustoUserResized === 'true')) {
					w.dataset.kustoAutoFitActive = 'true';
				}
			} catch { /* ignore */ }
			try { __kustoMaybeAutoFitTransformationBox(id); } catch { /* ignore */ }
		}, 0);
	} catch { /* ignore */ }
}

function __kustoOnTransformationDistinctChanged( boxId: any) {
	const id = String(boxId || '');
	if (!id) return;
	const st = __kustoGetTransformationState(id);
	try {
		st.distinctColumn = String(((document.getElementById(id + '_tf_distinct_col') as any || {}).value || ''));
	} catch { /* ignore */ }
	try { __kustoRenderTransformation(id); } catch { /* ignore */ }
	// When the distinct column changes, the results can vary significantly in content and width.
	// Allow the section to shrink/grow to fit the new contents.
	try {
		const runFit = () => {
			try {
				const w = document.getElementById(id + '_tf_wrapper') as any;
				if (!w) return;
				const userResized = String(w.dataset.kustoUserResized || '') === 'true';
				if (!userResized) {
					w.dataset.kustoAutoFitActive = 'true';
					w.dataset.kustoAutoFitAllowShrink = 'true';
				}
			} catch { /* ignore */ }
			try { __kustoMaybeAutoFitTransformationBox(id); } catch { /* ignore */ }
		};
		setTimeout(runFit, 0);
		setTimeout(runFit, 80);
	} catch { /* ignore */ }
	try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
}

function __kustoOnTransformationAggChanged( boxId: any, index: any, newFn: any, newCol: any, newName: any) {
	const id = String(boxId || '');
	const i = Number(index);
	if (!id || !Number.isFinite(i)) return;
	const st = __kustoGetTransformationState(id);
	if (!Array.isArray(st.aggregations)) st.aggregations = [];
	if (!st.aggregations[i]) st.aggregations[i] = { name: '', function: 'count', column: '' };
	const nameOnlyChange = (typeof newName === 'string') && (typeof newFn !== 'string') && (typeof newCol !== 'string');
	if (typeof newFn === 'string') st.aggregations[i].function = String(newFn);
	if (typeof newCol === 'string') st.aggregations[i].column = String(newCol);
	if (typeof newName === 'string') st.aggregations[i].name = String(newName);
	// If count: clear column
	try {
		if (String(st.aggregations[i].function || '') === 'count') {
			st.aggregations[i].column = '';
		}
	} catch { /* ignore */ }
	// IMPORTANT: Editing the aggregation name is a keystroke-heavy interaction.
	// Avoid rebuilding the summarize UI on every keypress (it steals focus).
	if (!nameOnlyChange) {
		try { __kustoUpdateTransformationBuilderUI(id); } catch { /* ignore */ }
		try { __kustoRenderTransformation(id); } catch { /* ignore */ }
		try {
			setTimeout(() => {
				try {
					const w = document.getElementById(id + '_tf_wrapper') as any;
					if (w && !(w.dataset && w.dataset.kustoUserResized === 'true')) {
						w.dataset.kustoAutoFitActive = 'true';
					}
				} catch { /* ignore */ }
				try { __kustoMaybeAutoFitTransformationBox(id); } catch { /* ignore */ }
			}, 0);
		} catch { /* ignore */ }
	}
	try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
}

function __kustoAddTransformationAgg( boxId: any) {
	const id = String(boxId || '');
	const insertAfterIndex = arguments.length >= 2 ? Number(arguments[1]) : NaN;
	if (!id) return;
	const st = __kustoGetTransformationState(id);
	if (!Array.isArray(st.aggregations) || st.aggregations.length === 0) st.aggregations = [{ name: '', function: 'count', column: '' }];
	let insertedIndex = st.aggregations.length;
	if (Number.isFinite(insertAfterIndex) && insertAfterIndex >= 0 && insertAfterIndex < st.aggregations.length) {
		insertedIndex = Math.floor(insertAfterIndex) + 1;
		st.aggregations.splice(insertedIndex, 0, { name: '', function: 'count', column: '' });
	} else {
		st.aggregations.push({ name: '', function: 'count', column: '' });
		insertedIndex = st.aggregations.length - 1;
	}
	try { __kustoUpdateTransformationBuilderUI(id); } catch { /* ignore */ }
	try { __kustoRenderTransformation(id); } catch { /* ignore */ }
	try {
		setTimeout(() => {
			try {
				const el = document.getElementById(id + '_tf_agg_name_' + insertedIndex) as any;
				if (el && typeof el.focus === 'function') el.focus();
			} catch { /* ignore */ }
			try {
				const w = document.getElementById(id + '_tf_wrapper') as any;
				if (w && !(w.dataset && w.dataset.kustoUserResized === 'true')) {
					w.dataset.kustoAutoFitActive = 'true';
				}
			} catch { /* ignore */ }
			try { __kustoMaybeAutoFitTransformationBox(id); } catch { /* ignore */ }
		}, 0);
	} catch { /* ignore */ }
	try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
}

function __kustoRemoveTransformationAgg( boxId: any, index: any) {
	const id = String(boxId || '');
	const i = Number(index);
	if (!id || !Number.isFinite(i)) return;
	const st = __kustoGetTransformationState(id);
	if (!Array.isArray(st.aggregations)) st.aggregations = [];
	if (st.aggregations.length <= 1) return;
	st.aggregations.splice(i, 1);
	try { __kustoUpdateTransformationBuilderUI(id); } catch { /* ignore */ }
	try { __kustoRenderTransformation(id); } catch { /* ignore */ }
	try {
		// When removing aggregations, shrink-to-fit (one-shot) if auto-fit is enabled.
		setTimeout(() => {
			try {
				const w = document.getElementById(id + '_tf_wrapper') as any;
				if (w) {
					w.dataset.kustoAutoFitActive = 'true';
					w.dataset.kustoAutoFitAllowShrink = 'true';
				}
			} catch { /* ignore */ }
			try { __kustoMaybeAutoFitTransformationBox(id); } catch { /* ignore */ }
		}, 0);
		setTimeout(() => {
			try {
				const w = document.getElementById(id + '_tf_wrapper') as any;
				if (w) {
					w.dataset.kustoAutoFitActive = 'true';
					w.dataset.kustoAutoFitAllowShrink = 'true';
				}
			} catch { /* ignore */ }
			try { __kustoMaybeAutoFitTransformationBox(id); } catch { /* ignore */ }
		}, 80);
	} catch { /* ignore */ }
	try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
}

// Group-by column handlers for Summarize
function __kustoOnGroupByColumnChanged( boxId: any, index: any, value: any) {
	const id = String(boxId || '');
	const i = Number(index);
	if (!id || !Number.isFinite(i)) return;
	const st = __kustoGetTransformationState(id);
	if (!Array.isArray(st.groupByColumns)) st.groupByColumns = [''];
	if (i >= 0 && i < st.groupByColumns.length) {
		st.groupByColumns[i] = String(value || '');
	}
	try { __kustoRenderTransformation(id); } catch { /* ignore */ }
	try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
}

function __kustoAddGroupByColumn( boxId: any, insertAfterIndex: any) {
	const id = String(boxId || '');
	if (!id) return;
	const st = __kustoGetTransformationState(id);
	if (!Array.isArray(st.groupByColumns) || st.groupByColumns.length === 0) st.groupByColumns = [''];
	let insertedIndex = st.groupByColumns.length;
	if (Number.isFinite(insertAfterIndex) && insertAfterIndex >= 0 && insertAfterIndex < st.groupByColumns.length) {
		insertedIndex = Math.floor(insertAfterIndex) + 1;
		st.groupByColumns.splice(insertedIndex, 0, '');
	} else {
		st.groupByColumns.push('');
		insertedIndex = st.groupByColumns.length - 1;
	}
	try { __kustoUpdateTransformationBuilderUI(id); } catch { /* ignore */ }
	try { __kustoRenderTransformation(id); } catch { /* ignore */ }
	try {
		setTimeout(() => {
			try {
				const el = document.getElementById(id + '_tf_groupby_col_' + insertedIndex) as any;
				if (el && typeof el.focus === 'function') el.focus();
			} catch { /* ignore */ }
			try { __kustoMaybeAutoFitTransformationBox(id); } catch { /* ignore */ }
		}, 0);
	} catch { /* ignore */ }
	try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
}

function __kustoRemoveGroupByColumn( boxId: any, index: any) {
	const id = String(boxId || '');
	const i = Number(index);
	if (!id || !Number.isFinite(i)) return;
	const st = __kustoGetTransformationState(id);
	if (!Array.isArray(st.groupByColumns)) st.groupByColumns = [''];
	if (st.groupByColumns.length <= 1) return;
	st.groupByColumns.splice(i, 1);
	try { __kustoUpdateTransformationBuilderUI(id); } catch { /* ignore */ }
	try { __kustoRenderTransformation(id); } catch { /* ignore */ }
	try {
		setTimeout(() => {
			try { __kustoMaybeAutoFitTransformationBox(id); } catch { /* ignore */ }
		}, 0);
	} catch { /* ignore */ }
	try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
}

// Group-by drag and drop handlers
function __kustoOnGroupByDragStart( boxId: any, index: any, event: any) {
	try {
		const id = String(boxId || '');
		const i = Number(index);
		if (!id || !Number.isFinite(i)) return;
		(window as any).__kustoGroupByDragState = { boxId: id, fromIndex: Math.floor(i), overIndex: null, insertAfter: false };
		try {
			const e = event;
			if (e && e.dataTransfer) {
				e.dataTransfer.effectAllowed = 'move';
				try { e.dataTransfer.setData('text/plain', 'kusto-groupby'); } catch { /* ignore */ }
			}
		} catch { /* ignore */ }
		try {
			const host = document.getElementById(id + '_tf_groupby_rows') as any;
			if (host) host.classList.add('is-dragging');
		} catch { /* ignore */ }
		try { __kustoClearGroupByDropIndicators(id); } catch { /* ignore */ }
	} catch { /* ignore */ }
}

function __kustoClearGroupByDropIndicators( boxId: any) {
	try {
		const id = String(boxId || '');
		const host = document.getElementById(id + '_tf_groupby_rows') as any;
		if (host) {
			host.querySelectorAll('.kusto-transform-groupby-row').forEach((r: any) => {
				r.classList.remove('is-drop-target', 'is-drop-before', 'is-drop-after');
			});
		}
	} catch { /* ignore */ }
}

function __kustoOnGroupByDragOver( boxId: any, index: any, event: any) {
	try {
		const e = event;
		const state = (window as any).__kustoGroupByDragState;
		if (!state || state.boxId !== boxId) return;
		if (e && typeof e.preventDefault === 'function') e.preventDefault();
		const id = String(boxId || '');
		const i = Number(index);
		if (!Number.isFinite(i)) return;
		__kustoClearGroupByDropIndicators(id);
		const row = (e.target as any).closest('.kusto-transform-groupby-row');
		if (!row) return;
		const rect = row.getBoundingClientRect();
		const midY = rect.top + rect.height / 2;
		const insertAfter = e.clientY > midY;
		state.overIndex = Math.floor(i);
		state.insertAfter = insertAfter;
		row.classList.add('is-drop-target');
		row.classList.add(insertAfter ? 'is-drop-after' : 'is-drop-before');
	} catch { /* ignore */ }
}

function __kustoOnGroupByDragEnd( boxId: any, event: any) {
	try {
		const id = String(boxId || '');
		const host = document.getElementById(id + '_tf_groupby_rows') as any;
		if (host) host.classList.remove('is-dragging');
		__kustoClearGroupByDropIndicators(id);
		(window as any).__kustoGroupByDragState = null;
	} catch { /* ignore */ }
}

function __kustoOnGroupByDrop( boxId: any, index: any, event: any) {
	try {
		const e = event;
		if (e && typeof e.preventDefault === 'function') e.preventDefault();
		const state = (window as any).__kustoGroupByDragState;
		if (!state || state.boxId !== boxId) return;
		const id = String(boxId || '');
		const fromIdx = state.fromIndex;
		let toIdx = state.overIndex;
		const insertAfter = state.insertAfter;
		if (!Number.isFinite(fromIdx) || !Number.isFinite(toIdx)) return;
		if (insertAfter) toIdx++;
		if (fromIdx < toIdx) toIdx--;
		if (fromIdx === toIdx) {
			__kustoOnGroupByDragEnd(id, e);
			return;
		}
		const st = __kustoGetTransformationState(id);
		if (!Array.isArray(st.groupByColumns)) st.groupByColumns = [''];
		const arr = st.groupByColumns;
		const item = arr.splice(fromIdx, 1)[0];
		arr.splice(toIdx, 0, item);
		__kustoOnGroupByDragEnd(id, e);
		try { __kustoUpdateTransformationBuilderUI(id); } catch { /* ignore */ }
		try { __kustoRenderTransformation(id); } catch { /* ignore */ }
		try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
	} catch { /* ignore */ }
}

function __kustoOnAggDragStart( boxId: any, index: any, event: any) {
	try {
		const id = String(boxId || '');
		const i = Number(index);
		if (!id || !Number.isFinite(i)) return;
		(window as any).__kustoAggDragState = { boxId: id, fromIndex: Math.floor(i), overIndex: null, insertAfter: false };
		try {
			const e = event;
			if (e && e.dataTransfer) {
				e.dataTransfer.effectAllowed = 'move';
				try { e.dataTransfer.setData('text/plain', 'kusto-agg'); } catch { /* ignore */ }
			}
		} catch { /* ignore */ }
		try {
			const host = document.getElementById(id + '_tf_aggs') as any;
			if (host) host.classList.add('is-dragging');
		} catch { /* ignore */ }
		try { __kustoClearAggDropIndicators(id); } catch { /* ignore */ }
	} catch { /* ignore */ }
}

function __kustoClearAggDropIndicators( boxId: any) {
	try {
		const id = String(boxId || '');
		const host = document.getElementById(id + '_tf_aggs') as any;
		if (!host) return;
		const rows = host.querySelectorAll('.kusto-transform-agg-row');
		for (const r of rows) {
			try {
				r.classList.remove('is-drop-target');
				r.classList.remove('is-drop-before');
				r.classList.remove('is-drop-after');
			} catch { /* ignore */ }
		}
	} catch { /* ignore */ }
}

function __kustoOnAggDragOver( boxId: any, overIndex: any, event: any) {
	try {
		const id = String(boxId || '');
		const idx = Number(overIndex);
		const e = event;
		if (!id || !Number.isFinite(idx) || !e) return;
		try { e.preventDefault(); } catch { /* ignore */ }
		try { if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'; } catch { /* ignore */ }
		const drag = (window as any).__kustoAggDragState;
		if (!drag || String(drag.boxId || '') !== id) return;
		let insertAfter = false;
		try {
			const rowEl = e.currentTarget;
			if (rowEl && rowEl.getBoundingClientRect) {
				const rect = rowEl.getBoundingClientRect();
				const y = e.clientY;
				insertAfter = y >= (rect.top + rect.height / 2);
			}
		} catch { /* ignore */ }
		drag.overIndex = Math.floor(idx);
		drag.insertAfter = !!insertAfter;
		try {
			__kustoClearAggDropIndicators(id);
			const rowEl = e.currentTarget;
			if (rowEl && rowEl.classList) {
				rowEl.classList.add('is-drop-target');
				rowEl.classList.add(insertAfter ? 'is-drop-after' : 'is-drop-before');
			}
		} catch { /* ignore */ }
	} catch { /* ignore */ }
}

function __kustoOnAggDrop( boxId: any, toIndex: any, event: any) {
	try {
		const id = String(boxId || '');
		const to = Number(toIndex);
		if (!id || !Number.isFinite(to)) return;
		try { event && event.preventDefault && event.preventDefault(); } catch { /* ignore */ }
		const drag = (window as any).__kustoAggDragState;
		if (!drag || String(drag.boxId || '') !== id) return;
		const from = Number(drag.fromIndex);
		if (!Number.isFinite(from)) return;
		const st = __kustoGetTransformationState(id);
		if (!Array.isArray(st.aggregations) || st.aggregations.length < 2) return;
		const fromIdx = Math.max(0, Math.min(st.aggregations.length - 1, Math.floor(from)));
		const overIdx = Number.isFinite(drag.overIndex) ? Math.floor(drag.overIndex) : Math.floor(to);
		const insertAfter = !!drag.insertAfter;
		let insertion = overIdx + (insertAfter ? 1 : 0);
		insertion = Math.max(0, Math.min(st.aggregations.length, insertion));
		if (insertion === fromIdx || insertion === fromIdx + 1) {
			try { __kustoClearAggDropIndicators(id); } catch { /* ignore */ }
			return;
		}
		const moved = st.aggregations.splice(fromIdx, 1)[0];
		const toInsert = fromIdx < insertion ? (insertion - 1) : insertion;
		st.aggregations.splice(toInsert, 0, moved);
		try { __kustoUpdateTransformationBuilderUI(id); } catch { /* ignore */ }
		try { __kustoRenderTransformation(id); } catch { /* ignore */ }
		try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
		try { __kustoClearAggDropIndicators(id); } catch { /* ignore */ }
	} catch { /* ignore */ }
}

function __kustoOnAggDragEnd( boxId: any, event: any) {
	try {
		const id = String(boxId || '');
		(window as any).__kustoAggDragState = null;
		try {
			const host = document.getElementById(id + '_tf_aggs') as any;
			if (host) host.classList.remove('is-dragging');
		} catch { /* ignore */ }
		try { __kustoClearAggDropIndicators(id); } catch { /* ignore */ }
		try { event && event.preventDefault && event.preventDefault(); } catch { /* ignore */ }
	} catch { /* ignore */ }
}

function __kustoOnCalculatedColumnChanged( boxId: any, index: any, field: any, value: any) {
	const id = String(boxId || '');
	const i = Number(index);
	const f = String(field || '');
	if (!id || !Number.isFinite(i)) return;
	const st = __kustoGetTransformationState(id);
	if (!Array.isArray(st.deriveColumns) || st.deriveColumns.length === 0) {
		st.deriveColumns = [{ name: '', expression: '' }];
	}
	if (!st.deriveColumns[i]) st.deriveColumns[i] = { name: '', expression: '' };
	if (f === 'name') st.deriveColumns[i].name = String(value || '');
	if (f === 'expression') st.deriveColumns[i].expression = String(value || '');
	// Keep legacy single-field properties in sync for safety.
	try {
		if (i === 0) {
			st.deriveColumnName = String(st.deriveColumns[0].name || '');
			st.deriveExpression = String(st.deriveColumns[0].expression || '');
		}
	} catch { /* ignore */ }
	try { __kustoRenderTransformation(id); } catch { /* ignore */ }
	try {
		setTimeout(() => {
			try {
				const w = document.getElementById(id + '_tf_wrapper') as any;
				if (w && !(w.dataset && w.dataset.kustoUserResized === 'true')) {
					w.dataset.kustoAutoFitActive = 'true';
				}
			} catch { /* ignore */ }
			try { __kustoMaybeAutoFitTransformationBox(id); } catch { /* ignore */ }
		}, 0);
	} catch { /* ignore */ }
	try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
}

function __kustoAddCalculatedColumn( boxId: any) {
	const id = String(boxId || '');
	const insertAfterIndex = arguments.length >= 2 ? Number(arguments[1]) : NaN;
	if (!id) return;
	const st = __kustoGetTransformationState(id);
	if (!Array.isArray(st.deriveColumns) || st.deriveColumns.length === 0) {
		st.deriveColumns = [{ name: '', expression: '' }];
	}
	let insertedIndex = st.deriveColumns.length;
	if (Number.isFinite(insertAfterIndex) && insertAfterIndex >= 0 && insertAfterIndex < st.deriveColumns.length) {
		insertedIndex = Math.floor(insertAfterIndex) + 1;
		st.deriveColumns.splice(insertedIndex, 0, { name: '', expression: '' });
	} else {
		st.deriveColumns.push({ name: '', expression: '' });
		insertedIndex = st.deriveColumns.length - 1;
	}
	try { __kustoUpdateTransformationBuilderUI(id); } catch { /* ignore */ }
	try {
		setTimeout(() => {
			try {
				const el = document.getElementById(id + '_tf_derive_name_' + insertedIndex) as any;
				if (el && typeof el.focus === 'function') el.focus();
			} catch { /* ignore */ }
			try {
				const w = document.getElementById(id + '_tf_wrapper') as any;
				if (w && !(w.dataset && w.dataset.kustoUserResized === 'true')) {
					w.dataset.kustoAutoFitActive = 'true';
				}
			} catch { /* ignore */ }
			try { __kustoMaybeAutoFitTransformationBox(id); } catch { /* ignore */ }
		}, 0);
	} catch { /* ignore */ }
	try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
}

function __kustoRemoveCalculatedColumn( boxId: any, index: any) {
	const id = String(boxId || '');
	const i = Number(index);
	if (!id || !Number.isFinite(i)) return;
	const st = __kustoGetTransformationState(id);
	if (!Array.isArray(st.deriveColumns) || st.deriveColumns.length <= 1) return;
	st.deriveColumns.splice(i, 1);
	try {
		// Keep legacy single-field properties in sync.
		const first = st.deriveColumns[0] || { name: '', expression: '' };
		st.deriveColumnName = String(first.name || '');
		st.deriveExpression = String(first.expression || '');
	} catch { /* ignore */ }
	try { __kustoUpdateTransformationBuilderUI(id); } catch { /* ignore */ }
	try { __kustoRenderTransformation(id); } catch { /* ignore */ }
	try {
		// When removing columns, shrink-to-fit (one-shot) if auto-fit is enabled.
		setTimeout(() => {
			try {
				const w = document.getElementById(id + '_tf_wrapper') as any;
				if (w) {
					w.dataset.kustoAutoFitActive = 'true';
					w.dataset.kustoAutoFitAllowShrink = 'true';
				}
			} catch { /* ignore */ }
			try { __kustoMaybeAutoFitTransformationBox(id); } catch { /* ignore */ }
		}, 0);
		setTimeout(() => {
			try {
				const w = document.getElementById(id + '_tf_wrapper') as any;
				if (w) {
					w.dataset.kustoAutoFitActive = 'true';
					w.dataset.kustoAutoFitAllowShrink = 'true';
				}
			} catch { /* ignore */ }
			try { __kustoMaybeAutoFitTransformationBox(id); } catch { /* ignore */ }
		}, 80);
	} catch { /* ignore */ }
	try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
}

function __kustoOnDeriveDragStart( boxId: any, index: any, event: any) {
	try {
		const id = String(boxId || '');
		const i = Number(index);
		if (!id || !Number.isFinite(i)) return;
		(window as any).__kustoDeriveDragState = { boxId: id, fromIndex: Math.floor(i), overIndex: null, insertAfter: false };
		try {
			const e = event;
			if (e && e.dataTransfer) {
				e.dataTransfer.effectAllowed = 'move';
				try { e.dataTransfer.setData('text/plain', 'kusto-derive'); } catch { /* ignore */ }
			}
		} catch { /* ignore */ }
		try {
			const host = document.getElementById(id + '_tf_derive_rows') as any;
			if (host) host.classList.add('is-dragging');
		} catch { /* ignore */ }
		try { __kustoClearDeriveDropIndicators(id); } catch { /* ignore */ }
	} catch { /* ignore */ }
}

function __kustoClearDeriveDropIndicators( boxId: any) {
	try {
		const id = String(boxId || '');
		const host = document.getElementById(id + '_tf_derive_rows') as any;
		if (!host) return;
		const rows = host.querySelectorAll('.kusto-transform-derive-row');
		for (const r of rows) {
			try {
				r.classList.remove('is-drop-target');
				r.classList.remove('is-drop-before');
				r.classList.remove('is-drop-after');
			} catch { /* ignore */ }
		}
	} catch { /* ignore */ }
}

function __kustoOnDeriveDragOver( boxId: any, overIndex: any, event: any) {
	try {
		const id = String(boxId || '');
		const idx = Number(overIndex);
		const e = event;
		if (!id || !Number.isFinite(idx) || !e) return;
		try { e.preventDefault(); } catch { /* ignore */ }
		try { if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'; } catch { /* ignore */ }
		const drag = (window as any).__kustoDeriveDragState;
		if (!drag || String(drag.boxId || '') !== id) return;
		let insertAfter = false;
		try {
			const rowEl = e.currentTarget;
			if (rowEl && rowEl.getBoundingClientRect) {
				const rect = rowEl.getBoundingClientRect();
				const y = e.clientY;
				insertAfter = y >= (rect.top + rect.height / 2);
			}
		} catch { /* ignore */ }
		drag.overIndex = Math.floor(idx);
		drag.insertAfter = !!insertAfter;
		try {
			__kustoClearDeriveDropIndicators(id);
			const rowEl = e.currentTarget;
			if (rowEl && rowEl.classList) {
				rowEl.classList.add('is-drop-target');
				rowEl.classList.add(insertAfter ? 'is-drop-after' : 'is-drop-before');
			}
		} catch { /* ignore */ }
	} catch { /* ignore */ }
}

function __kustoOnDeriveDrop( boxId: any, toIndex: any, event: any) {
	try {
		const id = String(boxId || '');
		const to = Number(toIndex);
		if (!id || !Number.isFinite(to)) return;
		try { event && event.preventDefault && event.preventDefault(); } catch { /* ignore */ }
		const drag = (window as any).__kustoDeriveDragState;
		if (!drag || String(drag.boxId || '') !== id) return;
		const from = Number(drag.fromIndex);
		if (!Number.isFinite(from)) return;
		const st = __kustoGetTransformationState(id);
		if (!Array.isArray(st.deriveColumns) || st.deriveColumns.length < 2) return;
		const fromIdx = Math.max(0, Math.min(st.deriveColumns.length - 1, Math.floor(from)));
		const overIdx = Number.isFinite(drag.overIndex) ? Math.floor(drag.overIndex) : Math.floor(to);
		const insertAfter = !!drag.insertAfter;
		let insertion = overIdx + (insertAfter ? 1 : 0);
		insertion = Math.max(0, Math.min(st.deriveColumns.length, insertion));
		if (insertion === fromIdx || insertion === fromIdx + 1) {
			try { __kustoClearDeriveDropIndicators(id); } catch { /* ignore */ }
			return;
		}
		const moved = st.deriveColumns.splice(fromIdx, 1)[0];
		const toInsert = fromIdx < insertion ? (insertion - 1) : insertion;
		st.deriveColumns.splice(toInsert, 0, moved);
		try {
			const first = st.deriveColumns[0] || { name: '', expression: '' };
			st.deriveColumnName = String(first.name || '');
			st.deriveExpression = String(first.expression || '');
		} catch { /* ignore */ }
		try { __kustoUpdateTransformationBuilderUI(id); } catch { /* ignore */ }
		try { __kustoRenderTransformation(id); } catch { /* ignore */ }
		try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
		try { __kustoClearDeriveDropIndicators(id); } catch { /* ignore */ }
	} catch { /* ignore */ }
}

function __kustoOnDeriveDragEnd( boxId: any, event: any) {
	try {
		const id = String(boxId || '');
		(window as any).__kustoDeriveDragState = null;
		try {
			const host = document.getElementById(id + '_tf_derive_rows') as any;
			if (host) host.classList.remove('is-dragging');
		} catch { /* ignore */ }
		try { __kustoClearDeriveDropIndicators(id); } catch { /* ignore */ }
		try { event && event.preventDefault && event.preventDefault(); } catch { /* ignore */ }
	} catch { /* ignore */ }
}

function __kustoOnTransformationPivotChanged( boxId: any) {
	const id = String(boxId || '');
	if (!id) return;
	const st = __kustoGetTransformationState(id);
	try {
		const rowSel = document.getElementById(id + '_tf_pivot_row') as any;
		const colSel = document.getElementById(id + '_tf_pivot_col') as any;
		const valSel = document.getElementById(id + '_tf_pivot_val') as any;
		const aggSel = document.getElementById(id + '_tf_pivot_agg') as any;
		st.pivotRowKeyColumn = String((rowSel || {}).value || '');
		st.pivotColumnKeyColumn = String((colSel || {}).value || '');
		st.pivotValueColumn = String((valSel || {}).value || '');
		st.pivotAggregation = String((aggSel || {}).value || 'sum');
		// Keep max columns at 100 internally (UI removed)
		st.pivotMaxColumns = 100;
		// Sync dropdown button text for custom dropdowns
		try {
			const rowTxt = document.getElementById(id + '_tf_pivot_row_text') as any;
			if (rowTxt) rowTxt.textContent = st.pivotRowKeyColumn || '(select)';
			const colTxt = document.getElementById(id + '_tf_pivot_col_text') as any;
			if (colTxt) colTxt.textContent = st.pivotColumnKeyColumn || '(select)';
			const valTxt = document.getElementById(id + '_tf_pivot_val_text') as any;
			if (valTxt) valTxt.textContent = st.pivotValueColumn || '(select)';
			const aggTxt = document.getElementById(id + '_tf_pivot_agg_text') as any;
			if (aggTxt) aggTxt.textContent = st.pivotAggregation || 'sum';
		} catch { /* ignore */ }
	} catch { /* ignore */ }
	try { __kustoRenderTransformation(id); } catch { /* ignore */ }
	// When pivot settings change, the results can vary significantly in content and width.
	// Allow the section to shrink/grow to fit the new contents.
	try {
		const runFit = () => {
			try {
				const w = document.getElementById(id + '_tf_wrapper') as any;
				if (!w) return;
				w.dataset.kustoAutoFitActive = 'true';
				w.dataset.kustoAutoFitAllowShrink = 'true';
				__kustoMaybeAutoFitTransformationBox(id);
				w.dataset.kustoAutoFitAllowShrink = '';
			} catch { /* ignore */ }
		};
		setTimeout(runFit, 0);
	} catch { /* ignore */ }
	try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
}

function __kustoTryParseFiniteNumber( v: any) {
	try {
		if (typeof _win.__kustoTryParseNumber === 'function') {
			const n = _win.__kustoTryParseNumber(v);
			return (typeof n === 'number' && Number.isFinite(n)) ? n : null;
		}
		const n = (typeof v === 'number') ? v : Number(v);
		return Number.isFinite(n) ? n : null;
	} catch {
		return null;
	}
}

function __kustoTryParseDate( v: any) {
	try {
		if (v === null || v === undefined) return null;
		if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
		const d = new Date(v);
		return isNaN(d.getTime()) ? null : d;
	} catch {
		return null;
	}
}

function __kustoFormatDate( d: any, fmt: any) {
	try {
		if (!d || !(d instanceof Date)) return null;
		const pad = (n: any, len?: any) => String(n).padStart(len || 2, '0');
		return (fmt as any)
			.replace(/yyyy/g, d.getFullYear())
			.replace(/yy/g, String(d.getFullYear()).slice(-2))
			.replace(/MM/g, pad(d.getMonth() + 1))
			.replace(/M/g, d.getMonth() + 1)
			.replace(/dd/g, pad(d.getDate()))
			.replace(/d/g, d.getDate())
			.replace(/HH/g, pad(d.getHours()))
			.replace(/H/g, d.getHours())
			.replace(/hh/g, pad(d.getHours() % 12 || 12))
			.replace(/h/g, d.getHours() % 12 || 12)
			.replace(/mm/g, pad(d.getMinutes()))
			.replace(/m/g, d.getMinutes())
			.replace(/ss/g, pad(d.getSeconds()))
			.replace(/s/g, d.getSeconds());
	} catch {
		return null;
	}
}

function __kustoGetRawCellValueForTransform( cell: any) {
	try { return __kustoGetRawCellValueForChart(cell); } catch { /* ignore */ }
	try {
		if (cell && typeof cell === 'object') {
			if ('full' in cell) return cell.full;
			if ('display' in cell) return cell.display;
		}
	} catch { /* ignore */ }
	return cell;
}

// --- Expression engine (safe, minimal) for Derive ---

function __kustoTokenizeExpr( text: any) {
	const s = String(text || '');
	const tokens = [];
	let i = 0;
	const isWs = (ch: any) => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
	const isDigit = (ch: any) => ch >= '0' && ch <= '9';
	const isIdentStart = (ch: any) => (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || ch === '_' ;
	const isIdent = (ch: any) => isIdentStart(ch) || isDigit(ch);
	while (i < s.length) {
		const ch = s[i];
		if (isWs(ch)) { i++; continue; }
		if (ch === '(' || ch === ')' || ch === ',' || ch === '+' || ch === '-' || ch === '*' || ch === '/') {
			tokens.push({ t: 'op', v: ch });
			i++;
			continue;
		}
		if (ch === '[') {
			let j = i + 1;
			let name = '';
			while (j < s.length && s[j] !== ']') {
				name += s[j];
				j++;
			}
			if (j >= s.length) throw new Error('Unclosed [column] reference');
			tokens.push({ t: 'col', v: name.trim() });
			i = j + 1;
			continue;
		}
		if (ch === '"' || ch === "'") {
			const quote = ch;
			let j = i + 1;
			let out = '';
			while (j < s.length) {
				const c = s[j];
				if (c === '\\' && j + 1 < s.length) {
					out += s[j + 1];
					j += 2;
					continue;
				}
				if (c === quote) break;
				out += c;
				j++;
			}
			if (j >= s.length) throw new Error('Unclosed string literal');
			tokens.push({ t: 'str', v: out });
			i = j + 1;
			continue;
		}
		if (isDigit(ch) || (ch === '.' && i + 1 < s.length && isDigit(s[i + 1]))) {
			let j = i;
			let num = '';
			while (j < s.length) {
				const c = s[j];
				if (isDigit(c) || c === '.') {
					num += c;
					j++;
					continue;
				}
				break;
			}
			const n = Number(num);
			if (!Number.isFinite(n)) throw new Error('Invalid number: ' + num);
			tokens.push({ t: 'num', v: n });
			i = j;
			continue;
		}
		if (isIdentStart(ch)) {
			let j = i;
			let id = '';
			while (j < s.length && isIdent(s[j])) {
				id += s[j];
				j++;
			}
			tokens.push({ t: 'id', v: id });
			i = j;
			continue;
		}
		throw new Error('Unexpected character: ' + ch);
	}
	return tokens;
}

function __kustoParseExprToRpn( tokens: any) {
	const output: any[] = [];
	const stack: any[] = [];
	const prec: any = { 'u-': 4, '*': 3, '/': 3, '+': 2, '-': 2 };
	const rightAssoc: any = { 'u-': true };
	const isOp = (v: any) => v === '+' || v === '-' || v === '*' || v === '/' || v === 'u-';
	let prev = null;
	for (let i = 0; i < tokens.length; i++) {
		const tok = tokens[i];
		if (tok.t === 'num' || tok.t === 'str' || tok.t === 'col') {
			output.push(tok);
			prev = tok;
			continue;
		}
		if (tok.t === 'id') {
			// Function call if next token is '('
			const next = tokens[i + 1];
			if (next && next.t === 'op' && next.v === '(') {
				stack.push({ t: 'fn', v: tok.v });
				prev = tok;
				continue;
			}
			// Otherwise treat as column reference (identifier)
			output.push({ t: 'col', v: tok.v });
			prev = tok;
			continue;
		}
		if (tok.t === 'op') {
			if (tok.v === ',') {
				while (stack.length && !(stack[stack.length - 1].t === 'op' && stack[stack.length - 1].v === '(')) {
					output.push(stack.pop());
				}
				continue;
			}
			if (tok.v === '(') {
				stack.push(tok);
				prev = tok;
				continue;
			}
			if (tok.v === ')') {
				while (stack.length && !(stack[stack.length - 1].t === 'op' && stack[stack.length - 1].v === '(')) {
					output.push(stack.pop());
				}
				if (!stack.length) throw new Error('Mismatched )');
				stack.pop(); // pop '('
				// Pop function if present
				if (stack.length && stack[stack.length - 1].t === 'fn') {
					output.push(stack.pop());
				}
				prev = tok;
				continue;
			}
			// operator
			let op = tok.v;
			if (op === '-') {
				const prevIsValue = prev && (prev.t === 'num' || prev.t === 'str' || prev.t === 'col' || (prev.t === 'op' && prev.v === ')'));
				if (!prevIsValue) op = 'u-';
			}
			if (!isOp(op)) throw new Error('Unsupported operator: ' + op);
			while (stack.length) {
				const top = stack[stack.length - 1];
				if (top.t !== 'op' || !isOp(top.v)) break;
				const p1 = prec[op] || 0;
				const p2 = prec[top.v] || 0;
				if ((rightAssoc[op] && p1 < p2) || (!rightAssoc[op] && p1 <= p2)) {
					output.push(stack.pop());
					continue;
				}
				break;
			}
			stack.push({ t: 'op', v: op });
			prev = tok;
			continue;
		}
		throw new Error('Unexpected token');
	}
	while (stack.length) {
		const top = stack.pop();
		if (top.t === 'op' && (top.v === '(' || top.v === ')')) throw new Error('Mismatched parentheses');
		output.push(top);
	}
	return output;
}

function __kustoEvalRpn( rpn: any, env: any) {
	const stack = [];
	const getCol = (name: any) => {
		const key = String(name || '');
		if (!key) return null;
		// prefer exact
		if (env && Object.prototype.hasOwnProperty.call(env, key)) return env[key];
		const lower = key.toLowerCase();
		if (env && Object.prototype.hasOwnProperty.call(env, lower)) return env[lower];
		return null;
	};
	const callFn = (fnName: any, args: any) => {
		const f = String(fnName || '').toLowerCase();
		if (f === 'coalesce') {
			for (const a of args) {
				if (a !== null && a !== undefined && String(a) !== '') return a;
			}
			return null;
		}
		if (f === 'tostring') {
			return (args.length ? String(args[0] ?? '') : '');
		}
		if (f === 'tonumber') {
			return __kustoTryParseFiniteNumber(args.length ? args[0] : null);
		}
		if (f === 'len') {
			return String(args.length ? args[0] ?? '' : '').length;
		}
		if (f === 'round') {
			const val = __kustoTryParseFiniteNumber(args.length ? args[0] : null);
			if (val === null) return null;
			const digits = args.length > 1 ? __kustoTryParseFiniteNumber(args[1]) : 0;
			if (digits === null || digits < 0 || !Number.isInteger(digits)) {
				// Invalid digits - default to 0 decimal places
				return Math.round(val);
			}
			const factor = Math.pow(10, digits);
			return Math.round(val * factor) / factor;
		}
		if (f === 'floor') {
			const val = __kustoTryParseFiniteNumber(args.length ? args[0] : null);
			return val === null ? null : Math.floor(val);
		}
		if (f === 'ceiling' || f === 'ceil') {
			const val = __kustoTryParseFiniteNumber(args.length ? args[0] : null);
			return val === null ? null : Math.ceil(val);
		}
		if (f === 'abs') {
			const val = __kustoTryParseFiniteNumber(args.length ? args[0] : null);
			return val === null ? null : Math.abs(val);
		}
		// String functions
		if (f === 'trim') {
			return String(args.length ? args[0] ?? '' : '').trim();
		}
		if (f === 'toupper' || f === 'upper') {
			return String(args.length ? args[0] ?? '' : '').toUpperCase();
		}
		if (f === 'tolower' || f === 'lower') {
			return String(args.length ? args[0] ?? '' : '').toLowerCase();
		}
		if (f === 'substring') {
			const text = String(args.length ? args[0] ?? '' : '');
			const start = args.length > 1 ? __kustoTryParseFiniteNumber(args[1]) : 0;
			const len = args.length > 2 ? __kustoTryParseFiniteNumber(args[2]) : undefined;
			if (start === null) return null;
			if (len !== undefined && len !== null) {
				return text.substring(start, start + len);
			}
			return text.substring(start);
		}
		if (f === 'replace') {
			const text = String(args.length ? args[0] ?? '' : '');
			const oldStr = String(args.length > 1 ? args[1] ?? '' : '');
			const newStr = String(args.length > 2 ? args[2] ?? '' : '');
			return text.split(oldStr).join(newStr);
		}
		if (f === 'indexof') {
			const text = String(args.length ? args[0] ?? '' : '');
			const search = String(args.length > 1 ? args[1] ?? '' : '');
			return text.indexOf(search);
		}
		// Date functions
		if (f === 'now') {
			return new Date();
		}
		if (f === 'datetime') {
			const val = args.length ? args[0] : null;
			if (val === null || val === undefined) return null;
			if (val instanceof Date) return val;
			const d = new Date(val);
			return isNaN(d.getTime()) ? null : d;
		}
		if (f === 'getyear') {
			const d = __kustoTryParseDate(args.length ? args[0] : null);
			return d ? d.getFullYear() : null;
		}
		if (f === 'getmonth') {
			const d = __kustoTryParseDate(args.length ? args[0] : null);
			return d ? (d.getMonth() + 1) : null;
		}
		if (f === 'getday') {
			const d = __kustoTryParseDate(args.length ? args[0] : null);
			return d ? d.getDate() : null;
		}
		if (f === 'dayofweek') {
			const d = __kustoTryParseDate(args.length ? args[0] : null);
			return d ? d.getDay() : null;
		}
		if (f === 'format_datetime') {
			const d = __kustoTryParseDate(args.length ? args[0] : null);
			if (!d) return null;
			const fmt = String(args.length > 1 ? args[1] ?? '' : 'yyyy-MM-dd');
			return __kustoFormatDate(d, fmt);
		}
		if (f === 'datetime_add') {
			const unit = String(args.length ? args[0] ?? '' : '').toLowerCase();
			const amount = args.length > 1 ? __kustoTryParseFiniteNumber(args[1]) : 0;
			const d = __kustoTryParseDate(args.length > 2 ? args[2] : null);
			if (!d || amount === null) return null;
			const result = new Date(d.getTime());
			if (unit === 'year') result.setFullYear(result.getFullYear() + amount);
			else if (unit === 'month') result.setMonth(result.getMonth() + amount);
			else if (unit === 'day') result.setDate(result.getDate() + amount);
			else if (unit === 'hour') result.setHours(result.getHours() + amount);
			else if (unit === 'minute') result.setMinutes(result.getMinutes() + amount);
			else if (unit === 'second') result.setSeconds(result.getSeconds() + amount);
			else return null;
			return result;
		}
		if (f === 'datetime_diff') {
			const unit = String(args.length ? args[0] ?? '' : '').toLowerCase();
			const d1 = __kustoTryParseDate(args.length > 1 ? args[1] : null);
			const d2 = __kustoTryParseDate(args.length > 2 ? args[2] : null);
			if (!d1 || !d2) return null;
			const diffMs = d1.getTime() - d2.getTime();
			if (unit === 'year') return Math.floor(diffMs / (365.25 * 24 * 60 * 60 * 1000));
			if (unit === 'month') return Math.floor(diffMs / (30.44 * 24 * 60 * 60 * 1000));
			if (unit === 'day') return Math.floor(diffMs / (24 * 60 * 60 * 1000));
			if (unit === 'hour') return Math.floor(diffMs / (60 * 60 * 1000));
			if (unit === 'minute') return Math.floor(diffMs / (60 * 1000));
			if (unit === 'second') return Math.floor(diffMs / 1000);
			return null;
		}
		if (f === 'startofday') {
			const d = __kustoTryParseDate(args.length ? args[0] : null);
			if (!d) return null;
			return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
		}
		if (f === 'startofweek') {
			const d = __kustoTryParseDate(args.length ? args[0] : null);
			if (!d) return null;
			const result = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
			result.setDate(result.getDate() - result.getDay()); // Subtract days to get to Sunday
			return result;
		}
		if (f === 'startofmonth') {
			const d = __kustoTryParseDate(args.length ? args[0] : null);
			if (!d) return null;
			return new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0);
		}
		if (f === 'startofyear') {
			const d = __kustoTryParseDate(args.length ? args[0] : null);
			if (!d) return null;
			return new Date(d.getFullYear(), 0, 1, 0, 0, 0, 0);
		}
		throw new Error('Unknown function: ' + fnName);
	};
	for (const tok of rpn) {
		if (tok.t === 'num' || tok.t === 'str') {
			stack.push(tok.v);
			continue;
		}
		if (tok.t === 'col') {
			stack.push(getCol(tok.v));
			continue;
		}
		if (tok.t === 'op') {
			if (tok.v === 'u-') {
				const a = stack.pop();
				const n = __kustoTryParseFiniteNumber(a);
				stack.push((n === null) ? null : (-n));
				continue;
			}
			const b = stack.pop();
			const a = stack.pop();
			if (tok.v === '+') {
				// number add if both numeric; else concat
				const an = __kustoTryParseFiniteNumber(a);
				const bn = __kustoTryParseFiniteNumber(b);
				if (an !== null && bn !== null) stack.push(an + bn);
				else stack.push(String(a ?? '') + String(b ?? ''));
				continue;
			}
			if (tok.v === '-') {
				const an = __kustoTryParseFiniteNumber(a);
				const bn = __kustoTryParseFiniteNumber(b);
				stack.push((an === null || bn === null) ? null : (an - bn));
				continue;
			}
			if (tok.v === '*') {
				const an = __kustoTryParseFiniteNumber(a);
				const bn = __kustoTryParseFiniteNumber(b);
				stack.push((an === null || bn === null) ? null : (an * bn));
				continue;
			}
			if (tok.v === '/') {
				const an = __kustoTryParseFiniteNumber(a);
				const bn = __kustoTryParseFiniteNumber(b);
				stack.push((an === null || bn === null || bn === 0) ? null : (an / bn));
				continue;
			}
			throw new Error('Unsupported operator: ' + tok.v);
		}
		if (tok.t === 'fn') {
			// Heuristic: pop up to N args if they were pushed since last '(' isn't tracked.
			// To keep this safe/simple, we define the arity for each supported function.
			const name = String(tok.v || '');
			const lower = name.toLowerCase();
			const fnArgCounts: any = {
				'len': 1,
				'tostring': 1,
				'tonumber': 1,
				'round': 2,
				'floor': 1,
				'ceiling': 1,
				'ceil': 1,
				'abs': 1,
				// String functions
				'trim': 1,
				'toupper': 1,
				'upper': 1,
				'tolower': 1,
				'lower': 1,
				'substring': 3,
				'replace': 3,
				'indexof': 2,
				// Date functions
				'now': 0,
				'datetime': 1,
				'getyear': 1,
				'getmonth': 1,
				'getday': 1,
				'dayofweek': 1,
				'startofday': 1,
				'startofweek': 1,
				'startofmonth': 1,
				'startofyear': 1,
				'format_datetime': 2,
				'datetime_add': 3,
				'datetime_diff': 3
			};
			const argc = fnArgCounts[lower] ?? 1;
			const args = [];
			for (let k = 0; k < argc; k++) args.unshift(stack.pop());
			stack.push(callFn(name, args));
			continue;
		}
		throw new Error('Unexpected token in eval');
	}
	return stack.length ? stack[stack.length - 1] : null;
}

function __kustoRenderTransformationError( boxId: any, message: any) {
	try {
		const resultsDiv = document.getElementById(boxId + '_results') as any;
		const wrapper = document.getElementById(boxId + '_results_wrapper') as any;
		if (wrapper) wrapper.style.display = '';
		if (resultsDiv) {
			resultsDiv.innerHTML = '<div class="error-message" style="white-space:pre-wrap">' + ((typeof _win.escapeHtml === 'function') ? _win.escapeHtml(String(message || '')) : String(message || '')) + '</div>';
		}
	} catch { /* ignore */ }
}

function __kustoRenderTransformation( boxId: any) {
	const id = String(boxId || '');
	if (!id) return;

	// If this is a Lit element, delegate to its refresh() method.
	try {
		const el = document.getElementById(id) as any;
		if (el && typeof el.refresh === 'function') {
			el.refresh();
			return;
		}
	} catch { /* ignore */ }

	const st = __kustoGetTransformationState(id);
	if (st && st.expanded === false) return;

	const datasets = __kustoGetChartDatasetsInDomOrder();
	const ds = datasets.find((d: any) => String(d.id) === String(st.dataSourceId || ''));
	if (!ds) {
		__kustoRenderTransformationError(id, 'Select a data source (a query, CSV URL, or transformation section with results).');
		return;
	}

	const cols = Array.isArray(ds.columns) ? ds.columns : [];
	const colNames = cols.map(__kustoNormalizeResultsColumnName).filter((c: any) => c);
	const colIndex: any = {};
	for (let i = 0; i < colNames.length; i++) {
		colIndex[String(colNames[i]).toLowerCase()] = i;
		colIndex[String(colNames[i])] = i;
	}
	const rows = Array.isArray(ds.rows) ? ds.rows : [];

	try {
		const type = String(st.transformationType || 'derive');
		if (type === 'derive') {
			let deriveColumns = Array.isArray(st.deriveColumns) ? st.deriveColumns : [];
			// Back-compat: if deriveColumns missing, derive from legacy fields.
			if (!deriveColumns.length) {
				const legacyName = String(st.deriveColumnName || '').trim();
				const legacyExpr = String(st.deriveExpression || '').trim();
				if (legacyName || legacyExpr) {
					deriveColumns = [{ name: legacyName || 'derived', expression: legacyExpr || '' }];
				}
			}

			// Build valid calculated columns only (don't break preview while editing).
			const parsed = [];
			for (const d of deriveColumns) {
				const n = String((d && d.name) || '').trim();
				const e = String((d && d.expression) || '').trim();
				if (!n && !e) continue;
				if (!e) continue;
				const name = n || 'derived';
				try {
					const rpn = __kustoParseExprToRpn(__kustoTokenizeExpr(e));
					parsed.push({ name, rpn });
				} catch {
					// Skip invalid expression while user is editing.
					continue;
				}
			}

			// If nothing is valid yet, still show the base dataset.
			if (!parsed.length) {
				const outRowsBase = [];
				for (const r of rows) {
					const row = Array.isArray(r) ? r : [];
					outRowsBase.push(row.map(__kustoGetRawCellValueForTransform));
				}
				_win.displayResultForBox({ columns: colNames.slice(), rows: outRowsBase, metadata: { transformationType: 'derive' } }, id, { label: 'Transformations', showExecutionTime: false });
				try {
					const wrapper = document.getElementById(id + '_results_wrapper') as any;
					if (wrapper) wrapper.style.display = '';
				} catch { /* ignore */ }
				try { __kustoEnsureTransformationAutoExpandWhenResultsAppear(id); } catch { /* ignore */ }
				try { setTimeout(() => { try { __kustoMaybeAutoFitTransformationBox(id); } catch { /* ignore */ } }, 0); } catch { /* ignore */ }
				return;
			}

			const outCols = colNames.concat(parsed.map((p: any) => String(p.name || '').trim() || 'derived'));
			const outRows: any[] = [];

			for (const r of rows) {
				const row = Array.isArray(r) ? r : [];
				const baseRawRow = row.map(__kustoGetRawCellValueForTransform);
				const env: any = {};
				// Seed env with original columns
				for (let i = 0; i < colNames.length; i++) {
					const name = colNames[i];
					const raw = baseRawRow[i];
					env[name] = raw;
					env[String(name).toLowerCase()] = raw;
				}
				const derivedValues = [];
				for (const p of parsed) {
					let v = null;
					try {
						v = __kustoEvalRpn(p.rpn, env);
					} catch {
						v = null;
					}
					derivedValues.push(v);
					// Make derived columns available to subsequent expressions
					const dn = String(p.name || '').trim();
					if (dn) {
						env[dn] = v;
						env[dn.toLowerCase()] = v;
					}
				}
				outRows.push(baseRawRow.concat(derivedValues));
			}

			_win.displayResultForBox({ columns: outCols, rows: outRows, metadata: { transformationType: 'derive' } }, id, { label: 'Transformations', showExecutionTime: false });
			try {
				const wrapper = document.getElementById(id + '_results_wrapper') as any;
				if (wrapper) wrapper.style.display = '';
			} catch { /* ignore */ }
			try { __kustoEnsureTransformationAutoExpandWhenResultsAppear(id); } catch { /* ignore */ }
			try { setTimeout(() => { try { __kustoMaybeAutoFitTransformationBox(id); } catch { /* ignore */ } }, 0); } catch { /* ignore */ }
			return;
		}

		if (type === 'summarize') {
			const groupBy = Array.isArray(st.groupByColumns) ? st.groupByColumns.map((c: any) => String(c)).filter((c: any) => c) : [];
			const aggs = Array.isArray(st.aggregations) ? st.aggregations : [];
			if (!aggs.length) {
				__kustoRenderTransformationError(id, 'Add one or more aggregations.');
				return;
			}
			const groups = new Map();
			for (const r of rows) {
				const row = Array.isArray(r) ? r : [];
				const gvals = groupBy.map((c: any) => {
					const idx = colIndex[String(c)] ?? colIndex[String(c).toLowerCase()];
					return __kustoGetRawCellValueForTransform(row[idx]);
				});
				const key = JSON.stringify(gvals);
				let g = groups.get(key);
				if (!g) {
					g = { gvals, acc: [] };
					for (const a of aggs) {
						g.acc.push({ fn: String((a && a.function) || 'count'), col: String((a && a.column) || ''), count: 0, sum: 0, numCount: 0, min: null, max: null, distinct: new Set() });
					}
					groups.set(key, g);
				}
				for (let i = 0; i < g.acc.length; i++) {
					const a = g.acc[i];
					const fn = String(a.fn || 'count');
					if (fn === 'count') {
						a.count++;
						continue;
					}
					const idx = colIndex[String(a.col)] ?? colIndex[String(a.col).toLowerCase()];
					const raw = __kustoGetRawCellValueForTransform(row[idx]);
					if (fn === 'distinct') {
						a.distinct.add(String(raw));
						continue;
					}
					if (fn === 'sum' || fn === 'avg') {
						const n = __kustoTryParseFiniteNumber(raw);
						if (n !== null) {
							a.sum += n;
							a.numCount++;
						}
						continue;
					}
					if (fn === 'min' || fn === 'max') {
						const n = __kustoTryParseFiniteNumber(raw);
						const v = (n !== null) ? n : (raw === null || raw === undefined ? null : String(raw));
						if (v === null) continue;
						if (fn === 'min') {
							if (a.min === null || v < a.min) a.min = v;
						} else {
							if (a.max === null || v > a.max) a.max = v;
						}
						continue;
					}
				}
			}
			const outCols = [];
			for (const c of groupBy) outCols.push(String(c));
			for (const a of aggs) {
				const fn = String((a && a.function) || 'count');
				const col = String((a && a.column) || '');
				const custom = String((a && a.name) || '').trim();
				const fallback = (fn === 'count') ? 'count()' : (fn + '(' + col + ')');
				outCols.push(String(custom || fallback));
			}
			const outRows: any[] = [];
			for (const g of groups.values()) {
				const rowOut: any[] = [].concat(g.gvals);
				for (const a of g.acc) {
					const fn = String(a.fn || 'count');
					if (fn === 'count') rowOut.push(a.count);
					else if (fn === 'sum') rowOut.push(a.sum);
					else if (fn === 'avg') rowOut.push(a.numCount ? (a.sum / a.numCount) : null);
					else if (fn === 'min') rowOut.push(a.min);
					else if (fn === 'max') rowOut.push(a.max);
					else if (fn === 'distinct') rowOut.push(a.distinct.size);
					else rowOut.push(null);
				}
				outRows.push(rowOut);
			}
			_win.displayResultForBox({ columns: outCols, rows: outRows, metadata: { transformationType: 'summarize' } }, id, { label: 'Transformations', showExecutionTime: false });
			try {
				const wrapper = document.getElementById(id + '_results_wrapper') as any;
				if (wrapper) wrapper.style.display = '';
			} catch { /* ignore */ }
			try { __kustoEnsureTransformationAutoExpandWhenResultsAppear(id); } catch { /* ignore */ }
			try { setTimeout(() => { try { __kustoMaybeAutoFitTransformationBox(id); } catch { /* ignore */ } }, 0); } catch { /* ignore */ }
			return;
		}

		if (type === 'pivot') {
			const rowKey = String(st.pivotRowKeyColumn || '');
			const colKey = String(st.pivotColumnKeyColumn || '');
			const valKey = String(st.pivotValueColumn || '');
			const agg = String(st.pivotAggregation || 'sum');
			const maxCols = (typeof st.pivotMaxColumns === 'number' && Number.isFinite(st.pivotMaxColumns)) ? Math.max(1, Math.min(500, Math.floor(st.pivotMaxColumns))) : 100;
			if (!rowKey || !colKey) {
				__kustoRenderTransformationError(id, 'Pick Row key and Column key.');
				return;
			}
			if (agg !== 'count' && !valKey) {
				__kustoRenderTransformationError(id, 'Pick a Value column (or switch aggregation to count).');
				return;
			}
			const rowIdx = colIndex[rowKey] ?? colIndex[rowKey.toLowerCase()];
			const colIdx = colIndex[colKey] ?? colIndex[colKey.toLowerCase()];
			const valIdx = colIndex[valKey] ?? colIndex[valKey.toLowerCase()];
			const pivotCols = [];
			const pivotColSet = new Set();
			const table = new Map(); // rowKeyVal -> Map(colKeyVal -> acc)
			const rowOrder = [];
			const rowSeen = new Set();
			for (const r of rows) {
				const row = Array.isArray(r) ? r : [];
				const rk = __kustoGetRawCellValueForTransform(row[rowIdx]);
				const ck = __kustoGetRawCellValueForTransform(row[colIdx]);
				const ckStr = String(ck ?? '');
				if (!pivotColSet.has(ckStr)) {
					pivotColSet.add(ckStr);
					pivotCols.push(ckStr);
					if (pivotCols.length > maxCols) {
						__kustoRenderTransformationError(id, 'Pivot would create too many columns (' + pivotCols.length + '+). Increase Max columns or choose a different column key.');
						return;
					}
				}
				const rkStr = String(rk ?? '');
				if (!rowSeen.has(rkStr)) {
					rowSeen.add(rkStr);
					rowOrder.push(rkStr);
				}
				let rowMap = table.get(rkStr);
				if (!rowMap) {
					rowMap = new Map();
					table.set(rkStr, rowMap);
				}
				let acc = rowMap.get(ckStr);
				if (!acc) {
					acc = { count: 0, sum: 0, numCount: 0, first: null };
					rowMap.set(ckStr, acc);
				}
				acc.count++;
				if (agg === 'count') continue;
				const raw = __kustoGetRawCellValueForTransform(row[valIdx]);
				if (agg === 'first') {
					if (acc.first === null) acc.first = raw;
					continue;
				}
				const n = __kustoTryParseFiniteNumber(raw);
				if (n !== null) {
					acc.sum += n;
					acc.numCount++;
				}
			}
			const outCols = [String(rowKey)].concat(pivotCols.map((c: any) => String(c)));
			const outRows: any[] = [];
			for (const rk of rowOrder) {
				const rm = table.get(rk) || new Map();
				const out: any[] = [rk];
				for (const ck of pivotCols) {
					const acc = rm.get(ck);
					if (!acc) { out.push(null); continue; }
					if (agg === 'count') out.push(acc.count);
					else if (agg === 'first') out.push(acc.first);
					else if (agg === 'avg') out.push(acc.numCount ? (acc.sum / acc.numCount) : null);
					else out.push(acc.sum);
				}
				outRows.push(out);
			}
			_win.displayResultForBox({ columns: outCols, rows: outRows, metadata: { transformationType: 'pivot' } }, id, { label: 'Transformations', showExecutionTime: false });
			try {
				const wrapper = document.getElementById(id + '_results_wrapper') as any;
				if (wrapper) wrapper.style.display = '';
			} catch { /* ignore */ }
			try { __kustoEnsureTransformationAutoExpandWhenResultsAppear(id); } catch { /* ignore */ }
			try { setTimeout(() => { try { __kustoMaybeAutoFitTransformationBox(id); } catch { /* ignore */ } }, 0); } catch { /* ignore */ }
			return;
		}

		if (type === 'distinct') {
			const col = String(st.distinctColumn || '');
			if (!col) {
				__kustoRenderTransformationError(id, 'Pick a column.');
				return;
			}
			const idx = colIndex[String(col)] ?? colIndex[String(col).toLowerCase()];
			if (typeof idx !== 'number' || !Number.isFinite(idx)) {
				__kustoRenderTransformationError(id, 'Pick a valid column.');
				return;
			}
			const seen = new Set();
			const outRows: any[] = [];
			const makeKey = (v: any) => {
				try {
					if (v === null) return 'null';
					if (typeof v === 'undefined') return 'undefined';
					const t = typeof v;
					if (t === 'number' || t === 'boolean' || t === 'bigint') return t[0] + ':' + String(v);
					if (t === 'string') return 's:' + v;
					return 'o:' + JSON.stringify(v);
				} catch {
					return 'o:' + String(v);
				}
			};
			for (const r of rows) {
				const row = Array.isArray(r) ? r : [];
				const raw = __kustoGetRawCellValueForTransform(row[idx]);
				const key = makeKey(raw);
				if (seen.has(key)) continue;
				seen.add(key);
				outRows.push([raw]);
			}
			_win.displayResultForBox({ columns: [col], rows: outRows, metadata: { transformationType: 'distinct' } }, id, { label: 'Transformations', showExecutionTime: false });
			try {
				const wrapper = document.getElementById(id + '_results_wrapper') as any;
				if (wrapper) wrapper.style.display = '';
			} catch { /* ignore */ }
			try { __kustoEnsureTransformationAutoExpandWhenResultsAppear(id); } catch { /* ignore */ }
			try { setTimeout(() => { try { __kustoMaybeAutoFitTransformationBox(id); } catch { /* ignore */ } }, 0); } catch { /* ignore */ }
			return;
		}

		__kustoRenderTransformationError(id, 'Unknown transformation type.');
	} catch (e: any) {
		__kustoRenderTransformationError(id, (e && e.message) ? e.message : String(e || 'Failed to compute transformation.'));
	}
}

function __kustoEnsureTransformationAutoExpandWhenResultsAppear( boxId: any) {
	try {
		const id = String(boxId || '');
		if (!id) return;
		const wrapper = document.getElementById(id + '_tf_wrapper') as any;
		if (!wrapper) return;
		// If the user hasn't manually resized this section, mirror query-box behavior:
		// when results appear, expand to fit so they're visible.
		const userResized = !!(wrapper.dataset && wrapper.dataset.kustoUserResized === 'true');
		if (userResized) return;
		try { wrapper.dataset.kustoAutoFitActive = 'true'; } catch { /* ignore */ }
	} catch { /* ignore */ }
}

// Hook into the shared results visibility toggle so Transformations shrink/grow like query boxes.
try {
	const prev = (typeof (window as any).__kustoOnResultsVisibilityToggled === 'function') ? (window as any).__kustoOnResultsVisibilityToggled : null;
	(window as any).__kustoOnResultsVisibilityToggled = (boxId: any) => {
		try { if (prev) prev(boxId); } catch { /* ignore */ }
		try {
			const id = String(boxId || '');
			if (!id) return;
			// Only handle Transformations boxes.
			if (!transformationStateByBoxId || !transformationStateByBoxId[id]) return;
			const wrapper = document.getElementById(id + '_tf_wrapper') as any;
			if (!wrapper) return;
			let visible = true;
			try {
				visible = !((window as any).__kustoResultsVisibleByBoxId && (window as any).__kustoResultsVisibleByBoxId[id] === false);
			} catch { /* ignore */ }
			if (!visible) {
				// Mirror query-box collapse: hug content when results hidden.
				try { wrapper.dataset.kustoAutoFitActive = 'false'; } catch { /* ignore */ }
				try {
					if (wrapper.style && typeof wrapper.style.height === 'string' && wrapper.style.height && wrapper.style.height !== 'auto') {
						wrapper.dataset.kustoPrevHeight = wrapper.style.height;
					}
				} catch { /* ignore */ }
				try { wrapper.style.height = 'auto'; } catch { /* ignore */ }
				return;
			}
			// Showing results again: restore previous height if any; otherwise auto-expand.
			try {
				const prevH = (wrapper.dataset && wrapper.dataset.kustoPrevHeight) ? String(wrapper.dataset.kustoPrevHeight) : '';
				if (prevH && prevH !== 'auto') {
					wrapper.style.height = prevH;
				}
			} catch { /* ignore */ }
			try { wrapper.dataset.kustoAutoFitActive = 'true'; } catch { /* ignore */ }
			try { setTimeout(() => { try { __kustoMaybeAutoFitTransformationBox(id); } catch { /* ignore */ } }, 0); } catch { /* ignore */ }
		} catch { /* ignore */ }
	};
} catch { /* ignore */ }

function addTransformationBox( options: any) {
	const id = (options && options.id) ? String(options.id) : ('transformation_' + Date.now());
	transformationBoxes.push(id);
	const st = __kustoGetTransformationState(id);
	st.mode = (options && typeof options.mode === 'string' && String(options.mode).toLowerCase() === 'preview') ? 'preview' : 'edit';
	st.expanded = (options && typeof options.expanded === 'boolean') ? !!options.expanded : true;
	st.dataSourceId = (options && typeof options.dataSourceId === 'string') ? String(options.dataSourceId) : (st.dataSourceId || '');
	st.transformationType = (options && typeof options.transformationType === 'string') ? String(options.transformationType) : (st.transformationType || 'derive');
	st.distinctColumn = (options && typeof options.distinctColumn === 'string') ? String(options.distinctColumn) : (st.distinctColumn || '');
	st.deriveColumns = (options && Array.isArray(options.deriveColumns)) ? options.deriveColumns : (Array.isArray(st.deriveColumns) ? st.deriveColumns : [{ name: '', expression: '' }]);
	// Back-compat: if options provides legacy single derive, merge it if deriveColumns not provided.
	try {
		if ((!options || !Array.isArray(options.deriveColumns)) && options && (typeof options.deriveColumnName === 'string' || typeof options.deriveExpression === 'string')) {
			const n = (typeof options.deriveColumnName === 'string') ? String(options.deriveColumnName) : '';
			const e = (typeof options.deriveExpression === 'string') ? String(options.deriveExpression) : '';
			st.deriveColumns = [{ name: n, expression: e }];
		}
	} catch { /* ignore */ }
	// Keep legacy fields in sync (used by older persistence/safety nets)
	try {
		const first = Array.isArray(st.deriveColumns) && st.deriveColumns.length ? st.deriveColumns[0] : { name: '', expression: '' };
		st.deriveColumnName = String((first && first.name) || '');
		st.deriveExpression = String((first && first.expression) || '');
	} catch { /* ignore */ }
	st.groupByColumns = (options && Array.isArray(options.groupByColumns)) ? options.groupByColumns.filter((c: any) => c) : (Array.isArray(st.groupByColumns) ? st.groupByColumns : []);
	st.aggregations = (options && Array.isArray(options.aggregations)) ? options.aggregations : (Array.isArray(st.aggregations) ? st.aggregations : [{ function: 'count', column: '' }]);
	st.pivotRowKeyColumn = (options && typeof options.pivotRowKeyColumn === 'string') ? String(options.pivotRowKeyColumn) : (st.pivotRowKeyColumn || '');
	st.pivotColumnKeyColumn = (options && typeof options.pivotColumnKeyColumn === 'string') ? String(options.pivotColumnKeyColumn) : (st.pivotColumnKeyColumn || '');
	st.pivotValueColumn = (options && typeof options.pivotValueColumn === 'string') ? String(options.pivotValueColumn) : (st.pivotValueColumn || '');
	st.pivotAggregation = (options && typeof options.pivotAggregation === 'string') ? String(options.pivotAggregation) : (st.pivotAggregation || 'sum');
	st.pivotMaxColumns = (options && typeof options.pivotMaxColumns === 'number' && Number.isFinite(options.pivotMaxColumns)) ? options.pivotMaxColumns : (typeof st.pivotMaxColumns === 'number' ? st.pivotMaxColumns : 100);

	const container = document.getElementById('queries-container') as any;
	if (!container) {
		return;
	}

	// ── Create Lit element as primary ──
	const litEl = document.createElement('kw-transformation-section');
	litEl.id = id;
	litEl.setAttribute('box-id', id);

	// Apply options to the Lit element
	if (typeof litEl.applyOptions === 'function') {
		litEl.applyOptions(options || {});
	}

	// Listen for section-remove event
	litEl.addEventListener('section-remove', (e: any) => {
		try {
			const detail = e && e.detail ? e.detail : {};
			const removeId = detail.boxId || id;
			removeTransformationBox(removeId);
		} catch { /* ignore */ }
	});

	container.insertAdjacentElement('beforeend', litEl);

	return id;
}

// ── Window bridges for remaining legacy callers ──
(window as any).__kustoNormalizeLegendPosition = __kustoNormalizeLegendPosition;
(window as any).__kustoUpdateLegendPositionButtonUI = __kustoUpdateLegendPositionButtonUI;
(window as any).__kustoOnChartLegendPositionClicked = __kustoOnChartLegendPositionClicked;
(window as any).__kustoFormatNumber = __kustoFormatNumber;
(window as any).__kustoComputeAxisFontSize = __kustoComputeAxisFontSize;
(window as any).__kustoGetChartState = __kustoGetChartState;
(window as any).__kustoGetDefaultAxisSettings = __kustoGetDefaultAxisSettings;
(window as any).__kustoHasCustomAxisSettings = __kustoHasCustomAxisSettings;
(window as any).__kustoGetDefaultYAxisSettings = __kustoGetDefaultYAxisSettings;
(window as any).__kustoHasCustomYAxisSettings = __kustoHasCustomYAxisSettings;
(window as any).__kustoUpdateSeriesColorsUI = __kustoUpdateSeriesColorsUI;
(window as any).__kustoOnSeriesColorChanged = __kustoOnSeriesColorChanged;
(window as any).__kustoResetSeriesColor = __kustoResetSeriesColor;
(window as any).__kustoToggleAxisSettingsPopup = __kustoToggleAxisSettingsPopup;
(window as any).__kustoCloseAxisSettingsPopup = __kustoCloseAxisSettingsPopup;
(window as any).__kustoCloseAllAxisSettingsPopups = __kustoCloseAllAxisSettingsPopups;
(window as any).__kustoToggleLabelSettingsPopup = __kustoToggleLabelSettingsPopup;
(window as any).__kustoCloseLabelSettingsPopup = __kustoCloseLabelSettingsPopup;
(window as any).__kustoSyncLabelSettingsUI = __kustoSyncLabelSettingsUI;
(window as any).__kustoHasCustomLabelSettings = __kustoHasCustomLabelSettings;
(window as any).__kustoUpdateLabelSettingsIndicator = __kustoUpdateLabelSettingsIndicator;
(window as any).__kustoSyncAxisSettingsUI = __kustoSyncAxisSettingsUI;
(window as any).__kustoUpdateAxisLabelIndicator = __kustoUpdateAxisLabelIndicator;
(window as any).__kustoOnAxisSettingChanged = __kustoOnAxisSettingChanged;
(window as any).__kustoResetAxisSettings = __kustoResetAxisSettings;
(window as any).__kustoGetChartMinResizeHeight = __kustoGetChartMinResizeHeight;
(window as any).__kustoGetChartDatasetsInDomOrder = __kustoGetChartDatasetsInDomOrder;
(window as any).__kustoConfigureChartFromTool = __kustoConfigureChartFromTool;
(window as any).__kustoConfigureTransformationFromTool = __kustoConfigureTransformationFromTool;
(window as any).__kustoGetRawCellValueForChart = __kustoGetRawCellValueForChart;
(window as any).__kustoCellToChartString = __kustoCellToChartString;
(window as any).__kustoCellToChartNumber = __kustoCellToChartNumber;
(window as any).__kustoCellToChartTimeMs = __kustoCellToChartTimeMs;
(window as any).__kustoInferTimeXAxisFromRows = __kustoInferTimeXAxisFromRows;
(window as any).__kustoNormalizeResultsColumnName = __kustoNormalizeResultsColumnName;
(window as any).__kustoSetSelectOptions = __kustoSetSelectOptions;
(window as any).__kustoPickFirstNonEmpty = __kustoPickFirstNonEmpty;
(window as any).__kustoUpdateChartBuilderUI = __kustoUpdateChartBuilderUI;
(window as any).__kustoGetChartActiveCanvasElementId = __kustoGetChartActiveCanvasElementId;
(window as any).__kustoGetIsDarkThemeForEcharts = __kustoGetIsDarkThemeForEcharts;
(window as any).__kustoFormatUtcDateTime = __kustoFormatUtcDateTime;
(window as any).__kustoComputeTimePeriodGranularity = __kustoComputeTimePeriodGranularity;
(window as any).__kustoFormatTimePeriodLabel = __kustoFormatTimePeriodLabel;
(window as any).__kustoGenerateContinuousTimeLabels = __kustoGenerateContinuousTimeLabels;
(window as any).__kustoShouldShowTimeForUtcAxis = __kustoShouldShowTimeForUtcAxis;
(window as any).__kustoComputeTimeAxisLabelRotation = __kustoComputeTimeAxisLabelRotation;
(window as any).__kustoComputeCategoryLabelRotation = __kustoComputeCategoryLabelRotation;
(window as any).__kustoMeasureLabelChars = __kustoMeasureLabelChars;
(window as any).__kustoRefreshChartsForThemeChange = __kustoRefreshChartsForThemeChange;
(window as any).__kustoStartEchartsThemeObserver = __kustoStartEchartsThemeObserver;
(window as any).__kustoDisposeChartEcharts = __kustoDisposeChartEcharts;
(window as any).__kustoRenderChart = __kustoRenderChart;
(window as any).__kustoUpdateChartModeButtons = __kustoUpdateChartModeButtons;
(window as any).__kustoApplyChartMode = __kustoApplyChartMode;
(window as any).__kustoSetChartMode = __kustoSetChartMode;
(window as any).__kustoUpdateChartVisibilityToggleButton = __kustoUpdateChartVisibilityToggleButton;
(window as any).__kustoApplyChartBoxVisibility = __kustoApplyChartBoxVisibility;
(window as any).toggleChartBoxVisibility = toggleChartBoxVisibility;
(window as any).__kustoMaximizeChartBox = __kustoMaximizeChartBox;
(window as any).__kustoAutoFitChartIfClipped = __kustoAutoFitChartIfClipped;
(window as any).addChartBox = addChartBox;
(window as any).__kustoOnChartDataSourceChanged = __kustoOnChartDataSourceChanged;
(window as any).__kustoOnChartTypeChanged = __kustoOnChartTypeChanged;
(window as any).__kustoSelectChartType = __kustoSelectChartType;
(window as any).__kustoOnChartLabelsToggled = __kustoOnChartLabelsToggled;
(window as any).__kustoOnChartLabelModeChanged = __kustoOnChartLabelModeChanged;
(window as any).__kustoOnChartLabelDensityChanged = __kustoOnChartLabelDensityChanged;
(window as any).__kustoOnChartMappingChanged = __kustoOnChartMappingChanged;
(window as any).__kustoOnChartYCheckboxChanged = __kustoOnChartYCheckboxChanged;
(window as any).__kustoOnChartTooltipCheckboxChanged = __kustoOnChartTooltipCheckboxChanged;
(window as any).__kustoOnChartFunnelSortChanged = __kustoOnChartFunnelSortChanged;
(window as any).__kustoOnChartFunnelSortDirToggle = __kustoOnChartFunnelSortDirToggle;
(window as any).__kustoUpdateFunnelSortUI = __kustoUpdateFunnelSortUI;
(window as any).removeChartBox = removeChartBox;
(window as any).__kustoTryApplyPendingMarkdownReveal = __kustoTryApplyPendingMarkdownReveal;
(window as any).__kustoIsDarkTheme = __kustoIsDarkTheme;
(window as any).__kustoApplyToastUiThemeToHost = __kustoApplyToastUiThemeToHost;
(window as any).__kustoApplyToastUiThemeAll = __kustoApplyToastUiThemeAll;
(window as any).__kustoStartToastUiThemeObserver = __kustoStartToastUiThemeObserver;
(window as any).__kustoMaximizeMarkdownBox = __kustoMaximizeMarkdownBox;
(window as any).__kustoAutoExpandMarkdownBoxToContent = __kustoAutoExpandMarkdownBoxToContent;
(window as any).__kustoScheduleMdAutoExpand = __kustoScheduleMdAutoExpand;
(window as any).__kustoMaximizePythonBox = __kustoMaximizePythonBox;
(window as any).__kustoEnsureMarkdownModeMap = __kustoEnsureMarkdownModeMap;
(window as any).__kustoGetMarkdownMode = __kustoGetMarkdownMode;
(window as any).__kustoSetMarkdownMode = __kustoSetMarkdownMode;
(window as any).__kustoUpdateMarkdownModeButtons = __kustoUpdateMarkdownModeButtons;
(window as any).__kustoToggleMdModeDropdown = __kustoToggleMdModeDropdown;
(window as any).__kustoCloseMdModeDropdown = __kustoCloseMdModeDropdown;
(window as any).__kustoUpdateMdModeResponsive = __kustoUpdateMdModeResponsive;
(window as any).__kustoSetupMdModeResizeObserver = __kustoSetupMdModeResizeObserver;
(window as any).__kustoCleanupMdModeResizeObserver = __kustoCleanupMdModeResizeObserver;
(window as any).__kustoToggleSectionModeDropdown = __kustoToggleSectionModeDropdown;
(window as any).__kustoCloseSectionModeDropdown = __kustoCloseSectionModeDropdown;
(window as any).__kustoUpdateSectionModeResponsive = __kustoUpdateSectionModeResponsive;
(window as any).__kustoSetupSectionModeResizeObserver = __kustoSetupSectionModeResizeObserver;
(window as any).__kustoCleanupSectionModeResizeObserver = __kustoCleanupSectionModeResizeObserver;
(window as any).__kustoUpdateMarkdownPreviewSizing = __kustoUpdateMarkdownPreviewSizing;
(window as any).__kustoApplyMarkdownEditorMode = __kustoApplyMarkdownEditorMode;
(window as any).isLikelyDarkTheme = isLikelyDarkTheme;
(window as any).getToastUiPlugins = getToastUiPlugins;
(window as any).ensureMarkedGlobal = ensureMarkedGlobal;
(window as any).addMarkdownBox = addMarkdownBox;
(window as any).__kustoAutoFitMarkdownBoxHeight = __kustoAutoFitMarkdownBoxHeight;
(window as any).removeMarkdownBox = removeMarkdownBox;
(window as any).__kustoUpdateMarkdownVisibilityToggleButton = __kustoUpdateMarkdownVisibilityToggleButton;
(window as any).__kustoApplyMarkdownBoxVisibility = __kustoApplyMarkdownBoxVisibility;
(window as any).toggleMarkdownBoxVisibility = toggleMarkdownBoxVisibility;
(window as any).initMarkdownViewer = initMarkdownViewer;
(window as any).initMarkdownEditor = initMarkdownEditor;
(window as any).__kustoRewriteToastUiImagesInContainer = __kustoRewriteToastUiImagesInContainer;
(window as any).addPythonBox = addPythonBox;
(window as any).removePythonBox = removePythonBox;
(window as any).initPythonEditor = initPythonEditor;
(window as any).setPythonOutput = setPythonOutput;
(window as any).runPythonBox = runPythonBox;
(window as any).onPythonResult = onPythonResult;
(window as any).onPythonError = onPythonError;
(window as any).addUrlBox = addUrlBox;
(window as any).removeUrlBox = removeUrlBox;
(window as any).__kustoShowExpressionHelpTooltip = __kustoShowExpressionHelpTooltip;
(window as any).__kustoHideExpressionHelpTooltip = __kustoHideExpressionHelpTooltip;
(window as any).__kustoHideExpressionHelpTooltipImmediate = __kustoHideExpressionHelpTooltipImmediate;
(window as any).__kustoGetTransformationState = __kustoGetTransformationState;
(window as any).__kustoGetTransformationMinResizeHeight = __kustoGetTransformationMinResizeHeight;
(window as any).__kustoUpdateTransformationModeButtons = __kustoUpdateTransformationModeButtons;
(window as any).__kustoApplyTransformationMode = __kustoApplyTransformationMode;
(window as any).__kustoSetTransformationMode = __kustoSetTransformationMode;
(window as any).__kustoUpdateTransformationVisibilityToggleButton = __kustoUpdateTransformationVisibilityToggleButton;
(window as any).__kustoApplyTransformationBoxVisibility = __kustoApplyTransformationBoxVisibility;
(window as any).toggleTransformationBoxVisibility = toggleTransformationBoxVisibility;
(window as any).__kustoMaximizeTransformationBox = __kustoMaximizeTransformationBox;
(window as any).__kustoComputeTransformationFitHeightPx = __kustoComputeTransformationFitHeightPx;
(window as any).__kustoMaybeAutoFitTransformationBox = __kustoMaybeAutoFitTransformationBox;
(window as any).removeTransformationBox = removeTransformationBox;
(window as any).__kustoSetTransformationType = __kustoSetTransformationType;
(window as any).__kustoOnTransformationDataSourceChanged = __kustoOnTransformationDataSourceChanged;
(window as any).__kustoSetCheckboxDropdownText = __kustoSetCheckboxDropdownText;
(window as any).__kustoBuildCheckboxMenuHtml = __kustoBuildCheckboxMenuHtml;
(window as any).__kustoToggleGroupByColumn = __kustoToggleGroupByColumn;
(window as any).__kustoUpdateTransformationBuilderUI = __kustoUpdateTransformationBuilderUI;
(window as any).__kustoOnTransformationDistinctChanged = __kustoOnTransformationDistinctChanged;
(window as any).__kustoOnTransformationAggChanged = __kustoOnTransformationAggChanged;
(window as any).__kustoAddTransformationAgg = __kustoAddTransformationAgg;
(window as any).__kustoRemoveTransformationAgg = __kustoRemoveTransformationAgg;
(window as any).__kustoOnGroupByColumnChanged = __kustoOnGroupByColumnChanged;
(window as any).__kustoAddGroupByColumn = __kustoAddGroupByColumn;
(window as any).__kustoRemoveGroupByColumn = __kustoRemoveGroupByColumn;
(window as any).__kustoOnGroupByDragStart = __kustoOnGroupByDragStart;
(window as any).__kustoClearGroupByDropIndicators = __kustoClearGroupByDropIndicators;
(window as any).__kustoOnGroupByDragOver = __kustoOnGroupByDragOver;
(window as any).__kustoOnGroupByDragEnd = __kustoOnGroupByDragEnd;
(window as any).__kustoOnGroupByDrop = __kustoOnGroupByDrop;
(window as any).__kustoOnAggDragStart = __kustoOnAggDragStart;
(window as any).__kustoClearAggDropIndicators = __kustoClearAggDropIndicators;
(window as any).__kustoOnAggDragOver = __kustoOnAggDragOver;
(window as any).__kustoOnAggDrop = __kustoOnAggDrop;
(window as any).__kustoOnAggDragEnd = __kustoOnAggDragEnd;
(window as any).__kustoOnCalculatedColumnChanged = __kustoOnCalculatedColumnChanged;
(window as any).__kustoAddCalculatedColumn = __kustoAddCalculatedColumn;
(window as any).__kustoRemoveCalculatedColumn = __kustoRemoveCalculatedColumn;
(window as any).__kustoOnDeriveDragStart = __kustoOnDeriveDragStart;
(window as any).__kustoClearDeriveDropIndicators = __kustoClearDeriveDropIndicators;
(window as any).__kustoOnDeriveDragOver = __kustoOnDeriveDragOver;
(window as any).__kustoOnDeriveDrop = __kustoOnDeriveDrop;
(window as any).__kustoOnDeriveDragEnd = __kustoOnDeriveDragEnd;
(window as any).__kustoOnTransformationPivotChanged = __kustoOnTransformationPivotChanged;
(window as any).__kustoTryParseFiniteNumber = __kustoTryParseFiniteNumber;
(window as any).__kustoTryParseDate = __kustoTryParseDate;
(window as any).__kustoFormatDate = __kustoFormatDate;
(window as any).__kustoGetRawCellValueForTransform = __kustoGetRawCellValueForTransform;
(window as any).__kustoTokenizeExpr = __kustoTokenizeExpr;
(window as any).__kustoParseExprToRpn = __kustoParseExprToRpn;
(window as any).__kustoEvalRpn = __kustoEvalRpn;
(window as any).__kustoRenderTransformationError = __kustoRenderTransformationError;
(window as any).__kustoRenderTransformation = __kustoRenderTransformation;
(window as any).__kustoEnsureTransformationAutoExpandWhenResultsAppear = __kustoEnsureTransformationAutoExpandWhenResultsAppear;
(window as any).addTransformationBox = addTransformationBox;
