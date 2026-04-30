import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VirtualScrollHost } from '../../src/webview/components/table-virtual-scroll.controller.js';

const virtualMocks = vi.hoisted(() => {
	const instances: MockVirtualizer[] = [];
	const elementScroll = vi.fn();
	const observeElementRect = vi.fn();
	const observeElementOffset = vi.fn();

	function buildItems(count: number, size: number) {
		const visibleCount = Math.min(Math.max(count, 0), 3);
		return Array.from({ length: visibleCount }, (_, index) => ({
			index,
			start: index * size,
			size,
		}));
	}

	class MockVirtualizer {
		options: any;
		items: Array<{ index: number; start: number; size: number }>;
		totalSize: number;
		cleanup = vi.fn();
		setOptions = vi.fn((options: any) => {
			this.options = options;
			const estimate = Number(options.estimateSize?.() ?? 0);
			const count = Number(options.count ?? 0);
			this.items = buildItems(count, estimate);
			this.totalSize = count * estimate;
		});
		measure = vi.fn();
		scrollToIndex = vi.fn();
		getVirtualItems = vi.fn(() => this.items);
		getTotalSize = vi.fn(() => this.totalSize);
		_didMount = vi.fn(() => this.cleanup);
		_willUpdate = vi.fn();

		constructor(options: any) {
			this.options = options;
			const estimate = Number(options.estimateSize?.() ?? 0);
			const count = Number(options.count ?? 0);
			this.items = buildItems(count, estimate);
			this.totalSize = count * estimate;
			instances.push(this);
		}
	}

	return { MockVirtualizer, elementScroll, observeElementRect, observeElementOffset, instances };
});

vi.mock('@tanstack/virtual-core', () => ({
	Virtualizer: virtualMocks.MockVirtualizer,
	elementScroll: virtualMocks.elementScroll,
	observeElementRect: virtualMocks.observeElementRect,
	observeElementOffset: virtualMocks.observeElementOffset,
}));

import { TableVirtualScrollController } from '../../src/webview/components/table-virtual-scroll.controller.js';

class MockResizeObserver {
	static instances: MockResizeObserver[] = [];
	observe = vi.fn();
	disconnect = vi.fn();

	constructor(private readonly callback: ResizeObserverCallback) {
		MockResizeObserver.instances.push(this);
	}

	trigger(height: number): void {
		this.callback([{ contentRect: { height } } as ResizeObserverEntry], this as unknown as ResizeObserver);
	}
}

interface Harness {
	ctrl: TableVirtualScrollController;
	host: VirtualScrollHost & { requestUpdate: ReturnType<typeof vi.fn>; _rowCount: number; _rowHeight: number };
	vscroll: HTMLDivElement;
	headWrap: HTMLDivElement;
}

let originalResizeObserver: typeof ResizeObserver | undefined;
let rafCallbacks: Map<number, FrameRequestCallback>;
let rafId: number;
let cancelAnimationFrameSpy: ReturnType<typeof vi.spyOn>;
let addEventListenerSpy: ReturnType<typeof vi.spyOn>;
let removeEventListenerSpy: ReturnType<typeof vi.spyOn>;
let createdControllers: TableVirtualScrollController[];

function setClientSize(el: HTMLElement, width: number, height: number): void {
	Object.defineProperty(el, 'clientWidth', { configurable: true, value: width });
	Object.defineProperty(el, 'clientHeight', { configurable: true, value: height });
}

function flushRaf(): void {
	const entries = Array.from(rafCallbacks.entries());
	rafCallbacks.clear();
	for (const [id, cb] of entries) {
		cb(id);
	}
}

function createHarness(options: { rowCount?: number; rowHeight?: number; width?: number; height?: number } = {}): Harness {
	const host = document.createElement('div') as VirtualScrollHost & {
		requestUpdate: ReturnType<typeof vi.fn>;
		_rowCount: number;
		_rowHeight: number;
	};
	host._rowCount = options.rowCount ?? 20;
	host._rowHeight = options.rowHeight ?? 25;
	host.addController = vi.fn();
	host.removeController = vi.fn();
	host.requestUpdate = vi.fn();
	host.updateComplete = Promise.resolve(true);
	host.getTableRowCount = () => host._rowCount;
	host.getEstimatedRowHeight = () => host._rowHeight;

	const shadow = host.attachShadow({ mode: 'open' });
	const vscroll = document.createElement('div');
	vscroll.className = 'vscroll';
	setClientSize(vscroll, options.width ?? 300, options.height ?? 180);
	const headWrap = document.createElement('div');
	headWrap.className = 'dtable-head-wrap';
	shadow.append(vscroll, headWrap);

	const ctrl = new TableVirtualScrollController(host);
	createdControllers.push(ctrl);
	return { ctrl, host, vscroll, headWrap };
}

function init(ctrl: TableVirtualScrollController): InstanceType<typeof virtualMocks.MockVirtualizer> {
	ctrl.initVirtualizer();
	flushRaf();
	expect(virtualMocks.instances).toHaveLength(1);
	return virtualMocks.instances[0];
}

