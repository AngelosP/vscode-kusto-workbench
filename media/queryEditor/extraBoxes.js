// Additional section types for the Kusto Query Editor webview:
// - Markdown: Monaco editor while focused; rendered markdown viewer on blur
// - Python: Monaco editor + Run button; output viewer
// - URL: URL input + expand/collapse content viewer; content fetched by extension host

let markdownBoxes = [];
let pythonBoxes = [];
let urlBoxes = [];
let chartBoxes = [];

let markdownEditors = {};
let markdownViewers = {};
let pythonEditors = {};

// Chart UI state keyed by boxId.
// - mode: 'edit' | 'preview'
// - expanded: boolean (show/hide)
// - dataSourceId: boxId of the data source section
// - chartType: 'line' | 'area' | 'bar' | 'scatter' | 'pie'
// - xColumn/yColumn: for line/area/bar/scatter
// - labelColumn/valueColumn: for pie
// - showDataLabels: boolean (show labels on data points)
let chartStateByBoxId = {};

// SVG icons for chart types
const __kustoChartTypeIcons = {
	line: '<svg viewBox="0 0 32 32" width="32" height="32" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4,24 10,16 16,20 22,8 28,12"/></svg>',
	area: '<svg viewBox="0 0 32 32" width="32" height="32" fill="currentColor" fill-opacity="0.3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4,24 L10,16 L16,20 L22,8 L28,12 L28,28 L4,28 Z"/></svg>',
	bar: '<svg viewBox="0 0 32 32" width="32" height="32" fill="currentColor" fill-opacity="0.7"><rect x="4" y="16" width="5" height="12" rx="1"/><rect x="11" y="10" width="5" height="18" rx="1"/><rect x="18" y="14" width="5" height="14" rx="1"/><rect x="25" y="6" width="5" height="22" rx="1"/></svg>',
	scatter: '<svg viewBox="0 0 32 32" width="32" height="32" fill="currentColor"><circle cx="8" cy="20" r="2.5"/><circle cx="14" cy="12" r="2.5"/><circle cx="20" cy="18" r="2.5"/><circle cx="26" cy="8" r="2.5"/><circle cx="11" cy="24" r="2.5"/><circle cx="23" cy="22" r="2.5"/></svg>',
	pie: '<svg viewBox="0 0 32 32" width="32" height="32" fill="none" stroke="currentColor" stroke-width="2"><circle cx="16" cy="16" r="12" fill="currentColor" fill-opacity="0.2"/><path d="M16,16 L16,4 A12,12 0 0,1 27.2,20.8 Z" fill="currentColor" fill-opacity="0.5"/><path d="M16,16 L27.2,20.8 A12,12 0 0,1 8,25.6 Z" fill="currentColor" fill-opacity="0.7"/></svg>'
};

const __kustoChartTypeLabels = {
	line: 'Line',
	area: 'Area',
	bar: 'Bar',
	scatter: 'Scatter',
	pie: 'Pie'
};

