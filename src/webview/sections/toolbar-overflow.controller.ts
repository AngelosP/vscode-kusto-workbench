import type { ReactiveController, ReactiveControllerHost } from 'lit';

export interface ToolbarOverflowHost extends ReactiveControllerHost, HTMLElement {
	boxId: string;
	getOverflowStartIndex(): number;
	setOverflowStartIndex(index: number): void;
}

export class ToolbarOverflowController implements ReactiveController {
	host: ToolbarOverflowHost;
	private _resizeObserver: ResizeObserver | null = null;
	private _cachedItemWidths: number[] | null = null;

	constructor(host: ToolbarOverflowHost) {
		this.host = host;
		host.addController(this);
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
		this._resizeObserver.observe(toolbar);
		const wrapper = toolbar.closest('.query-editor-wrapper');
		if (wrapper) {
			this._resizeObserver.observe(wrapper);
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

		const toolbarStyle = getComputedStyle(toolbar);
		const paddingLeft = parseFloat(toolbarStyle.paddingLeft) || 0;
		const paddingRight = parseFloat(toolbarStyle.paddingRight) || 0;
		const gap = parseFloat(getComputedStyle(itemsContainer).gap) || 4;
		const overflowBtnWidth = 36;
		const availableWidth = toolbar.clientWidth - paddingLeft - paddingRight - overflowBtnWidth - gap;

		let totalWidth = 0;
		let newOverflowStart = -1;
		let btnIdx = 0;

		for (let i = 0; i < items.length; i++) {
			const item = items[i];
			const isSep = item.classList.contains('query-editor-toolbar-sep');
			const rawWidth = this._cachedItemWidths ? this._cachedItemWidths[i] : item.offsetWidth;
			const itemWidth = rawWidth + (i > 0 ? gap : 0);
			totalWidth += itemWidth;

			if (totalWidth > availableWidth && newOverflowStart === -1) {
				newOverflowStart = btnIdx;
				for (let j = i - 1; j >= 0; j--) {
					if (items[j].classList.contains('query-editor-toolbar-sep')) {
						newOverflowStart = this._countButtonsBefore(items, j);
						break;
					}
				}
				break;
			}

			if (!isSep) btnIdx++;
		}

		if (newOverflowStart !== this.host.getOverflowStartIndex()) {
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
		const widths = items.map(item => item.offsetWidth);
		if (widths.some(w => w === 0)) return;
		this._cachedItemWidths = widths;
	}

	private _refreshCacheIfAllVisible(items: HTMLElement[]): void {
		const liveWidths = items.map(item => item.offsetWidth);
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

	private _countButtonsBefore(items: HTMLElement[], upTo: number): number {
		let count = 0;
		for (let i = 0; i < upTo; i++) {
			if (!items[i].classList.contains('query-editor-toolbar-sep')) count++;
		}
		return count;
	}

	private _getToolbarElement(): HTMLElement | null {
		const boxId = String(this.host.boxId || '');
		if (!boxId) return null;
		return this.host.querySelector('#' + CSS.escape(boxId + '_toolbar')) as HTMLElement | null;
	}
}
