import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
	handleTooltipFormatter,
	handleTooltipPosition,
	scheduleHideTooltip,
	dismissHoverTooltip,
} from '../../src/webview/shared/chart-pinned-tooltip.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Minimal stub that satisfies the KwChartTooltip interface used by the module. */
function createMockTooltipElement(): HTMLElement & {
	tooltipTitle: string;
	rows: any[];
	extraPayload: any;
	resetInteractionState: ReturnType<typeof vi.fn>;
} {
	const el = document.createElement('div') as any;
	el.tooltipTitle = '';
	el.rows = [];
	el.extraPayload = null;
	el.resetInteractionState = vi.fn();
	return el;
}

// Intercept createElement('kw-chart-tooltip') so the module gets our stub.
let nextTooltipEl: ReturnType<typeof createMockTooltipElement> | null = null;
const origCreateElement = document.createElement.bind(document);

function patchCreateElement(): void {
	document.createElement = ((tag: string, opts?: any) => {
		if (tag === 'kw-chart-tooltip') {
			return nextTooltipEl ?? createMockTooltipElement();
		}
		return origCreateElement(tag, opts);
	}) as typeof document.createElement;
}

function restoreCreateElement(): void {
	document.createElement = origCreateElement;
}

/** Build a minimal ECharts-like param array for the formatter. */
function makeParams(dataIndex: number, values: Array<{ seriesName: string; value: number; color?: string }>) {
	return values.map((v, i) => ({
		dataIndex,
		name: `Label-${dataIndex}`,
		seriesName: v.seriesName,
		seriesIndex: i,
		color: v.color ?? '#ff0000',
		data: v.value,
	}));
}

/** Minimal mock ECharts instance. */
function makeInst(gridRect?: { x: number; y: number; width: number; height: number }) {
	const dom = document.createElement('div');
	dom.getBoundingClientRect = () => ({ top: 0, left: 0, width: 600, height: 400, bottom: 400, right: 600, x: 0, y: 0, toJSON() {} });
	return {
		getDom: () => dom,
		dispatchAction: vi.fn(),
		getModel: () => ({
			getComponent: (_name: string, _idx: number) =>
				gridRect
					? { coordinateSystem: { getRect: () => gridRect } }
					: undefined,
		}),
	};
}

// ── Setup / Teardown ──────────────────────────────────────────────────────────

let wrapper: HTMLDivElement;
const CHART_ID = 'test-chart';

beforeEach(() => {
	vi.useFakeTimers();
	patchCreateElement();

	// The module looks up `<id>_chart_wrapper` by getElementById.
	wrapper = origCreateElement('div');
	wrapper.id = CHART_ID + '_chart_wrapper';
	document.body.appendChild(wrapper);
});