function __kustoFormatNumber(value) {
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

function __kustoComputeAxisFontSize(labelCount, axisPixelWidth, isYAxis) {
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

function __kustoGetChartState(boxId) {
	try {
		const id = String(boxId || '');
		if (!id) return { mode: 'edit', expanded: true };
		if (!chartStateByBoxId || typeof chartStateByBoxId !== 'object') {
			chartStateByBoxId = {};
		}
		if (!chartStateByBoxId[id] || typeof chartStateByBoxId[id] !== 'object') {
			chartStateByBoxId[id] = { mode: 'edit', expanded: true };
		}
		return chartStateByBoxId[id];
	} catch {
		return { mode: 'edit', expanded: true };
	}
}

function __kustoGetChartDatasetsInDomOrder() {
	const out = [];
	try {
		const container = document.getElementById('queries-container');
		const children = container ? Array.from(container.children || []) : [];
		for (const child of children) {
			try {
				const id = child && child.id ? String(child.id) : '';
				if (!id) continue;
				if (!(id.startsWith('query_') || id.startsWith('url_'))) continue;
				if (typeof __kustoGetResultsState !== 'function') continue;
				const st = __kustoGetResultsState(id);
				const cols = st && Array.isArray(st.columns) ? st.columns : [];
				const rows = st && Array.isArray(st.rows) ? st.rows : [];
				if (!cols.length) continue;
				let name = '';
				try {
					name = String(((document.getElementById(id + '_name') || {}).value || '')).trim();
				} catch { /* ignore */ }
				const label = name ? name : id;
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

function __kustoGetRawCellValueForChart(cell) {
	try {
		if (typeof __kustoGetRawCellValue === 'function') {
			return __kustoGetRawCellValue(cell);
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

function __kustoCellToChartString(cell) {
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

function __kustoCellToChartNumber(cell) {
	try {
		const raw = __kustoGetRawCellValueForChart(cell);
		if (typeof __kustoTryParseNumber === 'function') {
			return __kustoTryParseNumber(raw);
		}
		const n = (typeof raw === 'number') ? raw : Number(raw);
		return Number.isFinite(n) ? n : null;
	} catch {
		return null;
	}
}

function __kustoCellToChartTimeMs(cell) {
	try {
		const raw = __kustoGetRawCellValueForChart(cell);
		if (typeof __kustoTryParseDateMs === 'function') {
			return __kustoTryParseDateMs(raw);
		}
		const t = Date.parse(String(raw || ''));
		return Number.isFinite(t) ? t : null;
	} catch {
		return null;
	}
}

function __kustoInferTimeXAxisFromRows(rows, xIndex) {
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

function __kustoNormalizeResultsColumnName(c) {
	try {
		if (typeof c === 'string') return c;
		if (c && typeof c === 'object') {
			if (typeof c.name === 'string') return c.name;
			if (typeof c.columnName === 'string') return c.columnName;
		}
	} catch { /* ignore */ }
	return '';
}

function __kustoSetSelectOptions(selectEl, values, selectedValue, labelMap) {
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
			const escVal = (typeof escapeHtml === 'function') ? escapeHtml(s) : s;
			const escLabel = (typeof escapeHtml === 'function') ? escapeHtml(labelText) : labelText;
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

function __kustoPickFirstNonEmpty(arr) {
	try {
		for (const v of (arr || [])) {
			const s = String(v || '');
			if (s) return s;
		}
	} catch { /* ignore */ }
	return '';
}

function __kustoUpdateChartBuilderUI(boxId) {
	const id = String(boxId || '');
	if (!id) return;
	const st = __kustoGetChartState(id);
	const datasets = __kustoGetChartDatasetsInDomOrder();
	const dsSelect = document.getElementById(id + '_chart_ds');
	try {
		if (dsSelect) {
			let html = '<option value="">(select)</option>';
			for (const ds of datasets) {
				const value = String(ds.id || '');
				const label = String(ds.label || value);
				const escValue = (typeof escapeHtml === 'function') ? escapeHtml(value) : value;
				const escLabel = (typeof escapeHtml === 'function') ? escapeHtml(label) : label;
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
	try { window.__kustoDropdown.syncSelectBackedDropdown(id + '_chart_ds'); } catch { /* ignore */ }

	// Update chart type picker selection (visual buttons)
	try {
		const picker = document.getElementById(id + '_chart_type_picker');
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

	// Update data labels toggle checkbox
	try {
		const labelsCheckbox = document.getElementById(id + '_chart_labels');
		if (labelsCheckbox) labelsCheckbox.checked = !!st.showDataLabels;
		const labelsCheckboxPie = document.getElementById(id + '_chart_labels_pie');
		if (labelsCheckboxPie) labelsCheckboxPie.checked = !!st.showDataLabels;
	} catch { /* ignore */ }

	let ds = null;
	try {
		const desired = (typeof st.dataSourceId === 'string') ? st.dataSourceId : '';
		ds = datasets.find(d => String(d.id) === desired) || null;
	} catch { /* ignore */ }

	const colNames = (() => {
		try {
			const cols = ds && Array.isArray(ds.columns) ? ds.columns : [];
			return cols.map(__kustoNormalizeResultsColumnName).filter(Boolean);
		} catch {
			return [];
		}
	})();

	const mappingLineHost = document.getElementById(id + '_chart_mapping_xy');
	const mappingPieHost = document.getElementById(id + '_chart_mapping_pie');
	const chartType = (typeof st.chartType === 'string') ? String(st.chartType) : '';
	try {
		if (mappingLineHost) mappingLineHost.style.display = (chartType === 'line' || chartType === 'area' || chartType === 'bar' || chartType === 'scatter') ? '' : 'none';
		if (mappingPieHost) mappingPieHost.style.display = (chartType === 'pie') ? '' : 'none';
	} catch { /* ignore */ }

	// Populate X select.
	let desiredX = '';
	try { desiredX = String(((document.getElementById(id + '_chart_x') || {}).value || st.xColumn || '')).trim(); } catch { desiredX = String(st.xColumn || ''); }
	const xOptions = colNames.filter(c => c);
	__kustoSetSelectOptions(document.getElementById(id + '_chart_x'), xOptions, desiredX);
	// Sync the unified dropdown button text for X.
	try { window.__kustoDropdown.syncSelectBackedDropdown(id + '_chart_x'); } catch { /* ignore */ }

	// Populate Y checkbox dropdown (for line/area/bar).
	const yMenu = document.getElementById(id + '_chart_y_menu');
	if (yMenu) {
		const yOptions = colNames.filter(c => c && c !== desiredX);
		// Get currently selected Y columns from state.
		let desiredYCols = Array.isArray(st.yColumns) ? st.yColumns.filter(c => c) : [];
		// Fall back to single yColumn if no array.
		if (!desiredYCols.length && st.yColumn) {
			desiredYCols = [st.yColumn];
		}
		// Build checkbox items.
		const items = yOptions.map(c => ({
			key: c,
			label: c,
			checked: desiredYCols.includes(c)
		}));
		try {
			yMenu.innerHTML = window.__kustoDropdown.renderCheckboxItemsHtml(items, {
				dropdownId: id + '_chart_y',
				onChangeJs: '__kustoOnChartYCheckboxChanged'
			});
		} catch {
			yMenu.innerHTML = '<div class="kusto-dropdown-empty">No columns available.</div>';
		}
		// Update button text.
		const selected = desiredYCols.filter(c => yOptions.includes(c));
		try {
			window.__kustoDropdown.updateCheckboxButtonText(id + '_chart_y_text', selected, 'Select...');
		} catch { /* ignore */ }
	}

	// Legend dropdown: prepend "(none)" option for no legend grouping.
	const legendSelect = document.getElementById(id + '_chart_legend');
	if (legendSelect) {
		const legendOptions = ['', ...colNames.filter(c => c && c !== desiredX)];
		const yCount = (Array.isArray(st.yColumns) ? st.yColumns.filter(Boolean).length : 0) || (st.yColumn ? 1 : 0);
		const disableLegend = yCount > 1;
		if (disableLegend) {
			try { st.legendColumn = ''; } catch { /* ignore */ }
		}
		__kustoSetSelectOptions(legendSelect, legendOptions, disableLegend ? '' : ((typeof st.legendColumn === 'string') ? st.legendColumn : ''), { '': '(none)' });
		try { legendSelect.disabled = disableLegend; } catch { /* ignore */ }
		// Sync the unified dropdown button text and disabled state for Legend.
		try { window.__kustoDropdown.syncSelectBackedDropdown(id + '_chart_legend'); } catch { /* ignore */ }
		// Also sync the button's disabled state.
		try {
			const legendBtn = document.getElementById(id + '_chart_legend_btn');
			if (legendBtn) {
				legendBtn.disabled = disableLegend;
				legendBtn.setAttribute('aria-disabled', disableLegend ? 'true' : 'false');
			}
		} catch { /* ignore */ }
	}
	__kustoSetSelectOptions(document.getElementById(id + '_chart_label'), colNames, (typeof st.labelColumn === 'string') ? st.labelColumn : '');
	__kustoSetSelectOptions(document.getElementById(id + '_chart_value'), colNames, (typeof st.valueColumn === 'string') ? st.valueColumn : '');
	// Sync the unified dropdown button text for Label and Value.
	try { window.__kustoDropdown.syncSelectBackedDropdown(id + '_chart_label'); } catch { /* ignore */ }
	try { window.__kustoDropdown.syncSelectBackedDropdown(id + '_chart_value'); } catch { /* ignore */ }

	// Best-effort defaults once we have a dataset.
	try {
		if (colNames.length) {
			if ((chartType === 'line' || chartType === 'area' || chartType === 'bar' || chartType === 'scatter')) {
				if (!st.xColumn) st.xColumn = colNames[0] || '';
				// Prefer a distinct Y column.
				if ((!st.yColumns || !st.yColumns.length) && (!st.yColumn || st.yColumn === st.xColumn)) {
					st.yColumn = __kustoPickFirstNonEmpty(colNames.filter(c => c !== st.xColumn)) || '';
					st.yColumns = st.yColumn ? [st.yColumn] : [];
				}
			}
			if (chartType === 'pie') {
				if (!st.labelColumn) st.labelColumn = colNames[0] || '';
				if (!st.valueColumn) st.valueColumn = __kustoPickFirstNonEmpty(colNames.slice(1)) || colNames[0] || '';
			}
		}
	} catch { /* ignore */ }

	// Auto-fit if the chart canvas is being clipped after control changes.
	try { __kustoAutoFitChartIfClipped(id); } catch { /* ignore */ }
}

function __kustoGetChartActiveCanvasElementId(boxId) {
	const st = __kustoGetChartState(boxId);
	const mode = st && st.mode ? String(st.mode) : 'edit';
	return (mode === 'preview') ? (boxId + '_chart_canvas_preview') : (boxId + '_chart_canvas_edit');
}

function __kustoGetIsDarkThemeForEcharts() {
	try {
		if (typeof isDarkTheme === 'function') {
			return !!isDarkTheme();
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

function __kustoFormatUtcDateTime(ms, showTime) {
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

function __kustoShouldShowTimeForUtcAxis(timeMsValues) {
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

function __kustoComputeTimeAxisLabelRotation(axisPixelWidth, labelCount, showTime) {
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
	// We cap `n` because ECharts won't render all labels anyway.
	const effectiveLabels = Math.min(n, 24);
	if (effectiveLabels > maxNoRotate * 2) return 60;
	if (effectiveLabels > maxNoRotate * 1.3) return 45;
	return 0;
}

let __kustoEchartsThemeObserverStarted = false;
let __kustoLastAppliedEchartsIsDarkTheme = null;

function __kustoRefreshChartsForThemeChange() {
	let dark = true;
	try { dark = __kustoGetIsDarkThemeForEcharts(); } catch { dark = true; }
	if (__kustoLastAppliedEchartsIsDarkTheme === dark) return;
	__kustoLastAppliedEchartsIsDarkTheme = dark;
	try {
		for (const id of (chartBoxes || [])) {
			try { __kustoDisposeChartEcharts(id); } catch { /* ignore */ }
			try { __kustoRenderChart(id); } catch { /* ignore */ }
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

function __kustoDisposeChartEcharts(boxId) {
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

function __kustoRenderChart(boxId) {
	const id = String(boxId || '');
	if (!id) return;
	try { __kustoStartEchartsThemeObserver(); } catch { /* ignore */ }
	const st = __kustoGetChartState(id);

	// Defensive: ensure dataSourceId is synced from the DOM dropdown in case state became stale.
	try {
		const dsEl = document.getElementById(id + '_chart_ds');
		if (dsEl && dsEl.value) {
			st.dataSourceId = String(dsEl.value || '');
		}
	} catch { /* ignore */ }

	try {
		const wrapper = document.getElementById(id + '_chart_wrapper');
		if (wrapper && wrapper.style && String(wrapper.style.display || '').toLowerCase() === 'none') {
			return;
		}
	} catch { /* ignore */ }
	const canvasId = __kustoGetChartActiveCanvasElementId(id);
	const canvas = document.getElementById(canvasId);
	if (!canvas) return;

	// If ECharts isn't loaded yet, show a simple placeholder.
	if (!window.echarts || typeof window.echarts.init !== 'function') {
		try { canvas.textContent = 'Loading chart…'; } catch { /* ignore */ }
		return;
	}

	// Find dataset.
	let dsState = null;
	try {
		if (typeof __kustoGetResultsState === 'function' && typeof st.dataSourceId === 'string' && st.dataSourceId) {
			dsState = __kustoGetResultsState(st.dataSourceId);
		}
	} catch { /* ignore */ }
	const cols = dsState && Array.isArray(dsState.columns) ? dsState.columns : [];
	const rows = dsState && Array.isArray(dsState.rows) ? dsState.rows : [];
	const colNames = cols.map(__kustoNormalizeResultsColumnName);
	const indexOf = (name) => {
		const n = String(name || '');
		if (!n) return -1;
		return colNames.findIndex(cn => String(cn) === n);
	};

	// Helper to dispose ECharts instance before showing error text.
	// Setting textContent destroys ECharts DOM, so we must dispose the instance first.
	const showErrorAndReturn = (msg) => {
		try {
			if (st.__echarts && st.__echarts.instance) {
				st.__echarts.instance.dispose();
				delete st.__echarts;
			}
		} catch { /* ignore */ }
		try { canvas.textContent = msg; } catch { /* ignore */ }
	};

	const chartType = (typeof st.chartType === 'string') ? String(st.chartType) : '';
	if (!st.dataSourceId) {
		showErrorAndReturn('Select a data source.');
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
	try {
		const isDark = __kustoGetIsDarkThemeForEcharts();
		const themeName = isDark ? 'dark' : undefined;
		const prev = st.__echarts && st.__echarts.instance ? st.__echarts : null;
		if (!prev || prev.canvasId !== canvasId || prev.isDark !== isDark) {
			try { if (prev && prev.instance) prev.instance.dispose(); } catch { /* ignore */ }
			st.__echarts = { instance: window.echarts.init(canvas, themeName), canvasId, isDark };
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
		if (chartType === 'pie') {
			const li = indexOf(st.labelColumn);
			const vi = indexOf(st.valueColumn);
			const valueColName = st.valueColumn || 'Value';
			if (li < 0 || vi < 0) {
				showErrorAndReturn('Select columns.');
				return;
			} else {
				const data = (rows || []).map(r => {
					const label = (r && r.length > li) ? __kustoCellToChartString(r[li]) : '';
					const value = (r && r.length > vi) ? __kustoCellToChartNumber(r[vi]) : null;
					return { name: label, value: (typeof value === 'number' && Number.isFinite(value)) ? value : 0 };
				});
				const showLabels = !!st.showDataLabels;
				option = {
					backgroundColor: 'transparent',
					tooltip: {
						trigger: 'item',
						formatter: (params) => {
							try {
								const name = params && params.name ? params.name : '';
								const value = params && typeof params.value === 'number' ? __kustoFormatNumber(params.value) : '';
								const percent = params && typeof params.percent === 'number' ? params.percent.toFixed(1) : '';
								return `${name}<br/>${valueColName}: ${value} (${percent}%)`;
							} catch {
								return '';
							}
						}
					},
					legend: { type: 'scroll' },
					series: [{
						type: 'pie',
						radius: '60%',
						data,
						label: {
							show: showLabels,
							fontFamily: 'monospace',
							formatter: (params) => {
								try {
									// For pie charts, show labels only for larger slices (>5%) to reduce clutter
									const percent = params && typeof params.percent === 'number' ? params.percent : 0;
									if (percent < 5) return '';
									const value = params && typeof params.value === 'number' ? __kustoFormatNumber(params.value) : '';
									return value;
								} catch {
									return '';
								}
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
						points.push([x, y]);
					}
				}
				// Ensure stable left-to-right plotting for numeric/time axes.
				try {
					points.sort((a, b) => {
						const ax = a && a.length ? a[0] : 0;
						const bx = b && b.length ? b[0] : 0;
						if (ax === bx) return 0;
						return ax < bx ? -1 : 1;
					});
				} catch { /* ignore */ }
				const showTime = useTime ? __kustoShouldShowTimeForUtcAxis(points.map(p => p && p.length ? p[0] : null)) : false;
				const rotate = useTime ? __kustoComputeTimeAxisLabelRotation(canvasWidthPx, points.length, showTime) : 0;
				const axisFontSize = __kustoComputeAxisFontSize(points.length, canvasWidthPx, false);
				// Calculate bottom margin for rotated labels.
				const bottomMargin = rotate > 30 ? 70 : 50;
				option = {
					backgroundColor: 'transparent',
					grid: {
						left: 60,
						right: 20,
						top: 20,
						bottom: bottomMargin,
						containLabel: false
					},
					tooltip: {
						trigger: 'item',
						formatter: (params) => {
							try {
								const v = params && params.value ? params.value : null;
								const x = v && v.length ? v[0] : null;
								const y = v && v.length > 1 ? v[1] : null;
								const xStr = useTime ? __kustoFormatUtcDateTime(x, showTime) : __kustoFormatNumber(x);
								const yStr = __kustoFormatNumber(y);
								return `${xColName}: ${xStr}<br/>${yColName}: ${yStr}`;
							} catch {
								return '';
							}
						}
					},
					xAxis: useTime ? {
						type: 'time',
						name: xColName,
						nameLocation: 'middle',
						nameGap: 30,
						axisLabel: {
							rotate,
							fontSize: axisFontSize,
							fontFamily: 'monospace',
							formatter: (value) => __kustoFormatUtcDateTime(value, showTime)
						},
						axisPointer: { label: { formatter: (p) => __kustoFormatUtcDateTime(p && p.value, showTime) } }
					} : {
						type: 'value',
						name: xColName,
						nameLocation: 'middle',
						nameGap: 30,
						axisLabel: {
							fontSize: axisFontSize,
							fontFamily: 'monospace',
							formatter: (value) => __kustoFormatNumber(value)
						}
					},
					yAxis: {
						type: 'value',
						name: yColName,
						nameLocation: 'middle',
						nameGap: 45,
						axisLabel: {
							fontSize: 11,
							fontFamily: 'monospace',
							formatter: (value) => __kustoFormatNumber(value)
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
							formatter: (params) => {
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
			yCols = yCols.filter(c => indexOf(c) >= 0);
			
			if (xi < 0 || !yCols.length) {
				showErrorAndReturn('Select columns.');
				return;
			} else {
				const isArea = chartType === 'area';
				const useTime = __kustoInferTimeXAxisFromRows(rows, xi);
					let timeKeys = [];
					let timeLabels = [];
					let timeShowTime = false;
					if (useTime) {
						try {
							const all = [];
							for (const r of (rows || [])) {
								const t = (r && r.length > xi) ? __kustoCellToChartTimeMs(r[xi]) : null;
								if (typeof t === 'number' && Number.isFinite(t)) all.push(t);
							}
							all.sort((a, b) => a - b);
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
							timeLabels = timeKeys.map(t => __kustoFormatUtcDateTime(t, timeShowTime));
						} catch { /* ignore */ }
					}
				
				// Build series based on legend grouping or multiple Y columns.
				let seriesData = [];
				let xLabelsSet = new Set();
				
				if (li >= 0 && yCols.length === 1) {
					// Legend grouping: group data by legend column values.
					const yi = indexOf(yCols[0]);
					const yColName = yCols[0] || 'Y';
					const groups = {};
					for (const r of (rows || [])) {
						const legendValue = (r && r.length > li) ? __kustoCellToChartString(r[li]) : '(empty)';
						const xVal = useTime
							? ((r && r.length > xi) ? __kustoCellToChartTimeMs(r[xi]) : null)
							: ((r && r.length > xi) ? __kustoCellToChartString(r[xi]) : '');
						const yVal = (r && r.length > yi) ? __kustoCellToChartNumber(r[yi]) : null;
						if (!groups[legendValue]) groups[legendValue] = [];
						groups[legendValue].push({ x: xVal, y: yVal });
						if (useTime) {
							// For time axis, collect all x values.
						} else {
							xLabelsSet.add(xVal);
						}
					}
					const legendNames = Object.keys(groups).sort();
					
					if (useTime) {
							// Time-based X axis with legend grouping (render as category labels so all values show).
						for (const legendName of legendNames) {
							const pts = groups[legendName] || [];
							// Sort by time.
							pts.sort((a, b) => (a.x || 0) - (b.x || 0));
								const map = {};
								for (const p of pts) {
									const tx = p && typeof p.x === 'number' && Number.isFinite(p.x) ? p.x : null;
									if (tx === null) continue;
									map[String(tx)] = p.y;
								}
							seriesData.push({
								name: legendName,
								type: (chartType === 'bar') ? 'bar' : 'line',
								...(isArea ? { areaStyle: {} } : {}),
									data: timeKeys.map(t => (String(t) in map) ? map[String(t)] : null),
								label: {
									show: showLabels,
									position: 'top',
									fontSize: 10,
									fontFamily: 'monospace',
									formatter: (params) => {
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
							const dataMap = {};
							for (const p of pts) {
								dataMap[p.x] = p.y;
							}
							seriesData.push({
								name: legendName,
								type: (chartType === 'bar') ? 'bar' : 'line',
								...(isArea ? { areaStyle: {} } : {}),
								data: xLabels.map(xl => dataMap[xl] ?? null),
								label: {
									show: showLabels,
									position: 'top',
									fontSize: 10,
									fontFamily: 'monospace',
									formatter: (params) => {
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
						
						if (useTime) {
								const map = {};
								for (const r of (rows || [])) {
									const x = (r && r.length > xi) ? __kustoCellToChartTimeMs(r[xi]) : null;
									const y = (r && r.length > yi) ? __kustoCellToChartNumber(r[yi]) : null;
									if (typeof x === 'number' && Number.isFinite(x)) {
										map[String(x)] = y;
									}
								}
							seriesData.push({
								name: yCol,
								type: (chartType === 'bar') ? 'bar' : 'line',
								...(isArea ? { areaStyle: {} } : {}),
									data: timeKeys.map(t => (String(t) in map) ? map[String(t)] : null),
								label: {
									show: showLabels,
									position: 'top',
									fontSize: 10,
									fontFamily: 'monospace',
									formatter: (params) => {
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
							const yData = (rows || []).map(r => (r && r.length > yi) ? __kustoCellToChartNumber(r[yi]) : null);
							seriesData.push({
								name: yCol,
								type: (chartType === 'bar') ? 'bar' : 'line',
								...(isArea ? { areaStyle: {} } : {}),
								data: yData,
								label: {
									show: showLabels,
									position: 'top',
									fontSize: 10,
									fontFamily: 'monospace',
									formatter: (params) => {
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
				
					const xLabels = useTime ? timeLabels : Array.from(xLabelsSet);
					const showTime = useTime ? timeShowTime : false;
					const rotate = useTime ? __kustoComputeTimeAxisLabelRotation(canvasWidthPx, xLabels.length, showTime) : 0;
					const axisFontSize = __kustoComputeAxisFontSize(xLabels.length, canvasWidthPx, false);
				// Calculate bottom margin for rotated labels.
				const bottomMargin = rotate > 30 ? 70 : 40;
				
				option = {
					backgroundColor: 'transparent',
					grid: {
						left: 60,
						right: 20,
						top: seriesData.length > 1 ? 50 : 20,
						bottom: bottomMargin,
						containLabel: false
					},
					legend: seriesData.length > 1 ? { type: 'scroll', top: 0 } : undefined,
					tooltip: {
						trigger: 'axis',
						formatter: (params) => {
							try {
								const arr = Array.isArray(params) ? params : (params ? [params] : []);
								const first = arr.length ? arr[0] : null;
								const axisValue = first ? first.axisValue : null;
									const title = String(axisValue || '');
									let lines = [`<strong>${xColName}</strong>: ${title}`];
								for (const p of arr) {
									const seriesName = p && p.seriesName ? p.seriesName : '';
									const v = p && p.data ? (Array.isArray(p.data) ? p.data[1] : p.data) : '';
									const formatted = (typeof v === 'number') ? __kustoFormatNumber(v) : String(v);
									lines.push(`<strong>${seriesName}</strong>: ${formatted}`);
								}
								return lines.join('<br/>');
							} catch {
								return '';
							}
						}
					},
						xAxis: {
							type: 'category',
							data: xLabels,
							boundaryGap: (chartType === 'bar'),
							axisTick: { alignWithLabel: true },
							axisLabel: {
								fontSize: axisFontSize,
								fontFamily: 'monospace',
								interval: 0,
								rotate
							}
						},
					yAxis: {
						type: 'value',
						axisLabel: {
							fontSize: 11,
							fontFamily: 'monospace',
							formatter: (value) => __kustoFormatNumber(value)
						}
					},
					series: seriesData
				};
				
				if (useTime) {
						st.__lastTimeAxis = { showTime, labelCount: xLabels.length, rotate };
				} else {
					try { delete st.__lastTimeAxis; } catch { /* ignore */ }
				}
			}
		}
	} catch {
		showErrorAndReturn('Failed to render chart.');
		return;
	}

	try {
		// Clear any text nodes (error messages) without destroying ECharts child elements.
		for (const child of Array.from(canvas.childNodes)) {
			if (child.nodeType === Node.TEXT_NODE) {
				canvas.removeChild(child);
			}
		}
		inst.setOption(option || {}, true);
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
					if (st.__lastTimeAxis) {
						const w = canvas && typeof canvas.clientWidth === 'number' ? canvas.clientWidth : 0;
						const rotate = __kustoComputeTimeAxisLabelRotation(w, st.__lastTimeAxis.labelCount, st.__lastTimeAxis.showTime);
						if (rotate !== st.__lastTimeAxis.rotate) {
							st.__lastTimeAxis.rotate = rotate;
							try {
								inst.setOption({ xAxis: { axisLabel: { rotate } } });
							} catch { /* ignore */ }
						}
					}
				} catch { /* ignore */ }
			});
			try { st.__resizeObserver.observe(canvas); } catch { /* ignore */ }
			try {
				const wrapper = document.getElementById(id + '_chart_wrapper');
				if (wrapper) st.__resizeObserver.observe(wrapper);
			} catch { /* ignore */ }
		}
	} catch { /* ignore */ }
}

function __kustoUpdateChartModeButtons(boxId) {
	try {
		const st = chartStateByBoxId && chartStateByBoxId[boxId] ? chartStateByBoxId[boxId] : null;
		const mode = st && st.mode ? String(st.mode) : 'edit';
		const editBtn = document.getElementById(boxId + '_chart_mode_edit');
		const prevBtn = document.getElementById(boxId + '_chart_mode_preview');
		if (editBtn) {
			editBtn.classList.toggle('is-active', mode === 'edit');
			editBtn.setAttribute('aria-selected', mode === 'edit' ? 'true' : 'false');
		}
		if (prevBtn) {
			prevBtn.classList.toggle('is-active', mode === 'preview');
			prevBtn.setAttribute('aria-selected', mode === 'preview' ? 'true' : 'false');
		}
	} catch {
		// ignore
	}
}

function __kustoApplyChartMode(boxId) {
	try {
		const st = chartStateByBoxId && chartStateByBoxId[boxId] ? chartStateByBoxId[boxId] : null;
		const mode = st && st.mode ? String(st.mode) : 'edit';
		const editHost = document.getElementById(boxId + '_chart_edit');
		const prevHost = document.getElementById(boxId + '_chart_preview');
		if (editHost) editHost.style.display = (mode === 'edit') ? '' : 'none';
		if (prevHost) prevHost.style.display = (mode === 'preview') ? '' : 'none';
		__kustoUpdateChartModeButtons(boxId);
		try { __kustoRenderChart(boxId); } catch { /* ignore */ }
	} catch {
		// ignore
	}
}

function __kustoSetChartMode(boxId, mode) {
	const id = String(boxId || '');
	const m = String(mode || '').toLowerCase();
	if (!id) return;
	if (m !== 'edit' && m !== 'preview') return;
	const st = __kustoGetChartState(id);
	st.mode = m;
	try { __kustoApplyChartMode(id); } catch { /* ignore */ }
	try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
}

function __kustoUpdateChartVisibilityToggleButton(boxId) {
	try {
		const btn = document.getElementById(boxId + '_chart_toggle');
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

function __kustoApplyChartBoxVisibility(boxId) {
	try {
		const st = chartStateByBoxId && chartStateByBoxId[boxId] ? chartStateByBoxId[boxId] : null;
		const expanded = !!(st ? st.expanded : true);
		const wrapper = document.getElementById(boxId + '_chart_wrapper');
		if (wrapper) {
			wrapper.style.display = expanded ? '' : 'none';
		}
		__kustoUpdateChartVisibilityToggleButton(boxId);
		if (expanded) {
			try { __kustoRenderChart(boxId); } catch { /* ignore */ }
		}
	} catch {
		// ignore
	}
}

function toggleChartBoxVisibility(boxId) {
	const id = String(boxId || '');
	if (!id) return;
	const st = __kustoGetChartState(id);
	st.expanded = !st.expanded;
	try { __kustoApplyChartBoxVisibility(id); } catch { /* ignore */ }
	try { __kustoRenderChart(id); } catch { /* ignore */ }
	try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
}

function __kustoMaximizeChartBox(boxId) {
	try {
		const wrapper = document.getElementById(boxId + '_chart_wrapper');
		if (!wrapper) return;
		
		const st = __kustoGetChartState(boxId);
		const isPreview = st.mode === 'preview';
		
		// Get the active editor (edit or preview)
		const editEditor = document.getElementById(boxId + '_chart_edit');
		const previewEditor = document.getElementById(boxId + '_chart_preview');
		const activeEditor = isPreview ? previewEditor : editEditor;
		
		if (!activeEditor) return;
		
		// Minimum height for the chart canvas when it has actual content
		const CHART_MIN_HEIGHT = 240;
		// Height for empty/unconfigured state (just shows placeholder text)
		const CHART_EMPTY_HEIGHT = 40;
		const SLACK_PX = 10;
		
		// Determine if chart is configured (has data source and chart type)
		const hasDataSource = typeof st.dataSourceId === 'string' && st.dataSourceId;
		const hasChartType = typeof st.chartType === 'string' && st.chartType;
		const isConfigured = hasDataSource && hasChartType;
		
		// Use smaller height when chart is not fully configured
		const canvasHeight = isConfigured ? CHART_MIN_HEIGHT : CHART_EMPTY_HEIGHT;
		
		let desiredHeight = canvasHeight;
		
		if (isPreview) {
			// Preview mode: just the chart canvas
			desiredHeight = canvasHeight + SLACK_PX;
		} else {
			// Edit mode: controls + chart canvas
			const controls = activeEditor.querySelector('.kusto-chart-controls');
			const builder = activeEditor.querySelector('.kusto-chart-builder');
			
			let controlsHeight = 0;
			if (controls) {
				try {
					const rect = controls.getBoundingClientRect();
					controlsHeight = rect.height || 0;
				} catch { /* ignore */ }
			}
			
			// Get builder padding
			let builderPadding = 0;
			if (builder) {
				try {
					const cs = getComputedStyle(builder);
					builderPadding = (parseFloat(cs.paddingTop || '0') || 0) + 
					                 (parseFloat(cs.paddingBottom || '0') || 0) +
					                 (parseFloat(cs.gap || '0') || 0); // gap between controls and canvas
				} catch { /* ignore */ }
			}
			
			desiredHeight = controlsHeight + canvasHeight + builderPadding + SLACK_PX;
		}
		
		// Apply the calculated height
		wrapper.style.height = Math.ceil(desiredHeight) + 'px';
		try { delete wrapper.dataset.kustoUserResized; } catch { /* ignore */ }
		
		try { __kustoRenderChart(boxId); } catch { /* ignore */ }
		try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
	} catch {
		// ignore
	}
}

// Check if the chart canvas is partially clipped and auto-fit if needed.
function __kustoAutoFitChartIfClipped(boxId) {
	try {
		const wrapper = document.getElementById(boxId + '_chart_wrapper');
		if (!wrapper) return;
		
		const st = __kustoGetChartState(boxId);
		const isPreview = st.mode === 'preview';
		
		// Get the active canvas
		const canvasId = isPreview ? (boxId + '_chart_canvas_preview') : (boxId + '_chart_canvas_edit');
		const canvas = document.getElementById(canvasId);
		if (!canvas) return;
		
		// Get minimum height from inline style (default 240px)
		let minHeight = 240;
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

function addChartBox(options) {
	const id = (options && options.id) ? String(options.id) : ('chart_' + Date.now());
	chartBoxes.push(id);
	const st = __kustoGetChartState(id);
	st.mode = (options && typeof options.mode === 'string' && String(options.mode).toLowerCase() === 'preview') ? 'preview' : 'edit';
	st.expanded = (options && typeof options.expanded === 'boolean') ? !!options.expanded : true;
	st.dataSourceId = (options && typeof options.dataSourceId === 'string') ? String(options.dataSourceId) : (st.dataSourceId || '');
	// Default chart type to 'area' (first alphabetically) if not specified.
	st.chartType = (options && typeof options.chartType === 'string') ? String(options.chartType) : (st.chartType || 'area');
	st.xColumn = (options && typeof options.xColumn === 'string') ? String(options.xColumn) : (st.xColumn || '');
	st.yColumn = (options && typeof options.yColumn === 'string') ? String(options.yColumn) : (st.yColumn || '');
	st.yColumns = (options && Array.isArray(options.yColumns)) ? options.yColumns.filter(c => c) : (st.yColumns || (st.yColumn ? [st.yColumn] : []));
	st.legendColumn = (options && typeof options.legendColumn === 'string') ? String(options.legendColumn) : (st.legendColumn || '');
	st.labelColumn = (options && typeof options.labelColumn === 'string') ? String(options.labelColumn) : (st.labelColumn || '');
	st.valueColumn = (options && typeof options.valueColumn === 'string') ? String(options.valueColumn) : (st.valueColumn || '');
	st.showDataLabels = (options && typeof options.showDataLabels === 'boolean') ? !!options.showDataLabels : (st.showDataLabels || false);

	const container = document.getElementById('queries-container');
	if (!container) {
		return;
	}

	const closeIconSvg =
		'<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" xmlns="http://www.w3.org/2000/svg">' +
		'<path d="M4 4l8 8"/>' +
		'<path d="M12 4L4 12"/>' +
		'</svg>';

	const previewIconSvg =
		'<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">' +
		'<path d="M1.5 8c1.8-3.1 4-4.7 6.5-4.7S12.7 4.9 14.5 8c-1.8 3.1-4 4.7-6.5 4.7S3.3 11.1 1.5 8z" />' +
		'<circle cx="8" cy="8" r="2.1" />' +
		'</svg>';

	const maximizeIconSvg =
		'<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">' +
		'<path d="M3 6V3h3" />' +
		'<path d="M13 10v3h-3" />' +
		'<path d="M3 3l4 4" />' +
		'<path d="M13 13l-4-4" />' +
		'</svg>';

	const boxHtml =
		'<div class="query-box chart-box" id="' + id + '">' +
		'<div class="query-header">' +
		'<div class="query-header-row query-header-row-top">' +
		'<div class="query-name-group">' +
		'<button type="button" class="section-drag-handle" draggable="true" title="Drag to reorder" aria-label="Reorder section"><span class="section-drag-handle-glyph" aria-hidden="true">⋮</span></button>' +
		'<input type="text" class="query-name" placeholder="Chart name (optional)" id="' + id + '_name" oninput="try{schedulePersist&&schedulePersist()}catch{}" />' +
		'</div>' +
		'<div class="section-actions">' +
		'<div class="md-tabs" role="tablist" aria-label="Chart tools">' +
		'<button class="unified-btn-secondary md-tab md-mode-btn" id="' + id + '_chart_mode_edit" type="button" role="tab" aria-selected="false" onclick="__kustoSetChartMode(\'' + id + '\', \'edit\')" title="Edit" aria-label="Edit">Edit</button>' +
		'<button class="unified-btn-secondary md-tab md-mode-btn" id="' + id + '_chart_mode_preview" type="button" role="tab" aria-selected="false" onclick="__kustoSetChartMode(\'' + id + '\', \'preview\')" title="Preview" aria-label="Preview">Preview</button>' +
		'<span class="md-tabs-divider" aria-hidden="true"></span>' +
		'<button class="unified-btn-secondary md-tab md-max-btn" id="' + id + '_chart_max" type="button" onclick="__kustoMaximizeChartBox(\'' + id + '\')" title="Fit to contents" aria-label="Fit to contents">' + maximizeIconSvg + '</button>' +
		'<button class="unified-btn-secondary md-tab" id="' + id + '_chart_toggle" type="button" role="tab" aria-selected="false" onclick="toggleChartBoxVisibility(\'' + id + '\')" title="Hide" aria-label="Hide">' + previewIconSvg + '</button>' +
		'</div>' +
		'<button class="unified-btn-secondary unified-btn-icon-only refresh-btn close-btn" type="button" onclick="removeChartBox(\'' + id + '\')" title="Remove" aria-label="Remove">' + closeIconSvg + '</button>' +
		'</div>' +
		'</div>' +
		'</div>' +
		'<div class="query-editor-wrapper" id="' + id + '_chart_wrapper">' +
		'<div class="query-editor" id="' + id + '_chart_edit" data-kusto-no-editor-focus="true">' +
			'<div class="kusto-chart-builder" data-kusto-no-editor-focus="true">' +
				'<div class="kusto-chart-controls" data-kusto-no-editor-focus="true">' +
					'<div class="kusto-chart-row kusto-chart-row-type" data-kusto-no-editor-focus="true">' +
						'<label>Type</label>' +
						'<div class="kusto-chart-type-picker" id="' + id + '_chart_type_picker" data-kusto-no-editor-focus="true">' +
							'<button type="button" class="unified-btn-secondary kusto-chart-type-btn" data-type="area" onclick="try{__kustoSelectChartType(\'' + id + '\',\'area\')}catch{}" title="Area Chart" aria-label="Area Chart">' + __kustoChartTypeIcons.area + '<span>Area</span></button>' +
							'<button type="button" class="unified-btn-secondary kusto-chart-type-btn" data-type="bar" onclick="try{__kustoSelectChartType(\'' + id + '\',\'bar\')}catch{}" title="Bar Chart" aria-label="Bar Chart">' + __kustoChartTypeIcons.bar + '<span>Bar</span></button>' +
							'<button type="button" class="unified-btn-secondary kusto-chart-type-btn" data-type="line" onclick="try{__kustoSelectChartType(\'' + id + '\',\'line\')}catch{}" title="Line Chart" aria-label="Line Chart">' + __kustoChartTypeIcons.line + '<span>Line</span></button>' +
							'<button type="button" class="unified-btn-secondary kusto-chart-type-btn" data-type="pie" onclick="try{__kustoSelectChartType(\'' + id + '\',\'pie\')}catch{}" title="Pie Chart" aria-label="Pie Chart">' + __kustoChartTypeIcons.pie + '<span>Pie</span></button>' +
							'<button type="button" class="unified-btn-secondary kusto-chart-type-btn" data-type="scatter" onclick="try{__kustoSelectChartType(\'' + id + '\',\'scatter\')}catch{}" title="Scatter Chart" aria-label="Scatter Chart">' + __kustoChartTypeIcons.scatter + '<span>Scatter</span></button>' +
						'</div>' +
					'</div>' +
					'<div class="kusto-chart-row" data-kusto-no-editor-focus="true">' +
						'<label>Data</label>' +
						'<div class="select-wrapper kusto-dropdown-wrapper kusto-single-select-dropdown" id="' + id + '_chart_ds_wrapper">' +
							'<select class="kusto-dropdown-hidden-select" id="' + id + '_chart_ds" onfocus="try{__kustoUpdateChartBuilderUI(\'' + id + '\')}catch{}" onchange="try{__kustoOnChartDataSourceChanged(\'' + id + '\')}catch{}"></select>' +
							'<button type="button" class="kusto-dropdown-btn" id="' + id + '_chart_ds_btn" onclick="try{window.__kustoDropdown.toggleSelectMenu(\'' + id + '_chart_ds\')}catch{}; event.stopPropagation();" aria-haspopup="listbox" aria-expanded="false">' +
								'<span class="kusto-dropdown-btn-text" id="' + id + '_chart_ds_text">(select)</span>' +
								'<span class="kusto-dropdown-btn-caret" aria-hidden="true"><svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M7.976 10.072l4.357-4.357.62.618L8.284 11h-.618L3 6.333l.619-.618 4.357 4.357z" fill="currentColor"/></svg></span>' +
							'</button>' +
							'<div class="kusto-dropdown-menu" id="' + id + '_chart_ds_menu" role="listbox" tabindex="-1" style="display:none;"></div>' +
						'</div>' +
					'</div>' +
					'<div id="' + id + '_chart_mapping_xy" class="kusto-chart-mapping" data-kusto-no-editor-focus="true" style="display:none;">' +
						'<div class="kusto-chart-mapping-row" data-kusto-no-editor-focus="true">' +
							'<span class="kusto-chart-field-group">' +
								'<label>X</label>' +
								'<div class="select-wrapper kusto-dropdown-wrapper kusto-single-select-dropdown" id="' + id + '_chart_x_wrapper">' +
									'<select class="kusto-dropdown-hidden-select" id="' + id + '_chart_x" onchange="try{__kustoOnChartMappingChanged(\'' + id + '\')}catch{}"></select>' +
									'<button type="button" class="kusto-dropdown-btn" id="' + id + '_chart_x_btn" onclick="try{window.__kustoDropdown.toggleSelectMenu(\'' + id + '_chart_x\')}catch{}; event.stopPropagation();" aria-haspopup="listbox" aria-expanded="false">' +
										'<span class="kusto-dropdown-btn-text" id="' + id + '_chart_x_text">Select...</span>' +
										'<span class="kusto-dropdown-btn-caret" aria-hidden="true"><svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M7.976 10.072l4.357-4.357.62.618L8.284 11h-.618L3 6.333l.619-.618 4.357 4.357z" fill="currentColor"/></svg></span>' +
									'</button>' +
									'<div class="kusto-dropdown-menu" id="' + id + '_chart_x_menu" role="listbox" tabindex="-1" style="display:none;"></div>' +
								'</div>' +
							'</span>' +
							'<span class="kusto-chart-field-group">' +
								'<label>Y</label>' +
								'<div class="select-wrapper kusto-dropdown-wrapper kusto-checkbox-dropdown" id="' + id + '_chart_y_wrapper">' +
									'<button type="button" class="kusto-dropdown-btn" id="' + id + '_chart_y_btn" onclick="try{window.__kustoDropdown.toggleCheckboxMenu(\'' + id + '_chart_y_btn\',\'' + id + '_chart_y_menu\')}catch{}; event.stopPropagation();" aria-haspopup="listbox" aria-expanded="false">' +
										'<span class="kusto-dropdown-btn-text" id="' + id + '_chart_y_text">Select...</span>' +
										'<span class="kusto-dropdown-btn-caret" aria-hidden="true"><svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M7.976 10.072l4.357-4.357.62.618L8.284 11h-.618L3 6.333l.619-.618 4.357 4.357z" fill="currentColor"/></svg></span>' +
									'</button>' +
									'<div class="kusto-dropdown-menu kusto-checkbox-menu" id="' + id + '_chart_y_menu" role="listbox" tabindex="-1" style="display:none;"></div>' +
								'</div>' +
							'</span>' +
							'<span class="kusto-chart-field-group">' +
								'<label class="kusto-chart-label-legend">Legend</label>' +
								'<div class="select-wrapper kusto-dropdown-wrapper kusto-single-select-dropdown" id="' + id + '_chart_legend_wrapper">' +
									'<select class="kusto-dropdown-hidden-select" id="' + id + '_chart_legend" onchange="try{__kustoOnChartMappingChanged(\'' + id + '\')}catch{}"><option value="">(none)</option></select>' +
									'<button type="button" class="kusto-dropdown-btn" id="' + id + '_chart_legend_btn" onclick="try{window.__kustoDropdown.toggleSelectMenu(\'' + id + '_chart_legend\')}catch{}; event.stopPropagation();" aria-haspopup="listbox" aria-expanded="false">' +
										'<span class="kusto-dropdown-btn-text" id="' + id + '_chart_legend_text">(none)</span>' +
										'<span class="kusto-dropdown-btn-caret" aria-hidden="true"><svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M7.976 10.072l4.357-4.357.62.618L8.284 11h-.618L3 6.333l.619-.618 4.357 4.357z" fill="currentColor"/></svg></span>' +
									'</button>' +
									'<div class="kusto-dropdown-menu" id="' + id + '_chart_legend_menu" role="listbox" tabindex="-1" style="display:none;"></div>' +
								'</div>' +
							'</span>' +
							'<label class="kusto-chart-toggle-label" data-kusto-no-editor-focus="true">' +
								'<input type="checkbox" id="' + id + '_chart_labels" class="kusto-chart-toggle" onchange="try{__kustoOnChartLabelsToggled(\'' + id + '\')}catch{}" />' +
								'<span>Data labels</span>' +
							'</label>' +
						'</div>' +
					'</div>' +
					'<div id="' + id + '_chart_mapping_pie" class="kusto-chart-mapping" data-kusto-no-editor-focus="true" style="display:none;">' +
						'<div class="kusto-chart-mapping-row" data-kusto-no-editor-focus="true">' +
							'<span class="kusto-chart-field-group">' +
								'<label>Label</label>' +
								'<div class="select-wrapper kusto-dropdown-wrapper kusto-single-select-dropdown" id="' + id + '_chart_label_wrapper">' +
									'<select class="kusto-dropdown-hidden-select" id="' + id + '_chart_label" onchange="try{__kustoOnChartMappingChanged(\'' + id + '\')}catch{}"></select>' +
									'<button type="button" class="kusto-dropdown-btn" id="' + id + '_chart_label_btn" onclick="try{window.__kustoDropdown.toggleSelectMenu(\'' + id + '_chart_label\')}catch{}; event.stopPropagation();" aria-haspopup="listbox" aria-expanded="false">' +
										'<span class="kusto-dropdown-btn-text" id="' + id + '_chart_label_text">Select...</span>' +
										'<span class="kusto-dropdown-btn-caret" aria-hidden="true"><svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M7.976 10.072l4.357-4.357.62.618L8.284 11h-.618L3 6.333l.619-.618 4.357 4.357z" fill="currentColor"/></svg></span>' +
									'</button>' +
									'<div class="kusto-dropdown-menu" id="' + id + '_chart_label_menu" role="listbox" tabindex="-1" style="display:none;"></div>' +
								'</div>' +
							'</span>' +
							'<span class="kusto-chart-field-group">' +
								'<label>Value</label>' +
								'<div class="select-wrapper kusto-dropdown-wrapper kusto-single-select-dropdown" id="' + id + '_chart_value_wrapper">' +
									'<select class="kusto-dropdown-hidden-select" id="' + id + '_chart_value" onchange="try{__kustoOnChartMappingChanged(\'' + id + '\')}catch{}"></select>' +
									'<button type="button" class="kusto-dropdown-btn" id="' + id + '_chart_value_btn" onclick="try{window.__kustoDropdown.toggleSelectMenu(\'' + id + '_chart_value\')}catch{}; event.stopPropagation();" aria-haspopup="listbox" aria-expanded="false">' +
										'<span class="kusto-dropdown-btn-text" id="' + id + '_chart_value_text">Select...</span>' +
										'<span class="kusto-dropdown-btn-caret" aria-hidden="true"><svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M7.976 10.072l4.357-4.357.62.618L8.284 11h-.618L3 6.333l.619-.618 4.357 4.357z" fill="currentColor"/></svg></span>' +
									'</button>' +
									'<div class="kusto-dropdown-menu" id="' + id + '_chart_value_menu" role="listbox" tabindex="-1" style="display:none;"></div>' +
								'</div>' +
							'</span>' +
							'<label class="kusto-chart-toggle-label" data-kusto-no-editor-focus="true">' +
								'<input type="checkbox" id="' + id + '_chart_labels_pie" class="kusto-chart-toggle" onchange="try{__kustoOnChartLabelsToggled(\'' + id + '\')}catch{}" />' +
								'<span>Data labels</span>' +
							'</label>' +
						'</div>' +
					'</div>' +
				'</div>' +
				'<div class="kusto-chart-canvas" id="' + id + '_chart_canvas_edit" data-kusto-no-editor-focus="true" style="min-height:240px;"></div>' +
			'</div>' +
		'</div>' +
		'<div class="query-editor" id="' + id + '_chart_preview" data-kusto-no-editor-focus="true" style="display:none;">' +
			'<div class="kusto-chart-canvas" id="' + id + '_chart_canvas_preview" data-kusto-no-editor-focus="true" style="min-height:240px;"></div>' +
		'</div>' +
		'<div class="query-editor-resizer" id="' + id + '_chart_resizer" title="Drag to resize"></div>' +
		'</div>' +
		'</div>';

	container.insertAdjacentHTML('beforeend', boxHtml);

	try {
		const name = (options && typeof options.name === 'string') ? String(options.name) : '';
		const nameEl = document.getElementById(id + '_name');
		if (nameEl) nameEl.value = name;
	} catch { /* ignore */ }

	// Initialize builder UI from persisted state.
	try { __kustoUpdateChartBuilderUI(id); } catch { /* ignore */ }
	try {
		const dsSelect = document.getElementById(id + '_chart_ds');
		if (dsSelect && typeof st.dataSourceId === 'string') {
			dsSelect.value = st.dataSourceId;
		}
	} catch { /* ignore */ }
	try {
		const typeSelect = document.getElementById(id + '_chart_type');
		if (typeSelect && typeof st.chartType === 'string') {
			typeSelect.value = st.chartType;
		}
	} catch { /* ignore */ }

	// Apply persisted height if present.
	try {
		const h = options && typeof options.editorHeightPx === 'number' ? options.editorHeightPx : undefined;
		if (typeof h === 'number' && Number.isFinite(h) && h > 0) {
			const wrapper = document.getElementById(id + '_chart_wrapper');
			if (wrapper) {
				wrapper.style.height = Math.round(h) + 'px';
				try { wrapper.dataset.kustoUserResized = 'true'; } catch { /* ignore */ }
			}
		}
	} catch { /* ignore */ }

	// Drag handle resize for chart wrapper.
	try {
		const wrapper = document.getElementById(id + '_chart_wrapper');
		const resizer = document.getElementById(id + '_chart_resizer');
		if (wrapper && resizer) {
			resizer.addEventListener('mousedown', (e) => {
				try {
					e.preventDefault();
					e.stopPropagation();
				} catch { /* ignore */ }
				try { wrapper.dataset.kustoUserResized = 'true'; } catch { /* ignore */ }

				resizer.classList.add('is-dragging');
				const previousCursor = document.body.style.cursor;
				const previousUserSelect = document.body.style.userSelect;
				document.body.style.cursor = 'ns-resize';
				document.body.style.userSelect = 'none';

				const startPageY = e.clientY + (typeof __kustoGetScrollY === 'function' ? __kustoGetScrollY() : 0);
				const startHeight = wrapper.getBoundingClientRect().height;
				try { wrapper.style.height = Math.max(0, Math.ceil(startHeight)) + 'px'; } catch { /* ignore */ }

				const minH = 180;
				const maxH = 900;
				const onMove = (moveEvent) => {
					try {
						if (typeof __kustoMaybeAutoScrollWhileDragging === 'function') {
							__kustoMaybeAutoScrollWhileDragging(moveEvent.clientY);
						}
					} catch { /* ignore */ }
					const pageY = moveEvent.clientY + (typeof __kustoGetScrollY === 'function' ? __kustoGetScrollY() : 0);
					const delta = pageY - startPageY;
					const nextHeight = Math.max(minH, Math.min(maxH, startHeight + delta));
					wrapper.style.height = nextHeight + 'px';
					try { __kustoRenderChart(id); } catch { /* ignore */ }
				};
				const onUp = () => {
					document.removeEventListener('mousemove', onMove, true);
					document.removeEventListener('mouseup', onUp, true);
					resizer.classList.remove('is-dragging');
					document.body.style.cursor = previousCursor;
					document.body.style.userSelect = previousUserSelect;
					try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
					try { __kustoRenderChart(id); } catch { /* ignore */ }
				};

				document.addEventListener('mousemove', onMove, true);
				document.addEventListener('mouseup', onUp, true);
			});
		}
	} catch {
		// ignore
	}

	try { __kustoApplyChartMode(id); } catch { /* ignore */ }
	try { __kustoApplyChartBoxVisibility(id); } catch { /* ignore */ }
	try { __kustoRenderChart(id); } catch { /* ignore */ }
	try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
	try {
		const controls = document.querySelector('.add-controls');
		if (controls && typeof controls.scrollIntoView === 'function') {
			controls.scrollIntoView({ block: 'end' });
		}
	} catch { /* ignore */ }
	return id;
}

function __kustoOnChartDataSourceChanged(boxId) {
	const id = String(boxId || '');
	if (!id) return;
	const st = __kustoGetChartState(id);
	try {
		const el = document.getElementById(id + '_chart_ds');
		st.dataSourceId = el ? String(el.value || '') : '';
	} catch { /* ignore */ }
	try { __kustoUpdateChartBuilderUI(id); } catch { /* ignore */ }
	try { __kustoRenderChart(id); } catch { /* ignore */ }
	try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
}

function __kustoOnChartTypeChanged(boxId) {
	const id = String(boxId || '');
	if (!id) return;
	const st = __kustoGetChartState(id);
	try {
		const el = document.getElementById(id + '_chart_type');
		st.chartType = el ? String(el.value || '') : '';
	} catch { /* ignore */ }
	try { __kustoUpdateChartBuilderUI(id); } catch { /* ignore */ }
	try { __kustoRenderChart(id); } catch { /* ignore */ }
	try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
}

function __kustoSelectChartType(boxId, chartType) {
	const id = String(boxId || '');
	const type = String(chartType || '');
	if (!id) return;
	const st = __kustoGetChartState(id);
	st.chartType = type;
	try { __kustoUpdateChartBuilderUI(id); } catch { /* ignore */ }
	try { __kustoRenderChart(id); } catch { /* ignore */ }
	try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
}

function __kustoOnChartLabelsToggled(boxId) {
	const id = String(boxId || '');
	if (!id) return;
	const st = __kustoGetChartState(id);
	// Check both checkbox IDs (XY and Pie) - use the current checked state
	try {
		const cb = document.getElementById(id + '_chart_labels');
		const cbPie = document.getElementById(id + '_chart_labels_pie');
		// Determine which checkbox is visible/relevant and use its state
		const chartType = st.chartType || '';
		const isPie = chartType === 'pie';
		const relevantCheckbox = isPie ? cbPie : cb;
		st.showDataLabels = !!(relevantCheckbox && relevantCheckbox.checked);
		// Sync both checkboxes
		if (cb) cb.checked = st.showDataLabels;
		if (cbPie) cbPie.checked = st.showDataLabels;
	} catch { /* ignore */ }
	try { __kustoRenderChart(id); } catch { /* ignore */ }
	try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
}

function __kustoOnChartMappingChanged(boxId) {
	const id = String(boxId || '');
	if (!id) return;
	const st = __kustoGetChartState(id);
	const oldX = st.xColumn;
	try { st.xColumn = String(((document.getElementById(id + '_chart_x') || {}).value || '')); } catch { /* ignore */ }
	// Y columns are now handled by checkbox dropdown via __kustoOnChartYCheckboxChanged.
	try { st.legendColumn = String(((document.getElementById(id + '_chart_legend') || {}).value || '')); } catch { /* ignore */ }
	try { st.labelColumn = String(((document.getElementById(id + '_chart_label') || {}).value || '')); } catch { /* ignore */ }
	try { st.valueColumn = String(((document.getElementById(id + '_chart_value') || {}).value || '')); } catch { /* ignore */ }
	// If X column changed, rebuild Y column options (excluding the new X) to keep UI in sync.
	if (oldX !== st.xColumn) {
		try { __kustoUpdateChartBuilderUI(id); } catch { /* ignore */ }
	}
	try { __kustoRenderChart(id); } catch { /* ignore */ }
	try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
}

// Handler for Y column checkbox dropdown changes.
function __kustoOnChartYCheckboxChanged(dropdownId) {
	// dropdownId is like "boxId_chart_y"
	const parts = String(dropdownId || '').split('_chart_y');
	const boxId = parts[0] || '';
	if (!boxId) return;
	const st = __kustoGetChartState(boxId);
	const menuId = boxId + '_chart_y_menu';
	try {
		const selected = window.__kustoDropdown.getCheckboxSelections(menuId);
		st.yColumns = selected;
		st.yColumn = selected.length ? selected[0] : '';
		// If multiple Y columns are selected, Legend grouping is not supported.
		try {
			const legendSelect = document.getElementById(boxId + '_chart_legend');
			const legendBtn = document.getElementById(boxId + '_chart_legend_btn');
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
			try { window.__kustoDropdown.syncSelectBackedDropdown(boxId + '_chart_legend'); } catch { /* ignore */ }
		} catch { /* ignore */ }
		// Update button text.
		window.__kustoDropdown.updateCheckboxButtonText(boxId + '_chart_y_text', selected, 'Select...');
	} catch { /* ignore */ }
	try { __kustoRenderChart(boxId); } catch { /* ignore */ }
	try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
}

function removeChartBox(boxId) {
	try { __kustoDisposeChartEcharts(boxId); } catch { /* ignore */ }
	try { delete chartStateByBoxId[boxId]; } catch { /* ignore */ }
	chartBoxes = (chartBoxes || []).filter(id => id !== boxId);
	const box = document.getElementById(boxId);
	if (box && box.parentNode) {
		box.parentNode.removeChild(box);
	}
	try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
}

// Pending reveal requests from the extension host (e.g., Search result click).
// Keyed by markdown boxId.
let __kustoPendingMarkdownRevealByBoxId = {};

function __kustoTryApplyPendingMarkdownReveal(boxId) {
	try {
		const pending = __kustoPendingMarkdownRevealByBoxId && __kustoPendingMarkdownRevealByBoxId[boxId];
		if (!pending) {
			return;
		}
		try { delete __kustoPendingMarkdownRevealByBoxId[boxId]; } catch { /* ignore */ }
		try {
			if (typeof window.__kustoRevealMarkdownRangeInBox === 'function') {
				window.__kustoRevealMarkdownRangeInBox(boxId, pending);
			}
		} catch { /* ignore */ }
	} catch {
		// ignore
	}
}

// Called by main.js when the extension host asks us to reveal a range.
// For .md compatibility mode, there is exactly one markdown section; reveal in that first box.
try {
	if (typeof window.__kustoRevealTextRangeFromHost !== 'function') {
		window.__kustoRevealTextRangeFromHost = (message) => {
			try {
				const kind = String(window.__kustoDocumentKind || '');
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
						if (typeof vscode !== 'undefined' && vscode && typeof vscode.postMessage === 'function') {
							vscode.postMessage({
								type: 'debugMdSearchReveal',
								phase: 'markdownReveal(queued)',
								detail: `${String(window.__kustoDocumentUri || '')} boxId=${boxId} ${sl}:${sc}-${el}:${ec} matchLen=${matchText ? matchText.length : 0}`
							});
						}
					} catch { /* ignore */ }
					__kustoPendingMarkdownRevealByBoxId[boxId] = payload;
					return;
				}
				try {
					if (typeof vscode !== 'undefined' && vscode && typeof vscode.postMessage === 'function') {
						vscode.postMessage({
							type: 'debugMdSearchReveal',
							phase: 'markdownReveal(apply)',
							detail: `${String(window.__kustoDocumentUri || '')} boxId=${boxId} ${sl}:${sc}-${el}:${ec} matchLen=${matchText ? matchText.length : 0}`
						});
					}
				} catch { /* ignore */ }
				if (typeof window.__kustoRevealMarkdownRangeInBox === 'function') {
					window.__kustoRevealMarkdownRangeInBox(boxId, payload);
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
	if (typeof window.__kustoRevealMarkdownRangeInBox !== 'function') {
		window.__kustoRevealMarkdownRangeInBox = (boxId, payload) => {
			const id = String(boxId || '');
			if (!id) return;
			const sl = payload && typeof payload.startLine === 'number' ? payload.startLine : 0;
			const sc = payload && typeof payload.startChar === 'number' ? payload.startChar : 0;
			const el = payload && typeof payload.endLine === 'number' ? payload.endLine : sl;
			const ec = payload && typeof payload.endChar === 'number' ? payload.endChar : sc;
			const matchText = payload && typeof payload.matchText === 'string' ? String(payload.matchText) : '';
			const startOffset = payload && typeof payload.startOffset === 'number' ? payload.startOffset : undefined;
			const endOffset = payload && typeof payload.endOffset === 'number' ? payload.endOffset : undefined;
			const desiredUiMode = (typeof window.__kustoGetMarkdownMode === 'function')
				? String(window.__kustoGetMarkdownMode(id) || 'wysiwyg')
				: 'wysiwyg';

			try {
				const boxEl = document.getElementById(id);
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
			const computeLineChar1Based = (text, offset0) => {
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

			const computeOccurrenceIndex = (text, needle, atIndex) => {
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

			const applySelectionNow = () => {
				// If we're in preview mode, highlight + scroll using the rendered DOM.
				if (desiredUiMode === 'preview') {
					try {
						const viewerHost = document.getElementById(id + '_md_viewer');
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
								try { window.find && window.find(findText); } catch { /* ignore */ }
							}
						}, 0);
					} catch { /* ignore */ }
					return;
				}

				// Editor modes: keep the current mode; apply selection in a mode-appropriate way.
				const mdStart = (findText && foundEnd > foundStart)
					? computeLineChar1Based(mdText, foundStart)
					: (payload.__kustoMdStartFallback || [Math.max(1, sl + 1), Math.max(1, sc + 1)]);
				const mdEnd = (findText && foundEnd > foundStart)
					? computeLineChar1Based(mdText, foundEnd)
					: (payload.__kustoMdEndFallback || [Math.max(1, el + 1), Math.max(1, ec + 1)]);

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
				if (desiredUiMode === 'preview' && typeof window.__kustoSetMarkdownMode === 'function') {
					window.__kustoSetMarkdownMode(id, 'wysiwyg');
				}
			} catch { /* ignore */ }
			applySelectionInDesiredMode();
		};
	}
} catch {
	// ignore
}

let toastUiThemeObserverStarted = false;
let lastAppliedToastUiIsDarkTheme = null;

let urlStateByBoxId = {}; // { url, expanded, loading, loaded, content, error, kind, contentType, status, dataUri, body, truncated }

let markdownMarkedResolvePromise = null;

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
	const parseCssColorToRgb = (value) => {
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

function __kustoApplyToastUiThemeToHost(hostEl, isDark) {
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

function __kustoMaximizeMarkdownBox(boxId) {
	const id = String(boxId || '').trim();
	if (!id) return;
	const editorHost = document.getElementById(id + '_md_editor');
	const viewerHost = document.getElementById(id + '_md_viewer');
	const wrapper = editorHost && editorHost.closest ? editorHost.closest('.query-editor-wrapper') : null;
	if (!wrapper) return;
	const FIT_SLACK_PX = 5;

	const tryComputeDesiredWrapperHeight = (mode) => {
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
						const kids = prose.children ? Array.from(prose.children) : [];
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
			const padding = 18;
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
		try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
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
	try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
}

function __kustoAutoExpandMarkdownBoxToContent(boxId) {
	try {
		if (String(window.__kustoDocumentKind || '') !== 'md') {
			return;
		}
		const id = String(boxId || '').trim();
		if (!id) return;
		const editorHost = document.getElementById(id + '_md_editor');
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
							const kids = prose.children ? Array.from(prose.children) : [];
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

function __kustoScheduleMdAutoExpand(boxId) {
	try {
		if (String(window.__kustoDocumentKind || '') !== 'md') {
			return;
		}
		const id = String(boxId || '').trim();
		if (!id) return;
		window.__kustoMdAutoExpandTimersByBoxId = window.__kustoMdAutoExpandTimersByBoxId || {};
		const map = window.__kustoMdAutoExpandTimersByBoxId;
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

function __kustoMaximizePythonBox(boxId) {
	const id = String(boxId || '').trim();
	if (!id) return;
	const editorEl = document.getElementById(id + '_py_editor');
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
				for (const child of Array.from(wrapper.children || [])) {
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
	try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
}

function __kustoMaximizeUrlBox(boxId) {
	const id = String(boxId || '').trim();
	if (!id) return;
	const wrapper = document.getElementById(id + '_wrapper');
	if (!wrapper) return;
	const applyFitToContent = () => {
		try {
			// If collapsed/hidden, we can't measure meaningfully.
			try {
				const csw = getComputedStyle(wrapper);
				if (csw && csw.display === 'none') return;
			} catch { /* ignore */ }

			const contentEl = document.getElementById(id + '_content');
			if (!contentEl) return;

			// IMPORTANT: compute intrinsic content height. scrollHeight on a scroll container
			// is >= clientHeight, which prevents shrinking when oversized.
			let contentPx = 0;
			let contentClientH = 0;
			let hasTable = false;

			const addVisibleRectHeight = (el) => {
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

			try { contentClientH = Math.max(0, contentEl.clientHeight || 0); } catch { /* ignore */ }

			try {
				const tableContainer = contentEl.querySelector ? contentEl.querySelector('.table-container') : null;
				const tableEl = tableContainer && tableContainer.querySelector ? tableContainer.querySelector('table') : null;
				if (tableContainer && tableEl) {
					hasTable = true;
					let tableH = 0;
					try {
						const oh = (typeof tableEl.offsetHeight === 'number') ? tableEl.offsetHeight : 0;
						if (oh && Number.isFinite(oh)) tableH = Math.max(tableH, oh);
					} catch { /* ignore */ }
					try {
						const rh = tableEl.getBoundingClientRect ? (tableEl.getBoundingClientRect().height || 0) : 0;
						if (rh && Number.isFinite(rh)) tableH = Math.max(tableH, rh);
					} catch { /* ignore */ }
					if (!tableH) {
						try {
							const sh = (typeof tableContainer.scrollHeight === 'number') ? tableContainer.scrollHeight : 0;
							if (sh && Number.isFinite(sh)) tableH = Math.max(tableH, sh);
						} catch { /* ignore */ }
					}
					contentPx = Math.max(contentPx, Math.ceil(tableH));
				}
			} catch { /* ignore */ }

			// Non-table URL content: sum child heights.
			if (!contentPx) {
				try {
					const children = contentEl.children ? Array.from(contentEl.children) : [];
					if (children.length) {
						for (const child of children) {
							contentPx += addVisibleRectHeight(child);
						}
					} else {
						// Last resort: fall back to scrollHeight (better than nothing for text-only nodes).
						contentPx = Math.max(contentPx, Math.ceil(contentEl.scrollHeight || 0));
					}
				} catch { /* ignore */ }
			}

			if (!contentPx || !Number.isFinite(contentPx) || contentPx <= 0) return;

			const wrapperH = Math.max(0, Math.ceil(wrapper.getBoundingClientRect().height || 0));
			const overheadPx = Math.max(0, wrapperH - Math.max(0, contentClientH));
			// Keep the same general spacing as before.
			let desiredPx = Math.max(120, Math.min(20000, Math.ceil(overheadPx + contentPx + 10)));
			// For tables, "Fit to contents" must not expand to thousands of rows.
			if (hasTable) {
				desiredPx = Math.max(120, Math.min(900, desiredPx));
			}

			wrapper.style.height = desiredPx + 'px';
			wrapper.style.minHeight = '0';
			try { if (wrapper.dataset) wrapper.dataset.kustoUserResized = 'true'; } catch { /* ignore */ }

			// Best-effort: clamp any slack once layout settles for table content.
			try {
				if (hasTable && typeof window.__kustoClampUrlCsvWrapperHeight === 'function') {
					window.__kustoClampUrlCsvWrapperHeight(id);
				}
			} catch { /* ignore */ }
		} catch { /* ignore */ }
	};

	try {
		applyFitToContent();
		setTimeout(applyFitToContent, 50);
		setTimeout(applyFitToContent, 150);
	} catch { /* ignore */ }
	try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
}

function __kustoEnsureMarkdownModeMap() {
	try {
		if (!window.__kustoMarkdownModeByBoxId || typeof window.__kustoMarkdownModeByBoxId !== 'object') {
			window.__kustoMarkdownModeByBoxId = {};
		}
	} catch {
		// ignore
	}
	return window.__kustoMarkdownModeByBoxId;
}

function __kustoGetMarkdownMode(boxId) {
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

function __kustoSetMarkdownMode(boxId, mode) {
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
	try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
}

function __kustoUpdateMarkdownModeButtons(boxId) {
	const mode = __kustoGetMarkdownMode(boxId);
	const ids = {
		preview: boxId + '_md_mode_preview',
		markdown: boxId + '_md_mode_markdown',
		wysiwyg: boxId + '_md_mode_wysiwyg'
	};
	for (const key of Object.keys(ids)) {
		const btn = document.getElementById(ids[key]);
		if (!btn) continue;
		const active = key === mode;
		try { btn.classList.toggle('is-active', active); } catch { /* ignore */ }
		try { btn.setAttribute('aria-selected', active ? 'true' : 'false'); } catch { /* ignore */ }
	}
}

function __kustoUpdateMarkdownPreviewSizing(boxId) {
	const box = document.getElementById(boxId);
	const editorHost = document.getElementById(boxId + '_md_editor');
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

function __kustoApplyMarkdownEditorMode(boxId) {
	__kustoUpdateMarkdownModeButtons(boxId);

	const box = document.getElementById(boxId);
	const editorHost = document.getElementById(boxId + '_md_editor');
	const viewerHost = document.getElementById(boxId + '_md_viewer');
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

function getToastUiPlugins(ToastEditor) {
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
		if (typeof marked !== 'undefined' && marked) {
			return Promise.resolve(marked);
		}
	} catch {
		// ignore
	}

	if (markdownMarkedResolvePromise) {
		return markdownMarkedResolvePromise;
	}

	markdownMarkedResolvePromise = new Promise((resolve) => {
		try {
			if (typeof require === 'function') {
				require(
					['marked'],
					(m) => {
						try {
							if (typeof marked === 'undefined' || !marked) {
								// Best-effort: make it available as a global for the existing renderer.
								window.marked = m;
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

function autoSizeInputToValue(inputEl, minPx, maxPx) {
	if (!inputEl) {
		return;
	}
	try {
		inputEl.style.width = '1px';
		const pad = 2;
		const w = Math.max(minPx, Math.min(maxPx, (inputEl.scrollWidth || 0) + pad));
		inputEl.style.width = w + 'px';
	} catch {
		// ignore
	}
}

function onUrlNameInput(boxId) {
	const input = document.getElementById(boxId + '_name');
	let minPx = 25;
	try {
		const v = input ? String(input.value || '') : '';
		if (!v.trim()) {
			minPx = 140;
		}
	} catch {
		// ignore
	}
	autoSizeInputToValue(input, minPx, 250);
	try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
}

function __kustoUpdateUrlToggleButton(boxId) {
	const btn = document.getElementById(boxId + '_toggle');
	const st = urlStateByBoxId[boxId];
	if (!btn || !st) {
		return;
	}
	const expanded = !!st.expanded;
	btn.classList.toggle('is-active', expanded);
	btn.setAttribute('aria-selected', expanded ? 'true' : 'false');
	btn.title = expanded ? 'Hide' : 'Show';
	btn.setAttribute('aria-label', expanded ? 'Hide' : 'Show');
}

function addMarkdownBox(options) {
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
			window.__kustoPendingMarkdownTextByBoxId = window.__kustoPendingMarkdownTextByBoxId || {};
			window.__kustoPendingMarkdownTextByBoxId[id] = initialText;
		}
	} catch {
		// ignore
	}

	const container = document.getElementById('queries-container');
	if (!container) {
		return;
	}

	const closeIconSvg =
		'<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" xmlns="http://www.w3.org/2000/svg">' +
		'<path d="M4 4l8 8"/>' +
		'<path d="M12 4L4 12"/>' +
		'</svg>';

	const previewIconSvg =
		'<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">' +
		'<path d="M1.5 8c1.8-3.1 4-4.7 6.5-4.7S12.7 4.9 14.5 8c-1.8 3.1-4 4.7-6.5 4.7S3.3 11.1 1.5 8z" />' +
		'<circle cx="8" cy="8" r="2.1" />' +
		'</svg>';

	const maximizeIconSvg =
		'<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">' +
		'<path d="M3 6V3h3" />' +
		'<path d="M13 10v3h-3" />' +
		'<path d="M3 3l4 4" />' +
		'<path d="M13 13l-4-4" />' +
		'</svg>';

	const boxHtml =
		'<div class="query-box" id="' + id + '">' +
		'<div class="query-header">' +
		'<div class="query-header-row query-header-row-top">' +
		'<div class="query-name-group">' +
		'<button type="button" class="section-drag-handle" draggable="true" title="Drag to reorder" aria-label="Reorder section"><span class="section-drag-handle-glyph" aria-hidden="true">⋮</span></button>' +
		'<input type="text" class="query-name" placeholder="Markdown name (optional)" id="' + id + '_name" oninput="try{schedulePersist&&schedulePersist()}catch{}" />' +
		'</div>' +
		'<div class="section-actions">' +
		'<div class="md-tabs" role="tablist" aria-label="Markdown visibility">' +
		'<button class="unified-btn-secondary md-tab md-mode-btn" id="' + id + '_md_mode_wysiwyg" type="button" role="tab" aria-selected="false" onclick="__kustoSetMarkdownMode(\'' + id + '\', \'wysiwyg\')" title="WYSIWYG" aria-label="WYSIWYG">WYSIWYG</button>' +
		'<button class="unified-btn-secondary md-tab md-mode-btn" id="' + id + '_md_mode_markdown" type="button" role="tab" aria-selected="false" onclick="__kustoSetMarkdownMode(\'' + id + '\', \'markdown\')" title="Markdown" aria-label="Markdown">Markdown</button>' +
		'<button class="unified-btn-secondary md-tab md-mode-btn" id="' + id + '_md_mode_preview" type="button" role="tab" aria-selected="false" onclick="__kustoSetMarkdownMode(\'' + id + '\', \'preview\')" title="Preview" aria-label="Preview">Preview</button>' +
		'<span class="md-tabs-divider" aria-hidden="true"></span>' +
		'<button class="unified-btn-secondary md-tab md-max-btn" id="' + id + '_md_max" type="button" onclick="__kustoMaximizeMarkdownBox(\'' + id + '\')" title="Fit to contents" aria-label="Fit to contents">' + maximizeIconSvg + '</button>' +
		'<button class="unified-btn-secondary md-tab" id="' + id + '_toggle" type="button" role="tab" aria-selected="false" onclick="toggleMarkdownBoxVisibility(\'' + id + '\')" title="Hide" aria-label="Hide">' + previewIconSvg + '</button>' +
		'</div>' +
		'<button class="unified-btn-secondary unified-btn-icon-only refresh-btn close-btn" type="button" onclick="removeMarkdownBox(\'' + id + '\')" title="Remove" aria-label="Remove">' + closeIconSvg + '</button>' +
		'</div>' +
		'</div>' +
		'</div>' +
		'<div class="query-editor-wrapper">' +
		'<div class="query-editor kusto-markdown-editor" id="' + id + '_md_editor"></div>' +
		'<div class="markdown-viewer" id="' + id + '_md_viewer" style="display:none;"></div>' +
		'<div class="query-editor-resizer" id="' + id + '_md_resizer" title="Drag to resize"></div>' +
		'</div>' +
		'</div>';

	container.insertAdjacentHTML('beforeend', boxHtml);
	// Do not auto-assign a name; section names are user-defined.

	// Apply any persisted height before initializing the editor/mode.
	try {
		const h = options && typeof options.editorHeightPx === 'number' ? options.editorHeightPx : undefined;
		// For plain .md files we use a fixed viewport layout (internal editor scrolling),
		// so ignore any persisted wrapper height.
		const isPlainMd = String(window.__kustoDocumentKind || '') === 'md';
		if (!isPlainMd && typeof h === 'number' && Number.isFinite(h) && h > 0) {
			const editorEl = document.getElementById(id + '_md_editor');
			const wrapper = editorEl && editorEl.closest ? editorEl.closest('.query-editor-wrapper') : null;
			if (wrapper) {
				wrapper.style.height = Math.round(h) + 'px';
				try { wrapper.dataset.kustoUserResized = 'true'; } catch { /* ignore */ }
			}
		}
	} catch {
		// ignore
	}

	initMarkdownEditor(id);
	try { __kustoApplyMarkdownEditorMode(id); } catch { /* ignore */ }
	try { __kustoUpdateMarkdownVisibilityToggleButton(id); } catch { /* ignore */ }
	try { __kustoApplyMarkdownBoxVisibility(id); } catch { /* ignore */ }
	// Plain .md files: do not auto-expand the box to content; keep the toolbar visible and
	// scroll inside the editor surface instead.
	try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
	try {
		const isPlainMd = String(window.__kustoDocumentKind || '') === 'md';
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

function __kustoAutoFitMarkdownBoxHeight(boxId) {
	const tryFit = () => {
		try {
			const container = document.getElementById(boxId + '_md_editor');
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

function removeMarkdownBox(boxId) {
	if (markdownEditors[boxId]) {
		try { markdownEditors[boxId].dispose(); } catch { /* ignore */ }
		delete markdownEditors[boxId];
	}
	if (markdownViewers[boxId]) {
		try { markdownViewers[boxId].dispose(); } catch { /* ignore */ }
		delete markdownViewers[boxId];
	}
	markdownBoxes = markdownBoxes.filter(id => id !== boxId);
	const box = document.getElementById(boxId);
	if (box && box.parentNode) {
		box.parentNode.removeChild(box);
	}
	try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
	try {
		if (window.__kustoMarkdownModeByBoxId && typeof window.__kustoMarkdownModeByBoxId === 'object') {
			delete window.__kustoMarkdownModeByBoxId[boxId];
		}
	} catch { /* ignore */ }
}

function __kustoUpdateMarkdownVisibilityToggleButton(boxId) {
	const btn = document.getElementById(boxId + '_toggle');
	if (!btn) {
		return;
	}
	let expanded = true;
	try {
		expanded = !(window.__kustoMarkdownExpandedByBoxId && window.__kustoMarkdownExpandedByBoxId[boxId] === false);
	} catch { /* ignore */ }
	btn.classList.toggle('is-active', expanded);
	btn.setAttribute('aria-selected', expanded ? 'true' : 'false');
	btn.title = expanded ? 'Hide' : 'Show';
	btn.setAttribute('aria-label', expanded ? 'Hide' : 'Show');
}

function __kustoApplyMarkdownBoxVisibility(boxId) {
	const box = document.getElementById(boxId);
	if (!box) {
		return;
	}
	let expanded = true;
	try {
		expanded = !(window.__kustoMarkdownExpandedByBoxId && window.__kustoMarkdownExpandedByBoxId[boxId] === false);
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

function toggleMarkdownBoxVisibility(boxId) {
	try {
		if (!window.__kustoMarkdownExpandedByBoxId || typeof window.__kustoMarkdownExpandedByBoxId !== 'object') {
			window.__kustoMarkdownExpandedByBoxId = {};
		}
		const current = !(window.__kustoMarkdownExpandedByBoxId[boxId] === false);
		window.__kustoMarkdownExpandedByBoxId[boxId] = !current;
	} catch { /* ignore */ }
	try { __kustoUpdateMarkdownVisibilityToggleButton(boxId); } catch { /* ignore */ }
	try { __kustoApplyMarkdownBoxVisibility(boxId); } catch { /* ignore */ }
	try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
}

function initMarkdownViewer(boxId, initialValue) {
	const container = document.getElementById(boxId + '_md_viewer');
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
		ToastEditor = (window.toastui && window.toastui.Editor) ? window.toastui.Editor : null;
	} catch {
		ToastEditor = null;
	}

	if (!ToastEditor) {
		// Webview scripts load sequentially, but keep a small retry loop for safety.
		let attempt = 0;
		try {
			window.__kustoToastUiViewerInitRetryCountByBoxId = window.__kustoToastUiViewerInitRetryCountByBoxId || {};
			attempt = (window.__kustoToastUiViewerInitRetryCountByBoxId[boxId] || 0) + 1;
			window.__kustoToastUiViewerInitRetryCountByBoxId[boxId] = attempt;
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
		const opts = {
			el: container,
			viewer: true,
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
	} catch (e) {
		try { console.error('Failed to initialize TOAST UI Editor (markdown viewer).', e); } catch { /* ignore */ }
		return;
	}

	try { __kustoRewriteToastUiImagesInContainer(container); } catch { /* ignore */ }

	markdownViewers[boxId] = {
		setValue: (value) => {
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

function initMarkdownEditor(boxId) {
	const container = document.getElementById(boxId + '_md_editor');
	const viewer = document.getElementById(boxId + '_md_viewer');
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
		ToastEditor = (window.toastui && window.toastui.Editor) ? window.toastui.Editor : null;
	} catch {
		ToastEditor = null;
	}

	if (!ToastEditor) {
		// Webview scripts load sequentially, but keep a small retry loop for safety.
		let attempt = 0;
		try {
			window.__kustoToastUiInitRetryCountByBoxId = window.__kustoToastUiInitRetryCountByBoxId || {};
			attempt = (window.__kustoToastUiInitRetryCountByBoxId[boxId] || 0) + 1;
			window.__kustoToastUiInitRetryCountByBoxId[boxId] = attempt;
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
		const pending = window.__kustoPendingMarkdownTextByBoxId && window.__kustoPendingMarkdownTextByBoxId[boxId];
		if (typeof pending === 'string') {
			initialValue = pending;
			try { delete window.__kustoPendingMarkdownTextByBoxId[boxId]; } catch { /* ignore */ }
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

	let toastEditor = null;
	try {
		const editorOptions = {
			el: container,
			height: '100%',
			initialEditType: 'wysiwyg',
			previewStyle: 'vertical',
			hideModeSwitch: true,
			usageStatistics: false,
			initialValue,
			plugins: getToastUiPlugins(ToastEditor),
			events: {
				change: () => {
					try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
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
	} catch (e) {
		try { console.error('Failed to initialize TOAST UI Editor (markdown editor).', e); } catch { /* ignore */ }
		return;
	}

	// Intercept Ctrl+S at the DOM level (capture phase) BEFORE ToastUI's keymap handles it.
	// This prevents strikethrough and allows VS Code to handle the save.
	try {
		container.addEventListener('keydown', (ev) => {
			try {
				if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 's') {
					// Prevent ToastUI's strikethrough action.
					ev.stopPropagation();
					// Do NOT call ev.preventDefault() - we want VS Code to handle the save.
				}
			} catch { /* ignore */ }
		}, true); // capture phase - fires before the editor's handlers
	} catch { /* ignore */ }

	// Initial pass (in case the preview has already rendered by the time the hook is attached).
	try { __kustoRewriteToastUiImagesInContainer(container); } catch { /* ignore */ }

	const api = {
		getValue: () => {
			try { return toastEditor && typeof toastEditor.getMarkdown === 'function' ? String(toastEditor.getMarkdown() || '') : ''; } catch { return ''; }
		},
		setValue: (value) => {
			try {
				if (toastEditor && typeof toastEditor.setMarkdown === 'function') {
					toastEditor.setMarkdown(String(value || ''));
				}
			} catch { /* ignore */ }
		},
		layout: () => {
			try {
				if (!toastEditor || typeof toastEditor.setHeight !== 'function') {
					return;
				}
				const wrapper = container.closest ? container.closest('.query-editor-wrapper') : null;
				const resizer = document.getElementById(boxId + '_md_resizer');
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
	try { __kustoApplyMarkdownEditorMode(boxId); } catch { /* ignore */ }
	try { __kustoTryApplyPendingMarkdownReveal(boxId); } catch { /* ignore */ }

	// For multi-section files (.kqlx, .mdx), fix the double-border issue by removing
	// the Toast UI's border (the section wrapper already provides the border).
	try {
		const isPlainMd = String(window.__kustoDocumentKind || '') === 'md';
		console.log('[KUSTO-DEBUG] initMarkdownEditor border fix: isPlainMd=' + isPlainMd + ', documentKind=' + window.__kustoDocumentKind);
		if (!isPlainMd) {
			const defaultUI = container.querySelector('.toastui-editor-defaultUI');
			console.log('[KUSTO-DEBUG] defaultUI found:', !!defaultUI);
			if (defaultUI) {
				defaultUI.style.setProperty('border', 'none', 'important');
				defaultUI.style.setProperty('border-radius', '0', 'important');
				console.log('[KUSTO-DEBUG] Applied border:none to defaultUI');
			}
			const toolbar = container.querySelector('.toastui-editor-defaultUI-toolbar');
			console.log('[KUSTO-DEBUG] toolbar found:', !!toolbar);
			if (toolbar) {
				// Use negative margin to overlap the wrapper border
				toolbar.style.setProperty('margin', '-1px -1px 0 -1px', 'important');
				toolbar.style.setProperty('border-radius', '0', 'important');
				console.log('[KUSTO-DEBUG] Applied negative margin to toolbar');
			}
		}
	} catch (e) { console.error('[KUSTO-DEBUG] border fix error:', e); }

	// Ensure theme switches (dark/light) are reflected without recreating the editor.
	try { __kustoStartToastUiThemeObserver(); } catch { /* ignore */ }
	try { __kustoApplyToastUiThemeAll(); } catch { /* ignore */ }

	// Drag handle resize (same pattern as the KQL editor).
	try {
		const wrapper = container.closest ? container.closest('.query-editor-wrapper') : null;
		const resizer = document.getElementById(boxId + '_md_resizer');
		if (wrapper && resizer) {
			resizer.addEventListener('mousedown', (e) => {
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

				const startPageY = e.clientY + (typeof __kustoGetScrollY === 'function' ? __kustoGetScrollY() : 0);
				const startHeight = wrapper.getBoundingClientRect().height;

				const onMove = (moveEvent) => {
					try {
						if (typeof __kustoMaybeAutoScrollWhileDragging === 'function') {
							__kustoMaybeAutoScrollWhileDragging(moveEvent.clientY);
						}
					} catch { /* ignore */ }
					const pageY = moveEvent.clientY + (typeof __kustoGetScrollY === 'function' ? __kustoGetScrollY() : 0);
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
					try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
				};

				document.addEventListener('mousemove', onMove, true);
				document.addEventListener('mouseup', onUp, true);
			});
		}
	} catch {
		// ignore
	}

	// Ensure correct initial sizing.
	try { api.layout(); } catch { /* ignore */ }
}

function __kustoRewriteToastUiImagesInContainer(rootEl) {
	try {
		if (!rootEl || !rootEl.querySelectorAll) {
			return;
		}
		const baseUri = (() => {
			try {
				return (typeof window.__kustoDocumentUri === 'string') ? String(window.__kustoDocumentUri) : '';
			} catch {
				return '';
			}
		})();
		if (!baseUri) {
			return;
		}

		// Cache across renders to avoid spamming the extension host.
		window.__kustoResolvedImageSrcCache = window.__kustoResolvedImageSrcCache || {};
		const cache = window.__kustoResolvedImageSrcCache;

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
					lower.startsWith('data:') ||
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

				const resolver = window.__kustoResolveResourceUri;
				if (typeof resolver !== 'function') {
					continue;
				}

				// Fire-and-forget async resolve; preview is re-rendered frequently.
				resolver({ path: src, baseUri }).then((resolved) => {
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

function addPythonBox(options) {
	const id = (options && options.id) ? String(options.id) : ('python_' + Date.now());
	pythonBoxes.push(id);

	const container = document.getElementById('queries-container');
	if (!container) {
		return;
	}

	const closeIconSvg =
		'<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" xmlns="http://www.w3.org/2000/svg">' +
		'<path d="M4 4l8 8"/>' +
		'<path d="M12 4L4 12"/>' +
		'</svg>';

	const maximizeIconSvg =
		'<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">' +
		'<path d="M3 6V3h3" />' +
		'<path d="M13 10v3h-3" />' +
		'<path d="M3 3l4 4" />' +
		'<path d="M13 13l-4-4" />' +
		'</svg>';

	const boxHtml =
		'<div class="query-box" id="' + id + '">' +
		'<div class="section-header-row">' +
		'<button type="button" class="section-drag-handle" draggable="true" title="Drag to reorder" aria-label="Reorder section"><span class="section-drag-handle-glyph" aria-hidden="true">⋮</span></button>' +
		'<div class="section-title">Python</div>' +
		'<div class="section-actions">' +
		'<div class="md-tabs" role="tablist" aria-label="Python controls">' +
		'<button class="unified-btn-secondary md-tab md-max-btn" id="' + id + '_max" type="button" onclick="__kustoMaximizePythonBox(\'' + id + '\')" title="Fit to contents" aria-label="Fit to contents">' + maximizeIconSvg + '</button>' +
		'</div>' +
		'<button class="section-btn" type="button" onclick="runPythonBox(\'' + id + '\')" title="Run Python">▶ Run</button>' +
		'<button class="unified-btn-secondary unified-btn-icon-only section-btn" type="button" onclick="removePythonBox(\'' + id + '\')" title="Remove" aria-label="Remove">' + closeIconSvg + '</button>' +
		'</div>' +
		'</div>' +
		'<div class="query-editor-wrapper">' +
		'<div class="query-editor" id="' + id + '_py_editor"></div>' +
		'<div class="query-editor-resizer" id="' + id + '_py_resizer" title="Drag to resize editor"></div>' +
		'</div>' +
		'<div class="python-output" id="' + id + '_py_output" aria-label="Python output"></div>' +
		'</div>';

	container.insertAdjacentHTML('beforeend', boxHtml);
	// Do not auto-assign a name; this section type does not use names.
	initPythonEditor(id);
	setPythonOutput(id, '');
	try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
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

function removePythonBox(boxId) {
	if (pythonEditors[boxId]) {
		try { pythonEditors[boxId].dispose(); } catch { /* ignore */ }
		delete pythonEditors[boxId];
	}
	pythonBoxes = pythonBoxes.filter(id => id !== boxId);
	const box = document.getElementById(boxId);
	if (box && box.parentNode) {
		box.parentNode.removeChild(box);
	}
	try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
}

function initPythonEditor(boxId) {
	return ensureMonaco().then(monaco => {
		const container = document.getElementById(boxId + '_py_editor');
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
			const pending = window.__kustoPendingPythonCodeByBoxId && window.__kustoPendingPythonCodeByBoxId[boxId];
			if (typeof pending === 'string') {
				initialValue = pending;
				try { delete window.__kustoPendingPythonCodeByBoxId[boxId]; } catch { /* ignore */ }
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
					try { activeMonacoEditor = editor; } catch { /* ignore */ }
					try {
						if (typeof __kustoForceEditorWritable === 'function') {
							__kustoForceEditorWritable(editor);
						}
					} catch { /* ignore */ }
				});
			}
			if (typeof editor.onDidFocusEditorWidget === 'function') {
				editor.onDidFocusEditorWidget(() => {
					try { activeMonacoEditor = editor; } catch { /* ignore */ }
					try {
						if (typeof __kustoForceEditorWritable === 'function') {
							__kustoForceEditorWritable(editor);
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
			if (typeof __kustoEnsureEditorWritableSoon === 'function') {
				__kustoEnsureEditorWritableSoon(editor);
			}
		} catch {
			// ignore
		}
		try {
			if (typeof __kustoInstallWritableGuard === 'function') {
				__kustoInstallWritableGuard(editor);
			}
		} catch {
			// ignore
		}
		// If the editor is stuck non-interactive on click, force writable before focusing.
		try {
			container.addEventListener('mousedown', () => {
				try {
					if (typeof __kustoForceEditorWritable === 'function') {
						__kustoForceEditorWritable(editor);
					}
				} catch { /* ignore */ }
				try { editor.focus(); } catch { /* ignore */ }
			}, true);
		} catch {
			// ignore
		}
		// Auto-resize editor to show full content, until the user manually resizes.
		try {
			if (typeof __kustoAttachAutoResizeToContent === 'function') {
				__kustoAttachAutoResizeToContent(editor, container);
			}
		} catch {
			// ignore
		}
		try {
			editor.onDidChangeModelContent(() => {
				try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
			});
		} catch {
			// ignore
		}

		// Drag handle resize (copied from KQL editor behavior).
		try {
			const wrapper = container.closest ? container.closest('.query-editor-wrapper') : null;
			const resizer = document.getElementById(boxId + '_py_resizer');
			if (wrapper && resizer) {
				resizer.addEventListener('mousedown', (e) => {
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

						const startPageY = e.clientY + (typeof __kustoGetScrollY === 'function' ? __kustoGetScrollY() : 0);
					const startHeight = wrapper.getBoundingClientRect().height;

					const onMove = (moveEvent) => {
							try {
								if (typeof __kustoMaybeAutoScrollWhileDragging === 'function') {
									__kustoMaybeAutoScrollWhileDragging(moveEvent.clientY);
								}
							} catch { /* ignore */ }
							const pageY = moveEvent.clientY + (typeof __kustoGetScrollY === 'function' ? __kustoGetScrollY() : 0);
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
						try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
					};

					document.addEventListener('mousemove', onMove, true);
					document.addEventListener('mouseup', onUp, true);
				});
			}
		} catch {
			// ignore
		}
	}).catch((e) => {
		try {
			if (pythonEditors && pythonEditors[boxId]) {
				return;
			}
		} catch {
			// ignore
		}

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

function setPythonOutput(boxId, text) {
	const out = document.getElementById(boxId + '_py_output');
	if (!out) {
		return;
	}
	out.textContent = String(text || '');
}

function runPythonBox(boxId) {
	const editor = pythonEditors[boxId];
	if (!editor) {
		return;
	}
	const model = editor.getModel();
	const code = model ? model.getValue() : '';
	setPythonOutput(boxId, 'Running…');
	try {
		vscode.postMessage({ type: 'executePython', boxId, code });
	} catch (e) {
		setPythonOutput(boxId, 'Failed to send run request.');
	}
}

function onPythonResult(message) {
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

function onPythonError(message) {
	const boxId = message && message.boxId ? String(message.boxId) : '';
	if (!boxId) {
		return;
	}
	setPythonOutput(boxId, String(message.error || 'Python execution failed.'));
}

function addUrlBox(options) {
	const id = (options && options.id) ? String(options.id) : ('url_' + Date.now());
	urlBoxes.push(id);
	// Default to collapsed (view off) so a new URL section is as small as possible.
	urlStateByBoxId[id] = { url: '', expanded: false, loading: false, loaded: false, content: '', error: '', kind: '', contentType: '', status: null, dataUri: '', body: '', truncated: false };

	const container = document.getElementById('queries-container');
	if (!container) {
		return;
	}

	const closeIconSvg =
		'<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" xmlns="http://www.w3.org/2000/svg">' +
		'<path d="M4 4l8 8"/>' +
		'<path d="M12 4L4 12"/>' +
		'</svg>';

	const previewIconSvg =
		'<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">' +
		'<path d="M1.5 8c1.8-3.1 4-4.7 6.5-4.7S12.7 4.9 14.5 8c-1.8 3.1-4 4.7-6.5 4.7S3.3 11.1 1.5 8z" />' +
		'<circle cx="8" cy="8" r="2.1" />' +
		'</svg>';

	const maximizeIconSvg =
		'<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">' +
		'<path d="M3 6V3h3" />' +
		'<path d="M13 10v3h-3" />' +
		'<path d="M3 3l4 4" />' +
		'<path d="M13 13l-4-4" />' +
		'</svg>';

	const boxHtml =
		'<div class="query-box url-box" id="' + id + '">' +
		'<div class="section-header-row url-section-header">' +
		'<button type="button" class="section-drag-handle" draggable="true" title="Drag to reorder" aria-label="Reorder section"><span class="section-drag-handle-glyph" aria-hidden="true">⋮</span></button>' +
		'<input class="query-name url-name" id="' + id + '_name" type="text" placeholder="URL name (optional)" oninput="onUrlNameInput(\'' + id + '\')" />' +
		'<input class="url-input" id="' + id + '_input" type="text" placeholder="https://example.com" oninput="onUrlChanged(\'' + id + '\')" />' +
		'<div class="section-actions">' +
		'<div class="md-tabs" role="tablist" aria-label="URL visibility">' +
		'<button class="unified-btn-secondary md-tab md-max-btn" id="' + id + '_max" type="button" onclick="__kustoMaximizeUrlBox(\'' + id + '\')" title="Fit to contents" aria-label="Fit to contents">' + maximizeIconSvg + '</button>' +
		'<button class="unified-btn-secondary md-tab" id="' + id + '_toggle" type="button" role="tab" aria-selected="false" onclick="toggleUrlBox(\'' + id + '\')" title="Show" aria-label="Show">' + previewIconSvg + '</button>' +
		'</div>' +
		'<button class="unified-btn-secondary unified-btn-icon-only refresh-btn close-btn" type="button" onclick="removeUrlBox(\'' + id + '\')" title="Remove" aria-label="Remove">' + closeIconSvg + '</button>' +
		'</div>' +
		'</div>' +
		'<div class="url-output-wrapper" id="' + id + '_wrapper">' +
		'<div class="url-output" id="' + id + '_content" aria-label="URL content"></div>' +
		'<div class="query-editor-resizer" id="' + id + '_url_resizer" title="Drag to resize"></div>' +
		'</div>' +
		'</div>';

	container.insertAdjacentHTML('beforeend', boxHtml);
	try { __kustoUpdateUrlToggleButton(id); } catch { /* ignore */ }
	try { updateUrlContent(id); } catch { /* ignore */ }
	try { onUrlNameInput(id); } catch { /* ignore */ }

	// Ensure an explicit minimum height is present so it round-trips through persistence.
	// (When collapsed, the wrapper is display:none so it doesn't affect layout.)
	try {
		const wrapper = document.getElementById(id + '_wrapper');
		if (wrapper && (!wrapper.style.height || wrapper.style.height === 'auto')) {
			wrapper.style.height = '120px';
		}
	} catch { /* ignore */ }

	// Drag handle resize for URL output.
	try {
		const wrapper = document.getElementById(id + '_wrapper');
		const resizer = document.getElementById(id + '_url_resizer');
		if (wrapper && resizer) {
			resizer.addEventListener('mousedown', (e) => {
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

				const startPageY = e.clientY + (typeof __kustoGetScrollY === 'function' ? __kustoGetScrollY() : 0);
				const startHeight = wrapper.getBoundingClientRect().height;
				// If the wrapper was auto-sized (e.g. URL CSV fitting its contents), freeze the
				// current pixel height so resizing doesn't immediately jump.
				try {
					wrapper.style.height = Math.max(0, Math.ceil(startHeight)) + 'px';
				} catch { /* ignore */ }

				const minH = 120;
				const maxH = 900;

				const onMove = (moveEvent) => {
					try {
						if (typeof __kustoMaybeAutoScrollWhileDragging === 'function') {
							__kustoMaybeAutoScrollWhileDragging(moveEvent.clientY);
						}
					} catch { /* ignore */ }
					const pageY = moveEvent.clientY + (typeof __kustoGetScrollY === 'function' ? __kustoGetScrollY() : 0);
					const delta = pageY - startPageY;
					const nextHeight = Math.max(minH, Math.min(maxH, startHeight + delta));
					wrapper.style.height = nextHeight + 'px';
				};
				const onUp = () => {
					document.removeEventListener('mousemove', onMove, true);
					document.removeEventListener('mouseup', onUp, true);
					resizer.classList.remove('is-dragging');
					document.body.style.cursor = previousCursor;
					document.body.style.userSelect = previousUserSelect;
					try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
				};

				document.addEventListener('mousemove', onMove, true);
				document.addEventListener('mouseup', onUp, true);
			});
		}
	} catch {
		// ignore
	}

	try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
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

function removeUrlBox(boxId) {
	delete urlStateByBoxId[boxId];
	urlBoxes = urlBoxes.filter(id => id !== boxId);
	const box = document.getElementById(boxId);
	if (box && box.parentNode) {
		box.parentNode.removeChild(box);
	}
	try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
}

function onUrlChanged(boxId) {
	const input = document.getElementById(boxId + '_input');
	if (!input) {
		return;
	}
	const url = String(input.value || '').trim();
	if (!urlStateByBoxId[boxId]) {
		urlStateByBoxId[boxId] = { url: '', expanded: false, loading: false, loaded: false, content: '', error: '', kind: '', contentType: '', status: null, dataUri: '', body: '', truncated: false };
	}
	urlStateByBoxId[boxId].url = url;
	urlStateByBoxId[boxId].loaded = false;
	urlStateByBoxId[boxId].content = '';
	urlStateByBoxId[boxId].error = '';
	urlStateByBoxId[boxId].kind = '';
	urlStateByBoxId[boxId].contentType = '';
	urlStateByBoxId[boxId].status = null;
	urlStateByBoxId[boxId].dataUri = '';
	urlStateByBoxId[boxId].body = '';
	urlStateByBoxId[boxId].truncated = false;
	try { urlStateByBoxId[boxId].__hasFetchedOnce = false; } catch { /* ignore */ }
	try { urlStateByBoxId[boxId].__autoSizeImagePending = false; } catch { /* ignore */ }
	try { urlStateByBoxId[boxId].__autoSizedImageOnce = false; } catch { /* ignore */ }
	updateUrlContent(boxId);
	if (urlStateByBoxId[boxId].expanded && url) {
		requestUrlContent(boxId);
	}
	try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
}

function toggleUrlBox(boxId) {
	if (!urlStateByBoxId[boxId]) {
		urlStateByBoxId[boxId] = { url: '', expanded: true, loading: false, loaded: false, content: '', error: '', kind: '', contentType: '', status: null, dataUri: '', body: '', truncated: false };
	}
	urlStateByBoxId[boxId].expanded = !urlStateByBoxId[boxId].expanded;
	try { __kustoUpdateUrlToggleButton(boxId); } catch { /* ignore */ }
	updateUrlContent(boxId);
	if (urlStateByBoxId[boxId].expanded && urlStateByBoxId[boxId].url) {
		requestUrlContent(boxId);
	}
	try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
}

function __kustoClearElement(el) {
	try {
		while (el && el.firstChild) {
			el.removeChild(el.firstChild);
		}
	} catch {
		// ignore
	}
}

function __kustoParseCsv(text) {
	// Minimal CSV parser (RFC 4180-ish): supports quoted fields, commas, and newlines.
	const rows = [];
	let row = [];
	let field = '';
	let inQuotes = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		const next = text[i + 1];
		if (inQuotes) {
			if (ch === '"' && next === '"') {
				field += '"';
				i++;
				continue;
			}
			if (ch === '"') {
				inQuotes = false;
				continue;
			}
			field += ch;
			continue;
		}
		if (ch === '"') {
			inQuotes = true;
			continue;
		}
		if (ch === ',') {
			row.push(field);
			field = '';
			continue;
		}
		if (ch === '\r') {
			// Treat CRLF or CR-only line endings as row breaks.
			if (next === '\n') {
				i++;
			}
			row.push(field);
			rows.push(row);
			row = [];
			field = '';
			continue;
		}
		if (ch === '\n' || ch === '\u2028' || ch === '\u2029') {
			row.push(field);
			rows.push(row);
			row = [];
			field = '';
			continue;
		}
		field += ch;
	}
	row.push(field);
	rows.push(row);
	return rows;
}

function __kustoLooksLikeHtmlText(text) {
	try {
		const s = String(text || '').slice(0, 4096).trimStart().toLowerCase();
		return s.startsWith('<!doctype html') || s.startsWith('<html') || s.startsWith('<head') || s.startsWith('<body');
	} catch {
		return false;
	}
}

// Clamp the URL output wrapper height so it cannot be taller than its table contents.
// This avoids blank slack below short tables while still allowing the user to resize
// smaller than contents (scrolling).
function __kustoClampUrlCsvWrapperHeight(boxId) {
	try {
		const id = String(boxId || '').trim();
		if (!id) return;
		const wrapper = document.getElementById(id + '_wrapper');
		const contentEl = document.getElementById(id + '_content');
		if (!wrapper || !contentEl) return;
		const tableContainer = contentEl.querySelector ? contentEl.querySelector('.table-container') : null;
		if (!tableContainer) return;

		const wrapperH = Math.max(0, Math.ceil(wrapper.getBoundingClientRect().height || 0));
		const tcClientH = Math.max(0, (tableContainer.clientHeight || 0));
		const tcScrollH = Math.max(0, (tableContainer.scrollHeight || 0));
		if (!tcScrollH) return;

		const overheadPx = Math.max(0, wrapperH - tcClientH);
		const desiredPx = Math.max(0, Math.ceil(overheadPx + tcScrollH + 10));
		if (!desiredPx) return;

		if (wrapperH > (desiredPx + 1)) {
			wrapper.style.height = desiredPx + 'px';
			wrapper.style.minHeight = '0';
			try {
				if (wrapper.dataset && wrapper.dataset.kustoUserResized === 'true') {
					wrapper.dataset.kustoPrevHeight = wrapper.style.height;
				}
			} catch { /* ignore */ }
		}
	} catch {
		// ignore
	}
}

try {
	window.__kustoClampUrlCsvWrapperHeight = __kustoClampUrlCsvWrapperHeight;
} catch { /* ignore */ }

function __kustoRenderUrlContent(contentEl, st) {
	try {
		__kustoClearElement(contentEl);
		// Default for rich render.
		try { contentEl.style.whiteSpace = 'normal'; } catch { /* ignore */ }
		// Reset any mode-specific layout from previous renders.
		try { contentEl.style.overflow = ''; } catch { /* ignore */ }
		try { contentEl.style.display = ''; } catch { /* ignore */ }
		try { contentEl.style.flexDirection = ''; } catch { /* ignore */ }

		const kind = String(st.kind || '').toLowerCase();
		if (kind === 'image' && st.dataUri) {
			const img = document.createElement('img');
			// If this is the first fetch and the user hasn't resized, auto-size the wrapper to fit the image.
			const boxId = (() => {
				try {
					const id = contentEl && contentEl.id ? String(contentEl.id) : '';
					return id.endsWith('_content') ? id.slice(0, -('_content'.length)) : '';
				} catch {
					return '';
				}
			})();
			try {
				if (boxId && st.__autoSizeImagePending && !st.__autoSizedImageOnce) {
					img.addEventListener('load', () => {
						try {
							const wrapper = document.getElementById(boxId + '_wrapper');
							if (!wrapper) return;

							// Only auto-expand when the wrapper is still at the minimum height.
							// This intentionally also covers "restored" heights that equal the minimum.
							let currentH = 0;
							try { currentH = wrapper.getBoundingClientRect().height; } catch { /* ignore */ }
							const minH = 120;
							if (currentH && currentH > (minH + 1)) {
								st.__autoSizeImagePending = false;
								st.__autoSizedImageOnce = true;
								return;
							}

							// Ensure layout is up to date before measuring.
							setTimeout(() => {
								try {
									const resizer = document.getElementById(boxId + '_url_resizer');
									const resizerH = resizer ? resizer.getBoundingClientRect().height : 12;
									const imgH = img.getBoundingClientRect().height;
									if (!imgH || !isFinite(imgH)) return;
									const maxH = 3000;
									const nextH = Math.max(minH, Math.min(maxH, Math.ceil(imgH + resizerH)));
									wrapper.style.height = nextH + 'px';
									try { wrapper.dataset.kustoUserResized = 'true'; } catch { /* ignore */ }
									st.__autoSizeImagePending = false;
									st.__autoSizedImageOnce = true;
									try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
								} catch { /* ignore */ }
							}, 0);
						} catch { /* ignore */ }
					}, { once: true });
				}
			} catch {
				// ignore
			}

			img.src = String(st.dataUri);
			img.alt = 'Image';
			img.style.maxWidth = '100%';
			img.style.height = 'auto';
			img.style.display = 'block';
			contentEl.appendChild(img);
			return;
		}

		if (kind === 'csv' && typeof st.body === 'string') {
			// Defensive: some endpoints return HTML (auth/error pages) even when the URL ends with .csv.
			if (__kustoLooksLikeHtmlText(st.body)) {
				try { contentEl.style.whiteSpace = 'pre-wrap'; } catch { /* ignore */ }
				const pre = document.createElement('pre');
				pre.style.whiteSpace = 'pre-wrap';
				pre.style.margin = '0';
				pre.textContent = 'This URL returned HTML instead of CSV. Try using a raw download link.\n\n' + String(st.body || '').slice(0, 2000);
				contentEl.appendChild(pre);
				return;
			}

			// Match the query-results UX: summary row stays fixed; table scrolls.
			const boxId = (() => {
				try {
					const id = contentEl && contentEl.id ? String(contentEl.id) : '';
					return id.endsWith('_content') ? id.slice(0, -('_content'.length)) : '';
				} catch {
					return '';
				}
			})();

			const csvRows = __kustoParseCsv(st.body);
			const maxSaneCols = 2000;
			try {
				if (csvRows && csvRows[0] && Array.isArray(csvRows[0]) && csvRows[0].length > maxSaneCols) {
					try { contentEl.style.whiteSpace = 'pre-wrap'; } catch { /* ignore */ }
					const pre = document.createElement('pre');
					pre.style.whiteSpace = 'pre-wrap';
					pre.style.margin = '0';
					pre.textContent = `This doesn't look like a normal CSV (detected ${csvRows[0].length} columns). Showing as text instead.\n\n` + String(st.body || '').slice(0, 2000);
					contentEl.appendChild(pre);
					return;
				}
			} catch { /* ignore */ }
			let columns = [];
			let dataRows = [];
			if (csvRows.length > 0) {
				columns = Array.isArray(csvRows[0]) ? csvRows[0].map((c) => String(c ?? '')) : [];
				dataRows = csvRows.slice(1);
			}

			// Normalize ragged rows and ensure we have enough columns.
			let maxCols = columns.length;
			for (const r of dataRows) {
				if (Array.isArray(r) && r.length > maxCols) {
					maxCols = r.length;
				}
			}
			for (let i = columns.length; i < maxCols; i++) {
				columns.push('Column ' + (i + 1));
			}
			dataRows = dataRows.map((r) => {
				const row = Array.isArray(r) ? r : [];
				const out = new Array(maxCols);
				for (let i = 0; i < maxCols; i++) {
					out[i] = String(row[i] ?? '');
				}
				return out;
			});

			// Reuse the same tabular control as Kusto query results.
			// IMPORTANT: this runs inside the URL/CSV output area, which is separate from the main
			// query results area for the same query box. If we reuse the same `boxId`, the generated
			// DOM ids (e.g. `${boxId}_table_container`) collide and virtualization/sort/scroll rerenders
			// can target the wrong (hidden) table. Use a stable synthetic id instead.
			if (boxId && typeof displayResultForBox === 'function') {
				const tableBoxId = String(boxId) + '__url_output_table';
				const resultsDiv = document.createElement('div');
				resultsDiv.className = 'results visible';
				resultsDiv.id = tableBoxId + '_results';
				contentEl.appendChild(resultsDiv);

				displayResultForBox(
					{ columns: columns, rows: dataRows, metadata: {} },
					tableBoxId,
					{ label: 'CSV', showExecutionTime: false, resultsDiv: resultsDiv }
				);

				// Prevent nested scrollbars: for table content, the table container is the only scroller.
				try { contentEl.style.overflow = 'hidden'; } catch { /* ignore */ }

				return;
			}

			// Fallback: simple table if the tabular module isn't available.
			const wrapper = document.createElement('div');
			wrapper.className = 'url-table-container';
			const table = document.createElement('table');
			const thead = document.createElement('thead');
			const tbody = document.createElement('tbody');

			const headerRow = document.createElement('tr');
			for (const h of columns) {
				const th = document.createElement('th');
				th.textContent = String(h ?? '');
				headerRow.appendChild(th);
			}
			thead.appendChild(headerRow);

			for (const r of dataRows) {
				const tr = document.createElement('tr');
				for (const cell of r) {
					const td = document.createElement('td');
					td.textContent = String(cell ?? '');
					tr.appendChild(td);
				}
				tbody.appendChild(tr);
			}

			table.appendChild(thead);
			table.appendChild(tbody);
			wrapper.appendChild(table);
			contentEl.appendChild(wrapper);
			// Prevent nested scrollbars for the fallback table too.
			try { contentEl.style.overflow = 'hidden'; } catch { /* ignore */ }
			return;
		}

		if (kind === 'html' && typeof st.body === 'string') {
			// Render the page in an iframe using srcdoc, sanitized via DOMPurify if available.
			let html = String(st.body);
			try {
				const base = st.url ? ('<base href="' + String(st.url).replace(/"/g, '&quot;') + '">') : '';
				html = base + html;
			} catch { /* ignore */ }
			try {
				if (window.DOMPurify && typeof window.DOMPurify.sanitize === 'function') {
					html = window.DOMPurify.sanitize(html, {
						ADD_TAGS: ['base'],
						ADD_ATTR: ['href', 'target', 'rel']
					});
				}
			} catch {
				// ignore
			}
			const iframe = document.createElement('iframe');
			iframe.style.width = '100%';
			iframe.style.height = '300px';
			iframe.style.border = 'none';
			iframe.setAttribute('sandbox', '');
			iframe.setAttribute('referrerpolicy', 'no-referrer');
			iframe.srcdoc = html;
			contentEl.appendChild(iframe);
			return;
		}

		// Default: show as text.
		try { contentEl.style.whiteSpace = 'pre-wrap'; } catch { /* ignore */ }
		const pre = document.createElement('pre');
		pre.style.whiteSpace = 'pre-wrap';
		pre.style.margin = '0';
		pre.textContent = String(st.body || st.content || '');
		contentEl.appendChild(pre);
	} catch {
		// ignore
	}
}

function updateUrlContent(boxId) {
	const boxEl = document.getElementById(boxId);
	const wrapperEl = document.getElementById(boxId + '_wrapper');
	const contentEl = document.getElementById(boxId + '_content');
	const st = urlStateByBoxId[boxId];
	if (!wrapperEl || !contentEl || !st) {
		return;
	}
	try {
		if (boxEl && boxEl.classList) {
			boxEl.classList.toggle('is-url-collapsed', !st.expanded);
		}
	} catch { /* ignore */ }
	wrapperEl.classList.toggle('url-collapsed', !st.expanded);
	if (!st.expanded) {
		return;
	}
	if (st.loading) {
		try { contentEl.style.overflow = ''; } catch { /* ignore */ }
		try { contentEl.style.whiteSpace = 'pre-wrap'; } catch { /* ignore */ }
		contentEl.textContent = 'Loading…';
		return;
	}
	if (st.error) {
		try { contentEl.style.overflow = ''; } catch { /* ignore */ }
		try { contentEl.style.whiteSpace = 'pre-wrap'; } catch { /* ignore */ }
		contentEl.textContent = st.error;
		return;
	}
	if (st.loaded) {
		__kustoRenderUrlContent(contentEl, st);
		return;
	}
	try { contentEl.style.whiteSpace = 'pre-wrap'; } catch { /* ignore */ }
	try { contentEl.style.overflow = ''; } catch { /* ignore */ }
	contentEl.textContent = st.url ? 'Ready to load.' : 'Enter a URL above.';
}

function requestUrlContent(boxId) {
	const st = urlStateByBoxId[boxId];
	if (!st || st.loading || st.loaded) {
		return;
	}
	const url = String(st.url || '').trim();
	if (!url) {
		return;
	}
	st.loading = true;
	st.error = '';
	updateUrlContent(boxId);
	try {
		vscode.postMessage({ type: 'fetchUrl', boxId, url });
	} catch {
		st.loading = false;
		st.error = 'Failed to request URL.';
		updateUrlContent(boxId);
	}
}

function onUrlContent(message) {
	const boxId = message && message.boxId ? String(message.boxId) : '';
	if (!boxId || !urlStateByBoxId[boxId]) {
		return;
	}
	const st = urlStateByBoxId[boxId];
	st.loading = false;
	st.loaded = true;
	st.error = '';
	st.url = String(message.url || st.url || '');
	st.contentType = String(message.contentType || st.contentType || '');
	st.status = (typeof message.status === 'number') ? message.status : (st.status ?? null);
	st.kind = String(message.kind || '').toLowerCase();
	st.truncated = !!message.truncated;
	st.dataUri = String(message.dataUri || '');
	st.body = (typeof message.body === 'string') ? message.body : '';
	// Track first successful fetch; used for one-time auto-sizing of images.
	try {
		if (!st.__hasFetchedOnce) {
			st.__hasFetchedOnce = true;
			if (st.kind === 'image') {
				st.__autoSizeImagePending = true;
			}
		}
	} catch { /* ignore */ }
	// Keep a simple fallback string for older rendering.
	st.content = st.body || '';

	// Do not auto-expand/shrink the URL wrapper when content arrives.
	updateUrlContent(boxId);
}

function onUrlError(message) {
	const boxId = message && message.boxId ? String(message.boxId) : '';
	if (!boxId || !urlStateByBoxId[boxId]) {
		return;
	}
	const st = urlStateByBoxId[boxId];
	st.loading = false;
	st.loaded = false;
	st.content = '';
	st.error = String(message.error || 'Failed to load URL.');
	updateUrlContent(boxId);
}
