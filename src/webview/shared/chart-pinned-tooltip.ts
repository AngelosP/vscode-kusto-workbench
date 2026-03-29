// Interactive hover tooltip for ECharts XY charts.
// Replaces the built-in axis tooltip with a rich, interactive panel.
// Shown on hover, stays while mouse is over the tooltip, supports sort,
// search, and click-to-highlight.
// Pure ES module — no window bridges.

import { escapeHtml } from '../core/utils';
import { formatNumber } from './chart-utils.js';

// ── Types ─────────────────────────────────────────────────────────────────────

interface TooltipRow {
	color: string;
	seriesName: string;
	value: number | null;
	formattedValue: string;
	seriesIndex: number;
}

interface TooltipData {
	title: string;
	dataIndex: number;
	rows: TooltipRow[];
	extraPayload: Record<string, string> | null;
}

type SortField = '' | 'name' | 'value';
type SortDir = '' | 'asc' | 'desc';

interface HoverState {
	chartId: string;
	el: HTMLElement;
	hideTimer: number;
	data: TooltipData;
	sortField: SortField;
	sortDir: SortDir;
	searchTerm: string;
	inst: any;
	needsUpdate: boolean;
}

// ── State ─────────────────────────────────────────────────────────────────────

const _states = new Map<string, HoverState>();

// ── Constants ─────────────────────────────────────────────────────────────────

const SORT_ASC = '&#9650;';   // ▲
const SORT_DESC = '&#9660;';  // ▼
const SORT_NONE = '<span style="opacity:0.35">&#8693;</span>'; // ⇕

const CLOSE_ICON = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M8 8.707l3.646 3.647.708-.707L8.707 8l3.647-3.646-.707-.708L8 7.293 4.354 3.646l-.708.708L7.293 8l-3.647 3.646.708.708L8 8.707z"/></svg>';

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Called from the ECharts formatter callback.
 * Builds tooltip data from params and flags the tooltip for update.
 */
export function handleTooltipFormatter(
	chartId: string,
	params: any[],
	stackMode: string,
): void {
	if (!params?.length) return;
	const dataIndex = params[0]?.dataIndex;
	if (typeof dataIndex !== 'number' || dataIndex < 0) return;

	const data = _buildData(params, dataIndex, stackMode);
	let state = _states.get(chartId);

	if (state) {
		_cancelHide(state);
		if (state.data.dataIndex !== dataIndex) {
			state.data = data;
			state.searchTerm = '';
			state.needsUpdate = true;
		}
		// Same data index → no content change (user may be interacting)
	} else {
		const wrapper = document.getElementById(chartId + '_chart_wrapper');
		if (!wrapper) return;

		const el = _createTooltipElement(chartId);
		wrapper.style.position = 'relative';
		wrapper.appendChild(el);

		state = {
			chartId,
			el,
			hideTimer: 0,
			data,
			sortField: '',
			sortDir: '',
			searchTerm: '',
			inst: null,
			needsUpdate: true,
		};
		_states.set(chartId, state);
	}
}

/**
 * Called from the ECharts position callback.
 * Renders content (if flagged) and positions the tooltip.
 * @param chartRelX  X coordinate relative to the ECharts container element
 * @param chartRelY  Y coordinate relative to the ECharts container element
 * @param inst       The ECharts instance (for highlight/downplay and getDom)
 */
export function handleTooltipPosition(
	chartId: string,
	chartRelX: number,
	chartRelY: number,
	inst: any,
): void {
	const state = _states.get(chartId);
	if (!state) return;

	state.inst = inst;

	if (state.needsUpdate) {
		_renderContent(state);
		state.needsUpdate = false;
		_positionElement(state, chartRelX, chartRelY);
	}
}

/** Schedule tooltip dismissal after a short delay. */
export function scheduleHideTooltip(chartId: string): void {
	const state = _states.get(chartId);
	if (!state) return;
	_cancelHide(state);
	state.hideTimer = window.setTimeout(() => _destroyState(chartId), 200);
}

/** Immediately dismiss the hover tooltip for a specific chart, or all. */
export function dismissHoverTooltip(chartId?: string): void {
	if (chartId !== undefined) {
		_destroyState(chartId);
	} else {
		for (const id of [..._states.keys()]) {
			_destroyState(id);
		}
	}
}

// ── Lifecycle helpers ─────────────────────────────────────────────────────────

function _cancelHide(state: HoverState): void {
	if (state.hideTimer) {
		clearTimeout(state.hideTimer);
		state.hideTimer = 0;
	}
}

