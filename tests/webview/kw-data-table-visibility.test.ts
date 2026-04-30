import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KwDataTable } from '../../src/webview/components/kw-data-table.js';

const overlayMocks = vi.hoisted(() => {
	const instances: any[] = [];

	function setClientSize(el: HTMLElement, width: number, height: number): void {
		Object.defineProperty(el, 'clientWidth', { configurable: true, value: width });
		Object.defineProperty(el, 'clientHeight', { configurable: true, value: height });
	}

	const OverlayScrollbars = vi.fn((host: HTMLElement) => {
		const viewport = document.createElement('div');
		viewport.className = 'os-viewport';
		setClientSize(viewport, 320, 180);
		const instance: any = {
			host,
			viewport,
			destroyed: false,
			destroy: vi.fn(() => { instance.destroyed = true; }),
			elements: vi.fn(() => ({ viewport })),
		};
		instances.push(instance);
		return instance;
	}) as any;
	OverlayScrollbars.valid = vi.fn((instance: any) => !!instance && !instance.destroyed);

	return { OverlayScrollbars, instances };
});

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

vi.mock('overlayscrollbars', () => ({
	OverlayScrollbars: overlayMocks.OverlayScrollbars,
}));

vi.mock('@tanstack/virtual-core', () => ({
	Virtualizer: virtualMocks.MockVirtualizer,
	elementScroll: virtualMocks.elementScroll,
	observeElementRect: virtualMocks.observeElementRect,
	observeElementOffset: virtualMocks.observeElementOffset,
}));

import '../../src/webview/components/kw-data-table.js';

class MockResizeObserver {
	observe = vi.fn();
	disconnect = vi.fn();
}

let originalResizeObserver: typeof ResizeObserver | undefined;
let rafCallbacks: Map<number, FrameRequestCallback>;
let rafId: number;

function flushRaf(): void {
	const entries = Array.from(rafCallbacks.entries());
	rafCallbacks.clear();
	for (const [id, callback] of entries) {
		callback(id);
	}
}

async function settleTable(table: KwDataTable): Promise<void> {
	await table.updateComplete;
	flushRaf();
	await table.updateComplete;
}

function renderedCellText(table: KwDataTable): string[] {
	return Array.from(table.shadowRoot?.querySelectorAll('#dt-body tbody tr td:not(.rn)') ?? [])
		.map(cell => cell.textContent?.trim() ?? '');
}

beforeEach(() => {
	overlayMocks.instances.length = 0;
	overlayMocks.OverlayScrollbars.mockClear();
	overlayMocks.OverlayScrollbars.valid.mockClear();
	virtualMocks.instances.length = 0;
	virtualMocks.elementScroll.mockClear();
	virtualMocks.observeElementRect.mockClear();
	virtualMocks.observeElementOffset.mockClear();
	originalResizeObserver = globalThis.ResizeObserver;
	(globalThis as any).ResizeObserver = MockResizeObserver;
	rafCallbacks = new Map();
	rafId = 0;
	vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback: FrameRequestCallback) => {
		const id = ++rafId;
		rafCallbacks.set(id, callback);
		return id;
	});
	vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id: number) => {
		rafCallbacks.delete(id);
	});
});

afterEach(() => {
	document.body.replaceChildren();
	if (originalResizeObserver) {
		globalThis.ResizeObserver = originalResizeObserver;
	} else {
		delete (globalThis as any).ResizeObserver;
	}
	vi.restoreAllMocks();
});

describe('kw-data-table visibility lifecycle', () => {
	it('rebinds OverlayScrollbars and redraws virtualized rows after hide/show', async () => {
		const table = document.createElement('kw-data-table') as KwDataTable;
		table.columns = [{ name: 'Name' }];
		table.rows = [['alpha'], ['bravo'], ['charlie'], ['delta']];
		table.options = { showVisibilityToggle: true };
		document.body.appendChild(table);

		await settleTable(table);
		const firstVscroll = table.shadowRoot?.querySelector('.vscroll');
		expect(firstVscroll).toBeTruthy();
		expect(overlayMocks.instances).toHaveLength(1);
		expect(overlayMocks.instances[0].host).toBe(firstVscroll);
		expect(renderedCellText(table)).toEqual(['alpha', 'bravo', 'charlie']);

		table.setBodyVisible(false);
		await table.updateComplete;

		expect(table.shadowRoot?.querySelector('.vscroll')).toBeNull();
		expect(overlayMocks.instances[0].destroy).toHaveBeenCalledTimes(1);

		table.setBodyVisible(true);
		await settleTable(table);

		const secondVscroll = table.shadowRoot?.querySelector('.vscroll');
		expect(secondVscroll).toBeTruthy();
		expect(secondVscroll).not.toBe(firstVscroll);
		expect(overlayMocks.instances).toHaveLength(2);
		expect(overlayMocks.instances[1].host).toBe(secondVscroll);
		expect(virtualMocks.instances.at(-1)?.options.getScrollElement()).toBe(overlayMocks.instances[1].viewport);
		expect(renderedCellText(table)).toEqual(['alpha', 'bravo', 'charlie']);
	});

	it('emits visibility-toggle only for actual user-visible changes', async () => {
		const table = document.createElement('kw-data-table') as KwDataTable;
		table.columns = [{ name: 'Name' }];
		table.rows = [['alpha']];
		table.options = { showVisibilityToggle: true };
		document.body.appendChild(table);

		await settleTable(table);
		const listener = vi.fn();
		table.addEventListener('visibility-toggle', listener);

		table.setBodyVisible(true);
		table.setBodyVisible(false, { emit: false });
		table.setBodyVisible(false);
		table.setBodyVisible(true);

		expect(listener).toHaveBeenCalledTimes(1);
		expect(listener.mock.calls[0][0].detail).toEqual({ visible: true });
	});

	it('shows metadata tooltip only when hovering the result summary text', async () => {
		const table = document.createElement('kw-data-table') as KwDataTable;
		table.columns = [{ name: 'Name' }];
		table.rows = [['alpha'], ['bravo']];
		table.options = {
			label: 'Results',
			showVisibilityToggle: true,
			metadata: { clientActivityId: 'KW.execute_query;123', serverStats: { serverRowCount: 2 } },
		};
		document.body.appendChild(table);

		await settleTable(table);

		const summary = table.shadowRoot?.querySelector('.hinfo-anchor') as HTMLElement | null;
		const visibilityButton = table.shadowRoot?.querySelector('.vis-toggle') as HTMLElement | null;
		expect(summary).toBeTruthy();
		expect(visibilityButton).toBeTruthy();

		vi.useFakeTimers();
		try {
			visibilityButton!.dispatchEvent(new MouseEvent('mouseenter'));
			vi.advanceTimersByTime(600);
			await table.updateComplete;
			expect(table.shadowRoot?.querySelector('.mt-popup')).toBeNull();

			summary!.dispatchEvent(new MouseEvent('mouseenter'));
			vi.advanceTimersByTime(500);
			await table.updateComplete;
			expect(table.shadowRoot?.querySelector('.mt-popup')).toBeTruthy();
		} finally {
			vi.useRealTimers();
		}
	});
});