beforeEach(() => {
	virtualMocks.instances.length = 0;
	virtualMocks.elementScroll.mockClear();
	virtualMocks.observeElementRect.mockClear();
	virtualMocks.observeElementOffset.mockClear();
	MockResizeObserver.instances = [];
	createdControllers = [];
	originalResizeObserver = globalThis.ResizeObserver;
	(globalThis as any).ResizeObserver = MockResizeObserver;
	rafCallbacks = new Map();
	rafId = 0;
	vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
		const id = ++rafId;
		rafCallbacks.set(id, cb);
		return id;
	});
	cancelAnimationFrameSpy = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id: number) => {
		rafCallbacks.delete(id);
	});
	addEventListenerSpy = vi.spyOn(window, 'addEventListener');
	removeEventListenerSpy = vi.spyOn(window, 'removeEventListener');
});

afterEach(() => {
	for (const ctrl of createdControllers) {
		ctrl.hostDisconnected();
	}
	if (originalResizeObserver) {
		globalThis.ResizeObserver = originalResizeObserver;
	} else {
		delete (globalThis as any).ResizeObserver;
	}
	vi.restoreAllMocks();
	document.body.replaceChildren();
});

describe('TableVirtualScrollController', () => {
	it('registers itself with the host', () => {
		const { ctrl, host } = createHarness();

		expect(host.addController).toHaveBeenCalledWith(ctrl);
	});

	it('creates a virtualizer when the scroll element already has height', () => {
		const { ctrl, host, vscroll } = createHarness({ rowCount: 8, rowHeight: 30, width: 320, height: 160 });
		const instance = init(ctrl);

		expect(instance.options.count).toBe(8);
		expect(instance.options.estimateSize()).toBe(30);
		expect(instance.options.getScrollElement()).toBe(vscroll);
		expect(instance.options.scrollToFn).toBe(virtualMocks.elementScroll);
		expect(instance.options.observeElementRect).toBe(virtualMocks.observeElementRect);
		expect(instance.options.observeElementOffset).toBe(virtualMocks.observeElementOffset);
		expect(instance._didMount).toHaveBeenCalledTimes(1);
		expect(instance._willUpdate).toHaveBeenCalledTimes(1);
		expect(ctrl.vItems).toEqual([
			{ index: 0, start: 0, size: 30 },
			{ index: 1, start: 30, size: 30 },
			{ index: 2, start: 60, size: 30 },
		]);
		expect(ctrl.vTotalSize).toBe(240);
		expect(ctrl.viewportW).toBe(320);
		expect(host.requestUpdate).toHaveBeenCalledTimes(1);
	});

	it('waits for a positive resize when the scroll element starts at zero height', () => {
		const { ctrl, vscroll } = createHarness({ height: 0 });

		ctrl.initVirtualizer();
		flushRaf();

		expect(virtualMocks.instances).toHaveLength(0);
		expect(MockResizeObserver.instances).toHaveLength(1);
		expect(MockResizeObserver.instances[0].observe).toHaveBeenCalledWith(vscroll);

		setClientSize(vscroll, 280, 120);
		MockResizeObserver.instances[0].trigger(120);

		expect(MockResizeObserver.instances[0].disconnect).toHaveBeenCalledTimes(1);
		expect(virtualMocks.instances).toHaveLength(1);
	});

	it('cleans up an existing virtualizer before creating a replacement', () => {
		const { ctrl } = createHarness();
		const first = init(ctrl);

		ctrl.initVirtualizer();
		flushRaf();

		expect(virtualMocks.instances).toHaveLength(2);
		expect(first.cleanup).toHaveBeenCalledTimes(1);
	});

	it('disconnects a pending zero-height observer before installing a replacement', () => {
		const { ctrl, vscroll } = createHarness({ height: 0 });

		ctrl.initVirtualizer();
		flushRaf();
		const firstObserver = MockResizeObserver.instances[0];
		expect(firstObserver.observe).toHaveBeenCalledWith(vscroll);

		ctrl.initVirtualizer();
		flushRaf();
		const secondObserver = MockResizeObserver.instances[1];

		expect(firstObserver.disconnect).toHaveBeenCalledTimes(1);
		expect(secondObserver.observe).toHaveBeenCalledWith(vscroll);
		expect(virtualMocks.instances).toHaveLength(0);
	});

	it('uses the scroll element override instead of the shadow DOM fallback', () => {
		const { ctrl } = createHarness({ height: 0 });
		const override = document.createElement('div');
		setClientSize(override, 410, 150);

		ctrl.setScrollElement(override);
		const instance = init(ctrl);

		expect(instance.options.getScrollElement()).toBe(override);
		expect(ctrl.viewportW).toBe(410);
	});

	it('updates count, resets scroll position, measures, and syncs header scroll', () => {
		const { ctrl, host, vscroll, headWrap } = createHarness({ rowCount: 10, rowHeight: 20 });
		const instance = init(ctrl);
		instance.setOptions.mockClear();
		instance.measure.mockClear();
		host.requestUpdate.mockClear();
		vscroll.scrollTop = 80;
		vscroll.scrollLeft = 33;
		host._rowCount = 12;
		host._rowHeight = 31;

		ctrl.updateCount();

		expect(instance.setOptions).toHaveBeenCalledTimes(1);
		expect(instance.options.count).toBe(12);
		expect(instance.options.estimateSize()).toBe(31);
		expect(vscroll.scrollTop).toBe(0);
		expect(instance.measure).toHaveBeenCalledTimes(1);
		expect(ctrl.vTotalSize).toBe(372);
		expect(headWrap.scrollLeft).toBe(33);
		expect(host.requestUpdate).toHaveBeenCalledTimes(1);
	});

	it('delegates scrollToIndex and measure to the virtualizer', () => {
		const { ctrl } = createHarness();
		const instance = init(ctrl);
		instance.measure.mockClear();

		ctrl.scrollToIndex(7, { align: 'center' });
		ctrl.measure();

		expect(instance.scrollToIndex).toHaveBeenCalledWith(7, { align: 'center' });
		expect(instance.measure).toHaveBeenCalledTimes(1);
	});

	it('syncs immediately for synchronous virtualizer changes and schedules async changes', () => {
		const { ctrl, host } = createHarness();
		const instance = init(ctrl);
		host.requestUpdate.mockClear();

		instance.items = [{ index: 5, start: 125, size: 25 }];
		instance.totalSize = 600;
		instance.options.onChange(instance, true);

		expect(ctrl.vItems).toEqual([{ index: 5, start: 125, size: 25 }]);
		expect(host.requestUpdate).toHaveBeenCalledTimes(1);

		instance.items = [{ index: 8, start: 200, size: 25 }];
		instance.totalSize = 700;
		instance.options.onChange(instance, false);
		instance.options.onChange(instance, false);

		expect(ctrl.vItems).toEqual([{ index: 5, start: 125, size: 25 }]);
		expect(rafCallbacks).toHaveLength(1);

		flushRaf();

		expect(ctrl.vItems).toEqual([{ index: 8, start: 200, size: 25 }]);
		expect(host.requestUpdate).toHaveBeenCalledTimes(2);
	});

	it('watches viewport size changes and ignores unchanged widths', () => {
		const { ctrl, host, vscroll, headWrap } = createHarness({ width: 300 });
		const instance = init(ctrl);
		ctrl.installViewportResizeWatcher();
		const viewportObserver = MockResizeObserver.instances.at(-1)!;
		expect(viewportObserver.observe).toHaveBeenCalledWith(vscroll);
		expect(addEventListenerSpy).toHaveBeenCalledWith('resize', expect.any(Function), { passive: true });

		instance.measure.mockClear();
		host.requestUpdate.mockClear();
		vscroll.scrollLeft = 44;
		viewportObserver.trigger(180);

		expect(host.requestUpdate).not.toHaveBeenCalled();

		setClientSize(vscroll, 420, 180);
		viewportObserver.trigger(180);

		expect(ctrl.viewportW).toBe(420);
		expect(headWrap.scrollLeft).toBe(44);
		expect(instance.measure).toHaveBeenCalledTimes(1);
		expect(host.requestUpdate).toHaveBeenCalled();
	});

	it('resets the current scroll element, virtualizer, observers, and measurements', () => {
		const { ctrl } = createHarness({ width: 300 });
		const instance = init(ctrl);
		ctrl.installViewportResizeWatcher();
		instance.options.onChange(instance, false);
		expect(rafCallbacks).toHaveLength(1);

		ctrl.resetScrollElement();

		expect(instance.cleanup).toHaveBeenCalledTimes(1);
		expect(MockResizeObserver.instances.at(-1)?.disconnect).toHaveBeenCalled();
		expect(removeEventListenerSpy).toHaveBeenCalledWith('resize', expect.any(Function));
		expect(cancelAnimationFrameSpy).toHaveBeenCalledTimes(1);
		expect(rafCallbacks).toHaveLength(0);
		expect(ctrl.vItems).toEqual([]);
		expect(ctrl.vTotalSize).toBe(0);
		expect(ctrl.viewportW).toBe(0);
	});

	it('cleans up observers, virtualizer cleanup, resize listener, and scheduled sync on disconnect', () => {
		const { ctrl } = createHarness();
		const instance = init(ctrl);
		ctrl.installViewportResizeWatcher();
		instance.options.onChange(instance, false);
		expect(rafCallbacks).toHaveLength(1);
		const resizeListener = addEventListenerSpy.mock.calls.find(call => call[0] === 'resize')?.[1];
		expect(typeof resizeListener).toBe('function');

		ctrl.hostDisconnected();

		expect(instance.cleanup).toHaveBeenCalledTimes(1);
		expect(MockResizeObserver.instances.at(-1)?.disconnect).toHaveBeenCalled();
		expect(removeEventListenerSpy).toHaveBeenCalledWith('resize', resizeListener);
		expect(cancelAnimationFrameSpy).toHaveBeenCalledTimes(1);
		expect(rafCallbacks).toHaveLength(0);
	});
});