function _createTooltipElement(chartId: string): HTMLElement {
	const el = document.createElement('div');
	el.className = 'kusto-pinned-tooltip';
	el.addEventListener('mousedown', (e) => e.stopPropagation());
	el.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
	el.addEventListener('mouseenter', () => {
		const st = _states.get(chartId);
		if (!st) return;
		_cancelHide(st);
		// Keep the axis pointer visible while interacting with the tooltip
		try {
			st.inst?.dispatchAction?.({
				type: 'showTip',
				seriesIndex: 0,
				dataIndex: st.data.dataIndex,
			});
		} catch { /* noop */ }
	});
	el.addEventListener('mouseleave', () => scheduleHideTooltip(chartId));
	return el;
}

function _destroyState(chartId: string): void {
	const state = _states.get(chartId);
	if (!state) return;
	_cancelHide(state);
	try { state.inst?.dispatchAction?.({ type: 'downplay' }); } catch { /* noop */ }
	try { state.el.remove(); } catch { /* noop */ }
	_states.delete(chartId);
}

// ── Data extraction ───────────────────────────────────────────────────────────

function _buildData(params: any[], dataIndex: number, stackMode: string): TooltipData {
	const first = params[0];
	const title = String(first?.name ?? first?.axisValue ?? '');
	const rows: TooltipRow[] = [];
	let extraPayload: Record<string, string> | null = null;

	for (const p of params) {
		const rawData = p?.data;
		if (rawData === null || rawData === undefined) continue;

		const v = rawData && typeof rawData === 'object'
			? rawData.value : rawData;
		const origValue = rawData && typeof rawData === 'object'
			&& typeof rawData.__kustoOriginalValue === 'number'
			? rawData.__kustoOriginalValue : null;

		let formatted: string;
		if (stackMode === 'stacked100' && origValue !== null) {
			formatted = formatNumber(origValue) + ' (' +
				(typeof v === 'number' ? v.toFixed(1) : '0') + '%)';
		} else {
			formatted = typeof v === 'number' ? formatNumber(v) : String(v ?? '');
		}

		rows.push({
			color: String(p?.color || ''),
			seriesName: String(p?.seriesName || ''),
			value: typeof v === 'number' ? v : null,
			formattedValue: formatted,
			seriesIndex: typeof p?.seriesIndex === 'number' ? p.seriesIndex : 0,
		});

		if (!extraPayload && rawData && typeof rawData === 'object' && rawData.__kustoTooltip) {
			extraPayload = rawData.__kustoTooltip;
		}
	}

	return { title, dataIndex, rows, extraPayload };
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function _renderContent(state: HoverState): void {
	const esc = (v: any) => escapeHtml(String(v ?? ''));
	const { data, sortField, sortDir, searchTerm } = state;

	let rows = [...data.rows];

	// Filter
	if (searchTerm) {
		const lower = searchTerm.toLowerCase();
		rows = rows.filter(r =>
			r.seriesName.toLowerCase().includes(lower) ||
			r.formattedValue.toLowerCase().includes(lower)
		);
	}

	// Sort
	if (sortField === 'name' && sortDir) {
		rows.sort((a, b) => {
			const cmp = a.seriesName.localeCompare(b.seriesName);
			return sortDir === 'asc' ? cmp : -cmp;
		});
	} else if (sortField === 'value' && sortDir) {
		rows.sort((a, b) => {
			const diff = (a.value ?? -Infinity) - (b.value ?? -Infinity);
			return sortDir === 'asc' ? diff : -diff;
		});
	}

	// Column header sort indicators
	const nameInd = sortField === 'name'
		? (sortDir === 'asc' ? SORT_ASC : SORT_DESC)
		: SORT_NONE;
	const valueInd = sortField === 'value'
		? (sortDir === 'asc' ? SORT_ASC : SORT_DESC)
		: SORT_NONE;

	// Table rows
	const rowsHtml = rows.map(r =>
		`<tr class="kpt-row" data-series-index="${r.seriesIndex}">` +
			`<td class="kpt-marker"><span class="kpt-dot" style="background:${esc(r.color)}"></span></td>` +
			`<td class="kpt-name">${esc(r.seriesName)}</td>` +
			`<td class="kpt-value">${esc(r.formattedValue)}</td>` +
		`</tr>`
	).join('');

	// Extra tooltip columns
	let extraHtml = '';
	if (data.extraPayload) {
		const entries = Object.entries(data.extraPayload).filter(([, v]) => v);
		if (entries.length) {
			extraHtml = `<div class="kpt-extra">` +
				entries.map(([k, v]) =>
					`<div class="kpt-extra-row"><span class="kpt-extra-key">${esc(k)}:</span> ${esc(v)}</div>`
				).join('') + `</div>`;
		}
	}

	state.el.innerHTML =
		`<div class="kpt-header">` +
			`<span class="kpt-title">${esc(data.title)}</span>` +
			`<button class="kpt-btn kpt-close-btn" title="Close">${CLOSE_ICON}</button>` +
		`</div>` +
		`<div class="kpt-search-wrap">` +
			`<input class="kpt-search" type="text" placeholder="Search\u2026" value="${esc(searchTerm)}" />` +
		`</div>` +
		`<div class="kpt-table-wrap">` +
			`<table class="kpt-table">` +
				`<thead><tr>` +
					`<th class="kpt-th-marker"></th>` +
					`<th class="kpt-th-name" data-sort="name" title="Sort by name">Series ${nameInd}</th>` +
					`<th class="kpt-th-value" data-sort="value" title="Sort by value">Value ${valueInd}</th>` +
				`</tr></thead>` +
				`<tbody>${rowsHtml}</tbody>` +
			`</table>` +
		`</div>` +
		extraHtml;

	_wireEvents(state);
}

function _wireEvents(state: HoverState): void {
	const el = state.el;

	// Close
	el.querySelector('.kpt-close-btn')?.addEventListener('click', (e) => {
		e.stopPropagation();
		_destroyState(state.chartId);
	});

	// Search
	const searchInput = el.querySelector('.kpt-search') as HTMLInputElement | null;
	if (searchInput) {
		searchInput.addEventListener('input', () => {
			state.searchTerm = searchInput.value;
			_renderContent(state);
		});
		if (state.searchTerm) {
			requestAnimationFrame(() => {
				searchInput.focus();
				searchInput.setSelectionRange(state.searchTerm.length, state.searchTerm.length);
			});
		}
	}

	// Sortable column headers
	el.querySelectorAll('[data-sort]').forEach(th => {
		th.addEventListener('click', (e) => {
			e.stopPropagation();
			const field = (th as HTMLElement).dataset.sort as SortField;
			if (state.sortField === field) {
				state.sortDir = state.sortDir === '' ? 'desc'
					: state.sortDir === 'desc' ? 'asc' : '';
				if (!state.sortDir) state.sortField = '';
			} else {
				state.sortField = field;
				state.sortDir = 'desc';
			}
			_renderContent(state);
		});
	});

	// Row click → highlight series in chart
	el.querySelectorAll('.kpt-row').forEach(tr => {
		tr.addEventListener('click', (e) => {
			e.stopPropagation();
			const idx = parseInt((tr as HTMLElement).dataset.seriesIndex || '-1', 10);
			if (idx < 0) return;

			const isActive = tr.classList.contains('kpt-active');
			el.querySelectorAll('.kpt-row').forEach(r => r.classList.remove('kpt-active'));

			try {
				state.inst?.dispatchAction?.({ type: 'downplay' });
				if (!isActive) {
					tr.classList.add('kpt-active');
					state.inst?.dispatchAction?.({
						type: 'highlight',
						seriesIndex: idx,
					});
				}
			} catch (err) { console.error('[kusto]', err); }
		});
	});
}

// ── Positioning ───────────────────────────────────────────────────────────────

function _positionElement(
	state: HoverState,
	chartRelX: number,
	chartRelY: number,
): void {
	const wrapper = document.getElementById(state.chartId + '_chart_wrapper');
	if (!wrapper) return;

	// Convert chart-container-relative coords to wrapper-relative coords
	const chartDom = state.inst?.getDom?.();
	const wrapperRect = wrapper.getBoundingClientRect();
	const chartRect = chartDom?.getBoundingClientRect?.();

	const offsetX = chartRect ? (chartRect.left - wrapperRect.left) : 0;
	const offsetY = chartRect ? (chartRect.top - wrapperRect.top) : 0;

	const cursorX = offsetX + chartRelX;
	const cursorY = offsetY + chartRelY;

	const elW = state.el.offsetWidth || 280;
	const wW = wrapperRect.width;

	// Always 20px below cursor, allow overflow outside section
	const top = cursorY + 20;

	// Center horizontally on cursor, clamped within wrapper
	let left = cursorX - elW / 2;
	left = Math.max(4, Math.min(left, wW - elW - 4));

	state.el.style.left = Math.round(left) + 'px';
	state.el.style.top = Math.round(top) + 'px';
}
