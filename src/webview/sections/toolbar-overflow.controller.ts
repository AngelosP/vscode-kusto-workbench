import type { ReactiveController, ReactiveControllerHost } from 'lit';

export interface ToolbarOverflowHost extends ReactiveControllerHost, HTMLElement {
	boxId: string;
	getOverflowStartIndex(): number;
	setOverflowStartIndex(index: number): void;
}

/** Default overflow-button width used when the button is not yet in the DOM. */
const FALLBACK_OVERFLOW_BTN_WIDTH = 36;
/** Small safety margin to absorb sub-pixel rendering differences. */
const SUBPIXEL_BUFFER = 2;

export class ToolbarOverflowController implements ReactiveController {
	host: ToolbarOverflowHost;
	private _resizeObserver: ResizeObserver | null = null;
	private _cachedItemWidths: number[] | null = null;
	/** Timestamp of the last overflow state change — used to prevent oscillation. */
	private _lastStateChangeTime = 0;

	constructor(host: ToolbarOverflowHost) {
		this.host = host;
		host.addController(this);
	}

	hostConnected(): void {
		// Defer start until after the host's first render completes, so the
		// toolbar DOM element exists.  This also handles reconnects after DOM
		// reparenting (e.g. copilot chat split restructures the wrapper).
		this.host.updateComplete.then(() => this.start());
	}

	hostDisconnected(): void {
		this.stop();
	}

	start(): void {
		const toolbar = this._getToolbarElement();
		if (!toolbar) return;
		if (this._resizeObserver) {
			this._resizeObserver.disconnect();
		}
		this._resizeObserver = new ResizeObserver(() => {
			this.recompute();
		});
		// Observe the toolbar div itself.
		this._resizeObserver.observe(toolbar);
		// Observe the host custom element — its width changes when a copilot
		// chat split or other layout shift narrows the editor pane.
		this._resizeObserver.observe(this.host);
		// Observe the items container — its client width is the actual
		// available space for buttons.
		const itemsContainer = toolbar.querySelector('.qe-toolbar-items');
		if (itemsContainer) {
			this._resizeObserver.observe(itemsContainer);
		}
		requestAnimationFrame(() => {
			this._cacheItemWidths();
			this.recompute();
		});
	}

	stop(): void {
		if (!this._resizeObserver) return;
		this._resizeObserver.disconnect();
		this._resizeObserver = null;
	}

