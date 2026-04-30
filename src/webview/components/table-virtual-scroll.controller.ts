import type { ReactiveController, ReactiveControllerHost } from 'lit';
import { Virtualizer, elementScroll, observeElementRect, observeElementOffset } from '@tanstack/virtual-core';

/** Minimal interface the controller needs from its host element. */
export interface VirtualScrollHost extends ReactiveControllerHost, HTMLElement {
	getTableRowCount(): number;
	getEstimatedRowHeight(): number;
}

interface VItem { index: number; start: number; size: number; }

const OVERSCAN = 10;

/**
 * Manages the TanStack Virtual instance, ResizeObservers, and viewport measurements
 * for the `<kw-data-table>` component.
 */
export class TableVirtualScrollController implements ReactiveController {
	host: VirtualScrollHost;

	// ── Public state (read by host in render()) ──
	vItems: VItem[] = [];
	vTotalSize = 0;
	viewportW = 0;

	// ── Private ──
	private _virtualizer: Virtualizer<HTMLDivElement, Element> | null = null;
	private _resizeObs: ResizeObserver | null = null;
	private _viewportResizeObs: ResizeObserver | null = null;
	private _virtualizerCleanup: (() => void) | null = null;
	private _syncRaf = 0;
	private _lastVStart = -1;
	private _lastVEnd = -1;
	private _lastVTopOffset = 0;
	private _lastViewportW = 0;
	/** Optional override — when set, used instead of querying `.vscroll`. */
	private _scrollElementOverride: HTMLElement | null = null;

	constructor(host: VirtualScrollHost) {
		this.host = host;
		host.addController(this);
	}

	hostConnected(): void {
		// No-op — virtualizer is created lazily via initVirtualizer().
	}

	hostDisconnected(): void {
		this._resizeObs?.disconnect();
		this._resizeObs = null;
		this._viewportResizeObs?.disconnect();
		this._viewportResizeObs = null;
		this._virtualizerCleanup?.();
		this._virtualizerCleanup = null;
		this._virtualizer = null;
		if (this._syncRaf) { cancelAnimationFrame(this._syncRaf); this._syncRaf = 0; }
		window.removeEventListener('resize', this._onViewportResize);
	}

	// ── Public API ──

	/** Override the scroll element (e.g. OverlayScrollbars viewport). */
	setScrollElement(el: HTMLElement | null): void {
		if (this._scrollElementOverride === el) return;
		this._scrollElementOverride = el;
		this._lastViewportW = -1;
	}

	/** Release the current scroll element and virtualizer state when the scroll host is removed. */
	resetScrollElement(): void {
		this._resizeObs?.disconnect();
		this._resizeObs = null;
		this._viewportResizeObs?.disconnect();
		this._viewportResizeObs = null;
		this._virtualizerCleanup?.();
		this._virtualizerCleanup = null;
		this._virtualizer = null;
		this._scrollElementOverride = null;
		if (this._syncRaf) { cancelAnimationFrame(this._syncRaf); this._syncRaf = 0; }
		window.removeEventListener('resize', this._onViewportResize);
		this.vItems = [];
		this.vTotalSize = 0;
		this.viewportW = 0;
		this._lastVStart = -1;
		this._lastVEnd = -1;
		this._lastVTopOffset = 0;
		this._lastViewportW = 0;
	}

	/** Resolve the active scroll element — override or `.vscroll` fallback. */
	private _getScrollEl(): HTMLDivElement | null {
		return (this._scrollElementOverride ?? this.host.shadowRoot?.querySelector('.vscroll')) as HTMLDivElement | null;
	}

	initVirtualizer(): void {
		this._resizeObs?.disconnect();
		this._resizeObs = null;
		requestAnimationFrame(() => {
			const el = this._getScrollEl();
			if (!el) return;
			if (el.clientHeight > 0) { this._createVirtualizer(el); return; }
			this._resizeObs?.disconnect();
			this._resizeObs = new ResizeObserver((entries) => {
				for (const e of entries) {
					if (e.contentRect.height > 0) {
						this._resizeObs?.disconnect(); this._resizeObs = null;
						this._createVirtualizer(el);
						break;
					}
				}
			});
			this._resizeObs.observe(el);
		});
	}

