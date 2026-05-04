import { beforeEach, describe, expect, it, vi } from 'vitest';

const resultsState = vi.hoisted(() => ({
	byId: {} as Record<string, any>,
	revisionById: {} as Record<string, number>,
}));

const tooltipMocks = vi.hoisted(() => ({
	dismissHoverTooltip: vi.fn(),
	handleTooltipFormatter: vi.fn(),
	handleTooltipPosition: vi.fn(),
	scheduleHideTooltip: vi.fn(),
}));

vi.mock('../../src/webview/core/results-state.js', () => ({
	getResultsState: (id: string) => resultsState.byId[id] ?? null,
	getResultsStateRevision: (id: string) => resultsState.revisionById[id] ?? 0,
}));

vi.mock('../../src/webview/core/persistence.js', () => ({
	schedulePersist: vi.fn(),
}));

vi.mock('../../src/webview/monaco/theme.js', () => ({
	isDarkTheme: () => false,
}));

vi.mock('../../src/webview/shared/chart-pinned-tooltip.js', () => tooltipMocks);

import { disposeChartEcharts, renderChart } from '../../src/webview/shared/chart-renderer.js';

describe('chart-renderer zoom/pan controls', () => {
	let setOption: ReturnType<typeof vi.fn>;
	let instance: Record<string, any>;
	let viewportRoot: HTMLElement | null;
	let gridRect: { x: number; y: number; width: number; height: number };

	beforeEach(() => {
		document.body.innerHTML = '';
		try { window.sessionStorage.removeItem('kustoWorkbench.chartZoomHintShown'); } catch { /* noop */ }
		delete (window as any).__kustoZoomPanHintShown;
		resultsState.byId = {};
		resultsState.revisionById = {};

		const state = (window as any).chartStateByBoxId || {};
		for (const key of Object.keys(state)) delete state[key];
		(window as any).chartStateByBoxId = state;

		const chartBoxes = (window as any).__kustoChartBoxes || [];
		chartBoxes.length = 0;
		(window as any).__kustoChartBoxes = chartBoxes;

		setOption = vi.fn();
		viewportRoot = null;
		gridRect = { x: 80, y: 40, width: 500, height: 260 };
		for (const mock of Object.values(tooltipMocks)) mock.mockClear();
		instance = {
			dispose: vi.fn(),
			dispatchAction: vi.fn(),
			getOption: vi.fn(() => ({ dataZoom: [] })),
			off: vi.fn(),
			on: vi.fn(),
			resize: vi.fn(),
			setOption,
		};
		instance.getModel = vi.fn(() => ({
			getComponent: vi.fn(() => ({
				coordinateSystem: {
					getRect: () => ({ ...gridRect }),
					getCartesians: () => [{ pointToData: ([x, y]: number[]) => [x, y] }],
				},
			})),
		}));
		(window as any).echarts = {
			init: vi.fn((dom: HTMLElement) => {
				viewportRoot = document.createElement('div');
				(viewportRoot as any).setPointerCapture = vi.fn();
				(viewportRoot as any).releasePointerCapture = vi.fn();
				(viewportRoot as any).hasPointerCapture = vi.fn(() => true);
				dom.appendChild(viewportRoot);
				instance.getDom = vi.fn(() => dom);
				instance.getZr = vi.fn(() => ({
					painter: { getViewportRoot: () => viewportRoot },
				}));
				return instance;
			}),
		};
	});

	function createCanvas(canvasId: string): HTMLDivElement {
		const canvas = document.createElement('div');
		canvas.id = canvasId;
		Object.defineProperty(canvas, 'clientWidth', { configurable: true, value: 640 });
		Object.defineProperty(canvas, 'clientHeight', { configurable: true, value: 360 });
		canvas.getBoundingClientRect = () => ({
			x: 0,
			y: 0,
			left: 0,
			top: 0,
			right: 640,
			bottom: 360,
			width: 640,
			height: 360,
			toJSON: () => ({}),
		} as DOMRect);
		return canvas;
	}

	function addZoomControls(id: string, editContainer: HTMLElement): void {
		const overlay = document.createElement('div');
		overlay.id = `${id}_chart_zoom_drag_overlay`;
		overlay.hidden = true;
		const rect = document.createElement('div');
		rect.className = 'kusto-chart-zoom-drag-rect';
		rect.hidden = true;
		overlay.appendChild(rect);
		editContainer.appendChild(overlay);

		const controls = document.createElement('div');
		controls.id = `${id}_chart_zoom_controls`;
		controls.hidden = true;
		const undoButton = document.createElement('button');
		undoButton.id = `${id}_chart_zoom_undo`;
		undoButton.hidden = true;
		const zoomButton = document.createElement('button');
		zoomButton.id = `${id}_chart_zoom_select`;
		controls.appendChild(undoButton);
		controls.appendChild(zoomButton);
		editContainer.appendChild(controls);
		const hint = document.createElement('div');
		hint.id = `${id}_chart_zoom_hint`;
		hint.hidden = true;
		hint.textContent = 'Drag a rectangle around the area you want to zoom';
		editContainer.appendChild(hint);
	}

	function renderScenario(chartType: string, stateOverrides: Record<string, unknown> = {}): { id: string; option: any; state: any } {
		const id = `chart_${chartType}_${Math.random().toString(36).slice(2)}`;
		const host = document.createElement('div');
		host.id = id;
		document.body.appendChild(host);

		const wrapper = document.createElement('div');
		wrapper.id = `${id}_chart_wrapper`;
		const editContainer = document.createElement('div');
		editContainer.id = `${id}_chart_edit`;
		editContainer.appendChild(createCanvas(`${id}_chart_canvas_edit`));
		addZoomControls(id, editContainer);
		wrapper.appendChild(editContainer);

		const previewContainer = document.createElement('div');
		previewContainer.id = `${id}_chart_preview`;
		previewContainer.appendChild(createCanvas(`${id}_chart_canvas_preview`));
		wrapper.appendChild(previewContainer);
		document.body.appendChild(wrapper);

		resultsState.byId.q1 = {
			columns: ['Timestamp', 'Value', 'Category', 'Target'],
			rows: [
				['2024-01-01T00:00:00Z', 10, 'A', 'B'],
				['2024-01-02T00:00:00Z', 20, 'B', 'C'],
			],
		};

		const state = {
			mode: 'edit',
			expanded: true,
			dataSourceId: 'q1',
			chartType,
			xColumn: 'Timestamp',
			yColumn: 'Value',
			yColumns: ['Value'],
			labelColumn: 'Category',
			valueColumn: 'Value',
			sourceColumn: 'Category',
			targetColumn: 'Target',
			legendPosition: 'top',
			stackMode: 'normal',
			...stateOverrides,
		};
		(window as any).chartStateByBoxId[id] = state;

		renderChart(id);
		const fullOptionCall = setOption.mock.calls.find((call) => call[1]?.notMerge === true);
		expect(fullOptionCall).toBeTruthy();
		return { id, option: fullOptionCall![0], state };
	}

	function getControls(id: string): { controls: HTMLElement; zoom: HTMLButtonElement; undo: HTMLButtonElement } {
		return {
			controls: document.getElementById(`${id}_chart_zoom_controls`) as HTMLElement,
			zoom: document.getElementById(`${id}_chart_zoom_select`) as HTMLButtonElement,
			undo: document.getElementById(`${id}_chart_zoom_undo`) as HTMLButtonElement,
		};
	}

	function getHint(id: string): HTMLElement {
		return document.getElementById(`${id}_chart_zoom_hint`) as HTMLElement;
	}

	function getDragOverlay(id: string): HTMLElement {
		return document.getElementById(`${id}_chart_zoom_drag_overlay`) as HTMLElement;
	}

	function createPointerEvent(type: string, pointerId: number, button = 0, point: { clientX: number; clientY: number } = { clientX: 0, clientY: 0 }): PointerEvent {
		const event = new Event(type, { bubbles: true, cancelable: true }) as PointerEvent;
		Object.defineProperty(event, 'pointerId', { value: pointerId });
		Object.defineProperty(event, 'button', { value: button });
		Object.defineProperty(event, 'isPrimary', { value: true });
		Object.defineProperty(event, 'clientX', { value: point.clientX });
		Object.defineProperty(event, 'clientY', { value: point.clientY });
		return event;
	}

	it.each(['scatter', 'line', 'area', 'bar'])('adds data zoom state without visible ECharts toolbox controls for %s charts', (chartType) => {
		const scenario = renderScenario(chartType);
		const controls = getControls(scenario.id);

		expect(scenario.option.toolbox).toMatchObject({
			show: true,
			showTitle: false,
			itemSize: 0,
			left: -10000,
			top: -10000,
			feature: {
				dataZoom: {
					xAxisIndex: 'all',
					yAxisIndex: 'all',
					iconStyle: { opacity: 0 },
				},
			},
		});
		expect(scenario.option.dataZoom).toEqual(expect.arrayContaining([
			expect.objectContaining({ type: 'inside', xAxisIndex: 0, filterMode: 'none', zoomOnMouseWheel: false }),
			expect.objectContaining({ type: 'inside', yAxisIndex: 0, filterMode: 'none', zoomOnMouseWheel: false }),
		]));
		expect(controls.controls.hidden).toBe(false);
		expect(controls.undo.hidden).toBe(true);
	});

	it.each(['pie', 'funnel', 'sankey', 'heatmap'])('does not add zoom controls to unsupported %s charts', (chartType) => {
		const scenario = renderScenario(chartType);
		const controls = getControls(scenario.id);

		expect(scenario.option.dataZoom).toBeUndefined();
		expect(scenario.option.toolbox).toBeUndefined();
		expect(controls.controls.hidden).toBe(true);
	});

	it('hides floating controls in preview mode while keeping dataZoom available', () => {
		const scenario = renderScenario('line', { mode: 'preview', legendColumn: 'Category' });
		const controls = getControls(scenario.id);

		expect(scenario.option.dataZoom).toBeTruthy();
		expect(controls.controls.hidden).toBe(true);
	});

	it('positions floating controls below chart title and subtitle', () => {
		const scenario = renderScenario('line', {
			legendColumn: 'Category',
			chartTitle: 'Request volume',
			chartSubtitle: 'Last 30 days',
		});
		const controls = getControls(scenario.id);

		expect(controls.controls.style.top).toBe('56px');
	});

	it('activates ECharts rectangle zoom selection from the floating Zoom button', () => {
		const scenario = renderScenario('line', { legendColumn: 'Category' });
		const controls = getControls(scenario.id);

		controls.zoom.click();

		expect(instance.dispatchAction).toHaveBeenCalledWith({
			type: 'takeGlobalCursor',
			key: 'dataZoomSelect',
			dataZoomSelectActive: true,
		});
		expect(scenario.state.__zoomPanSelectActive).toBe(true);
		expect(controls.zoom.classList.contains('is-active')).toBe(true);
		expect(getDragOverlay(scenario.id).hidden).toBe(false);
	});

	it('lets rectangle zoom start from chart background outside the ECharts grid', () => {
		const scenario = renderScenario('line', { legendColumn: 'Category' });
		const controls = getControls(scenario.id);
		const overlay = getDragOverlay(scenario.id);

		controls.zoom.click();
		instance.dispatchAction.mockClear();

		overlay.dispatchEvent(createPointerEvent('pointerdown', 43, 0, { clientX: 20, clientY: 20 }));
		overlay.dispatchEvent(createPointerEvent('pointermove', 43, 0, { clientX: 320, clientY: 220 }));
		overlay.dispatchEvent(createPointerEvent('pointerup', 43, 0, { clientX: 320, clientY: 220 }));

		expect(instance.dispatchAction).toHaveBeenCalledWith({
			type: 'dataZoom',
			batch: [
				{ dataZoomIndex: 0, startValue: 80, endValue: 320 },
				{ dataZoomIndex: 1, startValue: 40, endValue: 220 },
			],
		});
		expect(overlay.querySelector('.kusto-chart-zoom-drag-rect')?.hasAttribute('hidden')).toBe(true);
	});

	it('captures chart pointer release while rectangle zoom selection is active', () => {
		const scenario = renderScenario('line', { legendColumn: 'Category' });
		const controls = getControls(scenario.id);
		const root = viewportRoot!;

		root.dispatchEvent(createPointerEvent('pointerdown', 41));
		expect((root as any).setPointerCapture).not.toHaveBeenCalled();

		controls.zoom.click();
		root.dispatchEvent(createPointerEvent('pointerdown', 41));

		expect((root as any).setPointerCapture).toHaveBeenCalledWith(41);
		expect(scenario.state.__zoomPanCapturedPointerId).toBe(41);

		root.dispatchEvent(createPointerEvent('pointerup', 41));

		expect((root as any).releasePointerCapture).toHaveBeenCalledWith(41);
		expect(scenario.state.__zoomPanCapturedPointerId).toBeUndefined();
	});

	it('shows the rectangle zoom hint only once per session', () => {
		vi.useFakeTimers();
		try {
			const firstScenario = renderScenario('line', { legendColumn: 'Category' });
			const firstControls = getControls(firstScenario.id);
			const firstHint = getHint(firstScenario.id);

			firstControls.zoom.click();

			expect(firstHint.hidden).toBe(false);
			expect(firstHint.classList.contains('is-visible')).toBe(true);
			expect(firstHint.textContent).toBe('Drag a rectangle around the area you want to zoom');
			expect(window.sessionStorage.getItem('kustoWorkbench.chartZoomHintShown')).toBe('1');

			vi.advanceTimersByTime(2700);
			expect(firstHint.hidden).toBe(true);
			expect(firstHint.classList.contains('is-visible')).toBe(false);

			const secondScenario = renderScenario('bar', { legendColumn: 'Category' });
			const secondControls = getControls(secondScenario.id);
			const secondHint = getHint(secondScenario.id);

			secondControls.zoom.click();

			expect(secondHint.hidden).toBe(true);
			expect(secondHint.classList.contains('is-visible')).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});

	it('suppresses rich hover tooltips while rectangle zoom selection is active', () => {
		const scenario = renderScenario('line', { legendColumn: 'Category' });
		const controls = getControls(scenario.id);
		const dataZoomHandler = instance.on.mock.calls.find((call) => call[0] === 'datazoom')?.[1];
		expect(dataZoomHandler).toBeTypeOf('function');

		scenario.option.tooltip.formatter([{ dataIndex: 0, seriesName: 'Value', value: 10 }]);
		scenario.option.tooltip.position([32, 48]);
		expect(tooltipMocks.handleTooltipFormatter).toHaveBeenCalledTimes(1);
		expect(tooltipMocks.handleTooltipPosition).toHaveBeenCalledTimes(1);

		setOption.mockClear();
		for (const mock of Object.values(tooltipMocks)) mock.mockClear();
		controls.zoom.click();

		expect(setOption).toHaveBeenCalledWith(
			{ tooltip: { show: false } },
			expect.objectContaining({ notMerge: false, lazyUpdate: true, silent: true }),
		);
		expect(tooltipMocks.dismissHoverTooltip).toHaveBeenCalledWith(scenario.id);

		const formatted = scenario.option.tooltip.formatter([{ dataIndex: 1, seriesName: 'Value', value: 20 }]);
		const position = scenario.option.tooltip.position([64, 96]);
		expect(formatted).toBe('');
		expect(position).toEqual([-9999, -9999]);
		expect(tooltipMocks.handleTooltipFormatter).not.toHaveBeenCalled();
		expect(tooltipMocks.handleTooltipPosition).not.toHaveBeenCalled();

		setOption.mockClear();
		instance.getOption.mockReturnValue({ dataZoom: [{ start: 20, end: 80 }] });
		dataZoomHandler();

		expect(setOption).toHaveBeenCalledWith(
			{ tooltip: { show: true } },
			expect.objectContaining({ notMerge: false, lazyUpdate: true, silent: true }),
		);
		expect(scenario.state.__zoomPanTooltipSuppressed).toBeUndefined();
	});

	it('deactivates rectangle zoom selection when controls disappear before a gesture completes', () => {
		const scenario = renderScenario('line', { legendColumn: 'Category' });
		const controls = getControls(scenario.id);

		controls.zoom.click();
		expect(scenario.state.__zoomPanSelectActive).toBe(true);

		instance.dispatchAction.mockClear();
		setOption.mockClear();
		scenario.state.chartType = 'pie';
		renderChart(scenario.id);

		expect(instance.dispatchAction).toHaveBeenCalledWith({
			type: 'takeGlobalCursor',
			key: 'dataZoomSelect',
			dataZoomSelectActive: false,
		});
		expect(scenario.state.__zoomPanSelectActive).toBeUndefined();
		expect(getControls(scenario.id).controls.hidden).toBe(true);
	});

	it('shows undo after a zoom gesture and hides it again at the original extent', () => {
		const scenario = renderScenario('line', { legendColumn: 'Category' });
		const controls = getControls(scenario.id);
		const dataZoomHandler = instance.on.mock.calls.find((call) => call[0] === 'datazoom')?.[1];
		expect(dataZoomHandler).toBeTypeOf('function');

		controls.zoom.click();
		instance.getOption.mockReturnValue({ dataZoom: [{ start: 20, end: 80 }] });
		dataZoomHandler();
		expect(scenario.state.__zoomPanUndoStack).toEqual([null]);
		expect(controls.undo.hidden).toBe(false);

		controls.zoom.click();
		instance.getOption.mockReturnValue({ dataZoom: [{ start: 30, end: 60 }] });
		dataZoomHandler();
		expect(scenario.state.__zoomPanUndoStack).toHaveLength(2);

		instance.dispatchAction.mockClear();
		controls.undo.click();
		expect(instance.dispatchAction).toHaveBeenCalledWith({
			type: 'dataZoom',
			batch: [expect.objectContaining({ dataZoomIndex: 0, start: 20, end: 80 })],
		});
		expect(scenario.state.__zoomPanUndoStack).toHaveLength(1);
		expect(controls.undo.hidden).toBe(false);

		instance.dispatchAction.mockClear();
		controls.undo.click();
		expect(instance.dispatchAction).toHaveBeenCalledWith({
			type: 'dataZoom',
			batch: [
				expect.objectContaining({ dataZoomIndex: 0, start: 0, end: 100 }),
				expect.objectContaining({ dataZoomIndex: 1, start: 0, end: 100 }),
			],
		});
		expect(scenario.state.__zoomPanViewport).toBeUndefined();
		expect(scenario.state.__zoomPanUndoStack).toHaveLength(0);
		expect(controls.undo.hidden).toBe(true);
	});

	it('reapplies captured zoom state when switching from edit to preview canvas', () => {
		const scenario = renderScenario('line', { legendColumn: 'Category' });
		const dataZoomHandler = instance.on.mock.calls.find((call) => call[0] === 'datazoom')?.[1];
		expect(dataZoomHandler).toBeTypeOf('function');

		instance.getOption.mockReturnValue({
			dataZoom: [
				{ start: 20, end: 80 },
				{ start: 10, end: 90 },
			],
		});
		dataZoomHandler();
		expect(scenario.state.__zoomPanViewport).toEqual([
			expect.objectContaining({ dataZoomIndex: 0, start: 20, end: 80 }),
			expect.objectContaining({ dataZoomIndex: 1, start: 10, end: 90 }),
		]);

		instance.dispatchAction.mockClear();
		setOption.mockClear();
		const previewInstance = {
			dispose: vi.fn(),
			dispatchAction: vi.fn(),
			getOption: vi.fn(() => ({ dataZoom: [] })),
			off: vi.fn(),
			on: vi.fn(),
			resize: vi.fn(),
			setOption: vi.fn(),
		};
		(window as any).echarts.init.mockReturnValueOnce(previewInstance);
		scenario.state.mode = 'preview';
		renderChart(scenario.id);

		expect(instance.dispose).toHaveBeenCalled();
		expect(previewInstance.dispatchAction).toHaveBeenCalledWith({
			type: 'dataZoom',
			batch: [
				expect.objectContaining({ dataZoomIndex: 0, start: 20, end: 80 }),
				expect.objectContaining({ dataZoomIndex: 1, start: 10, end: 90 }),
			],
		});
		expect(getControls(scenario.id).controls.hidden).toBe(true);
	});

	it('captures zoom state before direct disposal', () => {
		const scenario = renderScenario('line', { legendColumn: 'Category' });
		instance.getOption.mockReturnValue({ dataZoom: [{ start: 30, end: 70 }] });

		disposeChartEcharts(scenario.id);

		expect(instance.dispose).toHaveBeenCalled();
		expect(scenario.state.__zoomPanViewport).toEqual([
			expect.objectContaining({ dataZoomIndex: 0, start: 30, end: 70 }),
		]);
		expect(scenario.state.__zoomPanViewportSignature).toBeTypeOf('string');
	});

	it('does not reapply captured zoom state after the data source changes', () => {
		const scenario = renderScenario('line', { legendColumn: 'Category' });
		const dataZoomHandler = instance.on.mock.calls.find((call) => call[0] === 'datazoom')?.[1];
		expect(dataZoomHandler).toBeTypeOf('function');

		instance.getOption.mockReturnValue({ dataZoom: [{ start: 20, end: 80 }] });
		dataZoomHandler();
		expect(scenario.state.__zoomPanViewport).toBeTruthy();

		resultsState.byId.q2 = {
			columns: ['Timestamp', 'Value', 'Category', 'Target'],
			rows: [
				['2024-02-01T00:00:00Z', 100, 'A', 'B'],
				['2024-02-02T00:00:00Z', 200, 'B', 'C'],
			],
		};
		scenario.state.dataSourceId = 'q2';
		instance.dispatchAction.mockClear();
		setOption.mockClear();

		renderChart(scenario.id);

		expect(scenario.state.__zoomPanViewport).toBeUndefined();
		expect(scenario.state.__zoomPanUndoStack).toBeUndefined();
		expect(instance.dispatchAction.mock.calls.some((call) => call[0]?.type === 'dataZoom')).toBe(false);
	});

	it('clears captured zoom state while showing an invalid placeholder', () => {
		const scenario = renderScenario('line', { legendColumn: 'Category' });
		const dataZoomHandler = instance.on.mock.calls.find((call) => call[0] === 'datazoom')?.[1];
		expect(dataZoomHandler).toBeTypeOf('function');

		instance.getOption.mockReturnValue({ dataZoom: [{ start: 20, end: 80 }] });
		dataZoomHandler();
		expect(scenario.state.__zoomPanViewport).toBeTruthy();

		scenario.state.dataSourceId = '';
		renderChart(scenario.id);
		expect(scenario.state.__zoomPanViewport).toBeUndefined();
		expect(scenario.state.__zoomPanViewportSignature).toBeUndefined();

		scenario.state.dataSourceId = 'q1';
		instance.dispatchAction.mockClear();
		setOption.mockClear();
		renderChart(scenario.id);

		expect(instance.dispatchAction.mock.calls.some((call) => call[0]?.type === 'dataZoom')).toBe(false);
	});

	it('does not stamp old zoom state with a new signature during a data-source mode flip', () => {
		const scenario = renderScenario('line', { legendColumn: 'Category' });
		const dataZoomHandler = instance.on.mock.calls.find((call) => call[0] === 'datazoom')?.[1];
		expect(dataZoomHandler).toBeTypeOf('function');

		instance.getOption.mockReturnValue({ dataZoom: [{ start: 20, end: 80 }] });
		dataZoomHandler();
		expect(scenario.state.__zoomPanViewport).toBeTruthy();

		resultsState.byId.q2 = {
			columns: ['Timestamp', 'Value', 'Category', 'Target'],
			rows: [
				['2024-02-01T00:00:00Z', 100, 'A', 'B'],
				['2024-02-02T00:00:00Z', 200, 'B', 'C'],
			],
		};
		scenario.state.dataSourceId = 'q2';
		scenario.state.mode = 'preview';
		instance.dispatchAction.mockClear();
		setOption.mockClear();

		renderChart(scenario.id);

		expect(instance.dispose).toHaveBeenCalled();
		expect(scenario.state.__zoomPanViewport).toBeUndefined();
		expect(instance.dispatchAction.mock.calls.some((call) => call[0]?.type === 'dataZoom')).toBe(false);
	});

	it('does not reapply captured zoom state after source results are replaced', () => {
		const scenario = renderScenario('line', { legendColumn: 'Category' });
		const dataZoomHandler = instance.on.mock.calls.find((call) => call[0] === 'datazoom')?.[1];
		expect(dataZoomHandler).toBeTypeOf('function');

		instance.getOption.mockReturnValue({ dataZoom: [{ start: 20, end: 80 }] });
		dataZoomHandler();
		expect(scenario.state.__zoomPanViewport).toBeTruthy();

		resultsState.revisionById.q1 = 1;
		instance.dispatchAction.mockClear();
		setOption.mockClear();

		renderChart(scenario.id);

		expect(scenario.state.__zoomPanViewport).toBeUndefined();
		expect(instance.dispatchAction.mock.calls.some((call) => call[0]?.type === 'dataZoom')).toBe(false);
	});

	it('does not reapply captured zoom state after stack mode changes', () => {
		const scenario = renderScenario('bar', {
			legendColumn: 'Category',
			stackMode: 'normal',
		});
		const dataZoomHandler = instance.on.mock.calls.find((call) => call[0] === 'datazoom')?.[1];
		expect(dataZoomHandler).toBeTypeOf('function');

		instance.getOption.mockReturnValue({ dataZoom: [{ start: 20, end: 80 }] });
		dataZoomHandler();
		expect(scenario.state.__zoomPanViewport).toBeTruthy();

		scenario.state.stackMode = 'stacked100';
		instance.dispatchAction.mockClear();
		setOption.mockClear();

		renderChart(scenario.id);

		expect(scenario.state.__zoomPanViewport).toBeUndefined();
		expect(instance.dispatchAction.mock.calls.some((call) => call[0]?.type === 'dataZoom')).toBe(false);
	});
});