afterEach(() => {
	dismissHoverTooltip();
	wrapper.remove();
	restoreCreateElement();
	vi.useRealTimers();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('chart-pinned-tooltip', () => {

	// ── Show timer ────────────────────────────────────────────────────────────

	describe('show timer (500 ms)', () => {
		it('tooltip is hidden immediately after first formatter call', () => {
			const el = createMockTooltipElement();
			nextTooltipEl = el;

			handleTooltipFormatter(CHART_ID, makeParams(0, [{ seriesName: 'A', value: 10 }]), '');

			expect(el.style.opacity).toBe('0');
			expect(el.style.pointerEvents).toBe('none');
		});

		it('tooltip becomes visible after 500 ms', () => {
			const el = createMockTooltipElement();
			nextTooltipEl = el;

			handleTooltipFormatter(CHART_ID, makeParams(0, [{ seriesName: 'A', value: 10 }]), '');

			vi.advanceTimersByTime(500);

			expect(el.style.opacity).toBe('');
			expect(el.style.pointerEvents).toBe('');
		});

		it('tooltip is NOT visible at 499 ms', () => {
			const el = createMockTooltipElement();
			nextTooltipEl = el;

			handleTooltipFormatter(CHART_ID, makeParams(0, [{ seriesName: 'A', value: 10 }]), '');

			vi.advanceTimersByTime(499);

			expect(el.style.opacity).toBe('0');
		});
	});

	// ── Show timer reset on dataIndex change ─────────────────────────────────

	describe('show timer resets on dataIndex change', () => {
		it('resets the 500 ms delay when dataIndex changes while still pending', () => {
			const el = createMockTooltipElement();
			nextTooltipEl = el;

			handleTooltipFormatter(CHART_ID, makeParams(0, [{ seriesName: 'A', value: 10 }]), '');
			vi.advanceTimersByTime(300);
			expect(el.style.opacity).toBe('0');

			// Move to a different dataIndex — should restart the timer
			handleTooltipFormatter(CHART_ID, makeParams(1, [{ seriesName: 'A', value: 20 }]), '');
			vi.advanceTimersByTime(300);
			// Only 300 ms since reset — still hidden
			expect(el.style.opacity).toBe('0');

			vi.advanceTimersByTime(200);
			// 500 ms since reset — visible
			expect(el.style.opacity).toBe('');
		});
	});

	// ── Instant update when already visible ──────────────────────────────────

	describe('instant update when already visible', () => {
		it('does not re-hide the tooltip when moving to a new dataIndex while visible', () => {
			const el = createMockTooltipElement();
			nextTooltipEl = el;

			handleTooltipFormatter(CHART_ID, makeParams(0, [{ seriesName: 'A', value: 10 }]), '');
			vi.advanceTimersByTime(500); // now visible
			expect(el.style.opacity).toBe('');

			// Move to new dataIndex — should stay visible (no delay)
			handleTooltipFormatter(CHART_ID, makeParams(1, [{ seriesName: 'A', value: 20 }]), '');
			expect(el.style.opacity).toBe('');
		});
	});

	// ── Hide timer ────────────────────────────────────────────────────────────

	describe('hide timer (500 ms)', () => {
		it('scheduleHideTooltip destroys the state after 500 ms', () => {
			const el = createMockTooltipElement();
			nextTooltipEl = el;

			handleTooltipFormatter(CHART_ID, makeParams(0, [{ seriesName: 'A', value: 10 }]), '');
			vi.advanceTimersByTime(500); // visible

			scheduleHideTooltip(CHART_ID);
			// Not destroyed yet
			expect(el.parentElement).toBe(wrapper);

			vi.advanceTimersByTime(500);
			// Now destroyed
			expect(el.parentElement).toBeNull();
		});

		it('scheduleHideTooltip cancels a pending show timer', () => {
			const el = createMockTooltipElement();
			nextTooltipEl = el;

			handleTooltipFormatter(CHART_ID, makeParams(0, [{ seriesName: 'A', value: 10 }]), '');
			// Show timer is pending (500 ms). Schedule hide immediately.
			scheduleHideTooltip(CHART_ID);

			vi.advanceTimersByTime(500);
			// The tooltip should NOT have appeared — show timer was cancelled.
			// And it should be destroyed by the hide timer.
			expect(el.parentElement).toBeNull();
			expect(el.style.opacity).toBe('0');
		});
	});

	// ── dismissHoverTooltip ──────────────────────────────────────────────────

	describe('dismissHoverTooltip', () => {
		it('immediately destroys the tooltip', () => {
			const el = createMockTooltipElement();
			nextTooltipEl = el;

			handleTooltipFormatter(CHART_ID, makeParams(0, [{ seriesName: 'A', value: 10 }]), '');

			dismissHoverTooltip(CHART_ID);
			expect(el.parentElement).toBeNull();
		});

		it('dismisses all tooltips when called without argument', () => {
			const el1 = createMockTooltipElement();
			nextTooltipEl = el1;

			const wrapper2 = origCreateElement('div');
			wrapper2.id = 'chart2_chart_wrapper';
			document.body.appendChild(wrapper2);

			handleTooltipFormatter(CHART_ID, makeParams(0, [{ seriesName: 'A', value: 10 }]), '');

			const el2 = createMockTooltipElement();
			nextTooltipEl = el2;
			handleTooltipFormatter('chart2', makeParams(0, [{ seriesName: 'B', value: 20 }]), '');

			dismissHoverTooltip();

			expect(el1.parentElement).toBeNull();
			expect(el2.parentElement).toBeNull();
			wrapper2.remove();
		});
	});

	// ── Grid boundary via mousemove listener ─────────────────────────────────

	describe('grid boundary tracking via mousemove', () => {
		const gridRect = { x: 50, y: 40, width: 500, height: 300 };

		it('hides show timer when cursor moves above grid before 500 ms', () => {
			const el = createMockTooltipElement();
			nextTooltipEl = el;

			handleTooltipFormatter(CHART_ID, makeParams(0, [{ seriesName: 'A', value: 10 }]), '');
			const inst = makeInst(gridRect);
			// First position call attaches the mousemove listener
			handleTooltipPosition(CHART_ID, 100, 100, inst);

			// Simulate cursor moving above the grid (y < gridRect.y)
			const chartDom = inst.getDom();
			chartDom.dispatchEvent(new MouseEvent('mousemove', { clientY: 10, bubbles: true }));

			// Show timer should have been cancelled
			vi.advanceTimersByTime(500);
			expect(el.style.opacity).toBe('0');
		});

		it('uses delayed hide when cursor leaves grid while tooltip is visible', () => {
			const el = createMockTooltipElement();
			nextTooltipEl = el;

			handleTooltipFormatter(CHART_ID, makeParams(0, [{ seriesName: 'A', value: 10 }]), '');
			const inst = makeInst(gridRect);
			handleTooltipPosition(CHART_ID, 100, 100, inst);

			vi.advanceTimersByTime(500); // tooltip now visible
			expect(el.style.opacity).toBe('');

			// Cursor moves above grid
			const chartDom = inst.getDom();
			chartDom.dispatchEvent(new MouseEvent('mousemove', { clientY: 10, bubbles: true }));

			// Tooltip should still be visible (delayed hide = 500 ms)
			expect(el.parentElement).toBe(wrapper);

			vi.advanceTimersByTime(500);
			// Now destroyed
			expect(el.parentElement).toBeNull();
		});

		it('restarts show timer when cursor re-enters grid', () => {
			const el = createMockTooltipElement();
			nextTooltipEl = el;

			handleTooltipFormatter(CHART_ID, makeParams(0, [{ seriesName: 'A', value: 10 }]), '');
			const inst = makeInst(gridRect);
			handleTooltipPosition(CHART_ID, 100, 100, inst);
			const chartDom = inst.getDom();

			// Move outside
			chartDom.dispatchEvent(new MouseEvent('mousemove', { clientY: 10, bubbles: true }));

			// Move back inside
			chartDom.dispatchEvent(new MouseEvent('mousemove', { clientY: 200, bubbles: true }));

			// Timer restarted — not visible yet
			expect(el.style.opacity).toBe('0');

			vi.advanceTimersByTime(500);
			expect(el.style.opacity).toBe('');
		});
	});

	// ── No-op cases ──────────────────────────────────────────────────────────

	describe('no-op / guard cases', () => {
		it('ignores empty params', () => {
			handleTooltipFormatter(CHART_ID, [], '');
			expect(wrapper.children.length).toBe(0);
		});

		it('ignores null params', () => {
			handleTooltipFormatter(CHART_ID, null as any, '');
			expect(wrapper.children.length).toBe(0);
		});

		it('ignores params with negative dataIndex', () => {
			handleTooltipFormatter(CHART_ID, [{ dataIndex: -1 }], '');
			expect(wrapper.children.length).toBe(0);
		});

		it('handleTooltipPosition is a no-op with no prior formatter call', () => {
			// Should not throw
			handleTooltipPosition(CHART_ID, 100, 100, makeInst());
		});
	});
});