	updateCount(): void {
		if (!this._virtualizer) { this.initVirtualizer(); return; }
		const count = this.host.getTableRowCount();
		const estimate = this.host.getEstimatedRowHeight();
		this._virtualizer.setOptions({
			count,
			getScrollElement: () => this._getScrollEl() as HTMLDivElement,
			estimateSize: () => estimate,
			overscan: OVERSCAN,
			scrollToFn: elementScroll,
			observeElementRect,
			observeElementOffset,
			onChange: this._onVirtualizerChange,
		});
		const el = this._getScrollEl();
		if (el) el.scrollTop = 0;
		this._lastVStart = -1;
		this._lastVEnd = -1;
		this._lastVTopOffset = 0;
		this._virtualizer.measure();
		this._sync();
		this.syncHeaderScroll();
	}

	scrollToIndex(index: number, opts?: { align?: 'auto' | 'center' | 'start' | 'end' }): void {
		this._virtualizer?.scrollToIndex(index, opts);
	}

	measure(): void {
		this._virtualizer?.measure();
		this._sync();
	}

	syncHeaderScroll(): void {
		const vscroll = this._getScrollEl();
		const headWrap = this.host.shadowRoot?.querySelector('.dtable-head-wrap') as HTMLElement | null;
		if (!vscroll || !headWrap) return;
		headWrap.scrollLeft = vscroll.scrollLeft;
	}

	installViewportResizeWatcher(): void {
		if (!this.host.shadowRoot) return;
		const vscroll = this._getScrollEl();
		if (!vscroll) return;
		if (!this._viewportResizeObs) {
			this._viewportResizeObs = new ResizeObserver(() => this._onViewportResize());
			window.addEventListener('resize', this._onViewportResize, { passive: true });
		}
		this._viewportResizeObs.disconnect();
		this._viewportResizeObs.observe(vscroll);
	}

	// ── Private ──

	private _createVirtualizer(el: HTMLDivElement): void {
		const count = this.host.getTableRowCount();
		const estimate = this.host.getEstimatedRowHeight();
		this._virtualizerCleanup?.();
		this._virtualizer = new Virtualizer({
			count, getScrollElement: () => this._getScrollEl() as HTMLDivElement, estimateSize: () => estimate, overscan: OVERSCAN,
			scrollToFn: elementScroll, observeElementRect, observeElementOffset,
			onChange: this._onVirtualizerChange,
		});
		this._virtualizerCleanup = this._virtualizer._didMount();
		this._virtualizer._willUpdate();
		this._sync();
	}

	private _sync(): void {
		if (!this._virtualizer) return;
		const items = this._virtualizer.getVirtualItems();
		const totalSize = this._virtualizer.getTotalSize();
		const vw = this._getScrollEl()?.clientWidth ?? 0;
		const start = items.length > 0 ? items[0].index : -1;
		const end = items.length > 0 ? items[items.length - 1].index : -1;
		const topOff = items.length > 0 ? items[0].start : 0;
		if (start === this._lastVStart && end === this._lastVEnd
			&& totalSize === this.vTotalSize && topOff === this._lastVTopOffset
			&& vw === this._lastViewportW) return;
		this._lastVStart = start;
		this._lastVEnd = end;
		this._lastVTopOffset = topOff;
		this._lastViewportW = vw;
		this.vItems = items.map(i => ({ index: i.index, start: i.start, size: i.size }));
		this.vTotalSize = totalSize;
		this.viewportW = vw;
		this.host.requestUpdate();
	}

	private _scheduleSync = (): void => {
		if (this._syncRaf) return;
		this._syncRaf = requestAnimationFrame(() => {
			this._syncRaf = 0;
			this._sync();
		});
	};

	private _onViewportResize = (): void => {
		const vw = this._getScrollEl()?.clientWidth ?? 0;
		if (vw <= 0 || vw === this.viewportW) return;
		this.viewportW = vw;
		this._lastViewportW = -1;
		this.host.requestUpdate();
		this.syncHeaderScroll();
		if (this._virtualizer) {
			this._virtualizer.measure();
			this._sync();
		}
	};

	private _onVirtualizerChange = (_instance: Virtualizer<HTMLDivElement, Element>, sync: boolean): void => {
		if (sync) this._sync();
		else this._scheduleSync();
	};
}