	recompute(): void {
		const toolbar = this._getToolbarElement();
		const itemsContainer = toolbar?.querySelector('.qe-toolbar-items') as HTMLElement | null;
		if (!toolbar || !itemsContainer) return;

		const items = Array.from(itemsContainer.children) as HTMLElement[];
		if (!items.length) return;
		this._refreshCacheIfAllVisible(items);

		if (this._cachedItemWidths && this._cachedItemWidths.length !== items.length) {
			this._cachedItemWidths = null;
		}
		if (!this._cachedItemWidths) {
			this._cacheItemWidths();
		}

		const currentOverflow = this.host.getOverflowStartIndex();

		// Phase 1 — determine whether overflow is needed.
		if (currentOverflow === -1) {
			// No overflow active. Use scrollWidth as ground-truth: if the
			// items container's content overflows its visible area, we need
			// the overflow menu.
			if (itemsContainer.scrollWidth <= itemsContainer.clientWidth + SUBPIXEL_BUFFER) {
				return; // everything fits — nothing to do
			}
			// Items overflow their container → fall through to Phase 2.
		} else {
			// Overflow is active. Check whether clearing it would let all
			// items fit (using cached natural widths).
			// Guard: skip the "clear" check for a short settling period after
			// the last state change to prevent oscillation at the boundary.
			const now = performance.now();
			if (now - this._lastStateChangeTime < 150) return;

			if (this._cachedItemWidths) {
				const toolbarStyle = getComputedStyle(toolbar);
				const pL = parseFloat(toolbarStyle.paddingLeft) || 0;
				const pR = parseFloat(toolbarStyle.paddingRight) || 0;
				const gap = parseFloat(getComputedStyle(itemsContainer).gap) || 0;
				const fullWidth = toolbar.getBoundingClientRect().width - pL - pR;
				let total = 0;
				for (let i = 0; i < this._cachedItemWidths.length; i++) {
					total += this._cachedItemWidths[i] + (i > 0 ? gap : 0);
				}
				// Use a generous margin to avoid oscillation: only clear
				// overflow if items fit with room for the overflow button
				// itself (i.e., the budget that Phase 2 would compute).
				// This ensures the "clear" threshold never disagrees with the
				// "set" threshold at the boundary.
				const tGap = parseFloat(toolbarStyle.gap) || 0;
				const overflowWrapper = toolbar.querySelector('.qe-toolbar-overflow-wrapper') as HTMLElement | null;
				const overflowBtnW = overflowWrapper ? overflowWrapper.getBoundingClientRect().width : FALLBACK_OVERFLOW_BTN_WIDTH;
				if (total <= fullWidth - overflowBtnW - tGap - SUBPIXEL_BUFFER) {
					this._lastStateChangeTime = now;
					this.host.setOverflowStartIndex(-1);
					return;
				}
			}
			// Still need overflow → fall through to Phase 2 to adjust cutoff.
		}

		// Phase 2 — compute the overflow cutoff point.
		const toolbarStyle = getComputedStyle(toolbar);
		const paddingLeft = parseFloat(toolbarStyle.paddingLeft) || 0;
		const paddingRight = parseFloat(toolbarStyle.paddingRight) || 0;
		const itemGap = parseFloat(getComputedStyle(itemsContainer).gap) || 0;
		const toolbarGap = parseFloat(toolbarStyle.gap) || 0;
		const fullAvailableWidth = toolbar.getBoundingClientRect().width - paddingLeft - paddingRight;

		const overflowWrapper = toolbar.querySelector('.qe-toolbar-overflow-wrapper') as HTMLElement | null;
		const overflowBtnWidth = overflowWrapper
			? overflowWrapper.getBoundingClientRect().width
			: FALLBACK_OVERFLOW_BTN_WIDTH;
		const availableWidth = fullAvailableWidth - overflowBtnWidth - toolbarGap - SUBPIXEL_BUFFER;

		let runningWidth = 0;
		let newOverflowStart = -1;
		let btnIdx = 0;

		for (let i = 0; i < items.length; i++) {
			const item = items[i];
			const isSep = item.classList.contains('query-editor-toolbar-sep');
			const rawWidth = this._cachedItemWidths ? this._cachedItemWidths[i] : item.getBoundingClientRect().width;
			runningWidth += rawWidth + (i > 0 ? itemGap : 0);

			if (runningWidth > availableWidth && newOverflowStart === -1) {
				newOverflowStart = btnIdx;
				break;
			}

			if (!isSep) btnIdx++;
		}

		if (newOverflowStart !== currentOverflow) {
			this._lastStateChangeTime = performance.now();
			this.host.setOverflowStartIndex(newOverflowStart);
		}
	}

	private _cacheItemWidths(): void {
		if (this._cachedItemWidths) return;
		const toolbar = this._getToolbarElement();
		const itemsContainer = toolbar?.querySelector('.qe-toolbar-items') as HTMLElement | null;
		if (!itemsContainer) return;
		const items = Array.from(itemsContainer.children) as HTMLElement[];
		if (!items.length) return;
		const widths = items.map(item => item.getBoundingClientRect().width);
		if (widths.some(w => w === 0)) return;
		this._cachedItemWidths = widths;
	}

	private _refreshCacheIfAllVisible(items: HTMLElement[]): void {
		const liveWidths = items.map(item => item.getBoundingClientRect().width);
		if (liveWidths.some(w => w === 0)) return;
		if (!this._cachedItemWidths || this._cachedItemWidths.length !== liveWidths.length) {
			this._cachedItemWidths = liveWidths;
			return;
		}
		for (let i = 0; i < liveWidths.length; i++) {
			if (Math.abs(liveWidths[i] - this._cachedItemWidths[i]) > 1) {
				this._cachedItemWidths = liveWidths;
				return;
			}
		}
	}

	private _getToolbarElement(): HTMLElement | null {
		const boxId = String(this.host.boxId || '');
		if (!boxId) return null;
		return this.host.querySelector('#' + CSS.escape(boxId + '_toolbar')) as HTMLElement | null;
	}
}
