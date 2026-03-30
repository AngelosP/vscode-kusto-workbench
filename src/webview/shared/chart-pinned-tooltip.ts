// Interactive hover tooltip for ECharts XY charts.
// Replaces the built-in axis tooltip with a rich, interactive panel.
// Shown on hover, stays while mouse is over the tooltip, supports sort,
// search, and click-to-highlight.
// Pure ES module — no window bridges.
// Delegates all rendering to the <kw-chart-tooltip> Lit component.

import { formatNumber } from './chart-utils.js';
import type { KwChartTooltip, ChartTooltipRow, ChartTooltipExtra } from '../components/kw-chart-tooltip.js';

// ── Types ─────────────────────────────────────────────────────────────────────

interface TooltipData {
	title: string;
	dataIndex: number;
	rows: ChartTooltipRow[];
	extraPayload: ChartTooltipExtra | null;
}

interface HoverState {
	chartId: string;
	el: KwChartTooltip;
	hideTimer: number;
	showTimer: number;
	data: TooltipData;
	inst: any;
	needsUpdate: boolean;
}

// ── State ─────────────────────────────────────────────────────────────────────

const _states = new Map<string, HoverState>();

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
			state.needsUpdate = true;
			// Content changed — restart the show delay
			_resetShowTimer(state);
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
			showTimer: 0,
			data,
			inst: null,
			needsUpdate: true,
		};
		_states.set(chartId, state);
		_resetShowTimer(state);
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
		_pushDataToElement(state);
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

function _resetShowTimer(state: HoverState): void {
	if (state.showTimer) { clearTimeout(state.showTimer); state.showTimer = 0; }
	state.el.style.opacity = '0';
	state.el.style.pointerEvents = 'none';
	const chartId = state.chartId;
	state.showTimer = window.setTimeout(() => {
		const st = _states.get(chartId);
		if (st) {
			st.showTimer = 0;
			st.el.style.opacity = '';
			st.el.style.pointerEvents = '';
		}
	}, 1000);
}

function _cancelHide(state: HoverState): void {
	if (state.hideTimer) {
		clearTimeout(state.hideTimer);
		state.hideTimer = 0;
	}
}

function _createTooltipElement(chartId: string): KwChartTooltip {
	const el = document.createElement('kw-chart-tooltip') as KwChartTooltip;
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
	el.addEventListener('tooltip-close', () => _destroyState(chartId));
	el.addEventListener('tooltip-highlight', ((e: CustomEvent) => {
		const st = _states.get(chartId);
		if (!st) return;
		const { seriesIndex, active } = e.detail;
		try {
			st.inst?.dispatchAction?.({ type: 'downplay' });
			if (active) {
				st.inst?.dispatchAction?.({ type: 'highlight', seriesIndex });
			}
		} catch (err) { console.error('[kusto]', err); }
	}) as EventListener);
	return el;
}

function _pushDataToElement(state: HoverState): void {
	const { el, data } = state;
	el.tooltipTitle = data.title;
	el.rows = data.rows;
	el.extraPayload = data.extraPayload;
	el.resetInteractionState();
}

function _destroyState(chartId: string): void {
	const state = _states.get(chartId);
	if (!state) return;
	_cancelHide(state);
	if (state.showTimer) { clearTimeout(state.showTimer); state.showTimer = 0; }
	try { state.inst?.dispatchAction?.({ type: 'downplay' }); } catch { /* noop */ }
	try { state.el.remove(); } catch { /* noop */ }
	_states.delete(chartId);
}

// ── Data extraction ───────────────────────────────────────────────────────────

function _buildData(params: any[], dataIndex: number, stackMode: string): TooltipData {
	const first = params[0];
	const title = String(first?.name ?? first?.axisValue ?? '');
	const rows: ChartTooltipRow[] = [];
	let extraPayload: ChartTooltipExtra | null = null;

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

	// Position just below the X axis (bottom of the ECharts grid + axis labels)
	let top = cursorY + 20; // fallback
	try {
		const gridModel = state.inst?.getModel?.()?.getComponent?.('grid', 0);
		const gridRect = gridModel?.coordinateSystem?.getRect?.();
		if (gridRect) {
			// gridRect.y + gridRect.height = bottom of the plot area (chart-relative)
			// Add ~30px for the X axis labels below the grid
			top = offsetY + gridRect.y + gridRect.height + 30;
		}
	} catch { /* use fallback */ }

	// Center horizontally on cursor, clamped within wrapper
	let left = cursorX - elW / 2;
	left = Math.max(4, Math.min(left, wW - elW - 4));

	state.el.style.left = Math.round(left) + 'px';
	state.el.style.top = Math.round(top) + 'px';
}
