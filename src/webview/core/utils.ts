// Utils module — pure utility functions for DOM escaping and scroll helpers.

export function escapeHtml(str: string): string {
	const div = document.createElement('div');
	div.textContent = str;
	return div.innerHTML;
}

export function escapeRegex(str: string): string {
	return str.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
}

export function getPageScrollElement(): HTMLElement | null {
	try {
		return (
			document.querySelector('.kw-scroll-viewport [data-kw-page-scroll-element="true"]') as HTMLElement | null
			|| document.querySelector('.kw-scroll-viewport [data-overlayscrollbars-viewport]') as HTMLElement | null
			|| document.querySelector('.kw-scroll-viewport') as HTMLElement | null
		);
	} catch {
		return null;
	}
}

function getDocumentScrollElement(): HTMLElement {
	return (document.scrollingElement as HTMLElement | null) || document.documentElement || document.body;
}

function isDocumentScrollElement(element: HTMLElement): boolean {
	return element === document.documentElement || element === document.body || element === document.scrollingElement;
}

function getPageScrollClientHeight(element: HTMLElement): number {
	if (isDocumentScrollElement(element)) {
		return Math.max(0, window.innerHeight || document.documentElement?.clientHeight || element.clientHeight || 0);
	}
	return Math.max(0, element.clientHeight || 0);
}

export function getPageScrollTop(scrollElement?: HTMLElement | null): number {
	try {
		const element = scrollElement || getPageScrollElement() || getDocumentScrollElement();
		return Math.max(0, element.scrollTop || 0);
	} catch {
		return 0;
	}
}

export function getPageScrollMaxTop(scrollElement?: HTMLElement | null): number {
	try {
		const element = scrollElement || getPageScrollElement() || getDocumentScrollElement();
		return Math.max(0, (element.scrollHeight || 0) - getPageScrollClientHeight(element));
	} catch {
		return 0;
	}
}

export function setPageScrollTop(scrollTop: number, scrollElement?: HTMLElement | null): number {
	try {
		const element = scrollElement || getPageScrollElement() || getDocumentScrollElement();
		const nextTop = Math.max(0, Math.min(getPageScrollMaxTop(element), Math.round(Number(scrollTop) || 0)));
		element.scrollTop = nextTop;
		if (isDocumentScrollElement(element)) {
			try { document.documentElement.scrollTop = nextTop; } catch { /* ignore */ }
			try { document.body.scrollTop = nextTop; } catch { /* ignore */ }
		}
		return element.scrollTop || nextTop;
	} catch {
		return 0;
	}
}

export function scrollPageBy(deltaX: number, deltaY: number, scrollElement?: HTMLElement | null): { left: number; top: number } {
	try {
		const element = scrollElement || getPageScrollElement() || getDocumentScrollElement();
		const nextLeft = Math.max(0, Math.round((element.scrollLeft || 0) + (Number(deltaX) || 0)));
		element.scrollLeft = nextLeft;
		const top = setPageScrollTop((element.scrollTop || 0) + (Number(deltaY) || 0), element);
		return { left: element.scrollLeft || nextLeft, top };
	} catch {
		return { left: 0, top: 0 };
	}
}

export function scrollElementIntoPageView(element: HTMLElement, block: ScrollLogicalPosition = 'nearest'): void {
	try {
		const scrollElement = getPageScrollElement();
		if (!scrollElement) {
			element.scrollIntoView({ block, behavior: 'auto' });
			return;
		}
		const scrollRect = scrollElement.getBoundingClientRect();
		const elementRect = element.getBoundingClientRect();
		let nextTop = getPageScrollTop(scrollElement);
		if (block === 'center') {
			nextTop += elementRect.top - scrollRect.top - Math.max(0, (scrollRect.height - Math.min(elementRect.height, scrollRect.height)) / 2);
		} else if (block === 'end') {
			nextTop += elementRect.bottom - scrollRect.bottom;
		} else if (block === 'start') {
			nextTop += elementRect.top - scrollRect.top;
		} else {
			if (elementRect.top < scrollRect.top) {
				nextTop += elementRect.top - scrollRect.top;
			} else if (elementRect.bottom > scrollRect.bottom) {
				nextTop += elementRect.bottom - scrollRect.bottom;
			}
		}
		setPageScrollTop(nextTop, scrollElement);
	} catch (e) { console.error('[kusto]', e); }
}

export function getScrollY(): number {
	try {
		const scrollElement = getPageScrollElement();
		if (scrollElement) return getPageScrollTop(scrollElement);
	} catch (e) { console.error('[kusto]', e); }
	try {
		if (typeof window.scrollY === 'number') {
			return window.scrollY;
		}
	} catch (e) { console.error('[kusto]', e); }
	try {
		return (document && document.documentElement && typeof document.documentElement.scrollTop === 'number')
			? document.documentElement.scrollTop
			: 0;
	} catch {
		return 0;
	}
}

type PageScrollListenerTarget = Window | HTMLElement;

interface PageScrollListenerRegistration {
	listener: EventListener;
	options?: AddEventListenerOptions | boolean;
	target: PageScrollListenerTarget | null;
}

const pageScrollListeners = new Set<PageScrollListenerRegistration>();

function getPageScrollListenerTarget(): PageScrollListenerTarget {
	return getPageScrollElement() || window;
}

function attachPageScrollListener(registration: PageScrollListenerRegistration, target: PageScrollListenerTarget): void {
	target.addEventListener('scroll', registration.listener, registration.options);
	registration.target = target;
}

function detachPageScrollListener(registration: PageScrollListenerRegistration): void {
	if (!registration.target) return;
	registration.target.removeEventListener('scroll', registration.listener, registration.options);
	registration.target = null;
}

export function refreshPageScrollListeners(): void {
	const nextTarget = getPageScrollListenerTarget();
	for (const registration of pageScrollListeners) {
		if (registration.target === nextTarget) continue;
		detachPageScrollListener(registration);
		attachPageScrollListener(registration, nextTarget);
	}
}

export function addPageScrollListener(listener: EventListener, options?: AddEventListenerOptions | boolean): () => void {
	const registration: PageScrollListenerRegistration = { listener, options, target: null };
	pageScrollListeners.add(registration);
	attachPageScrollListener(registration, getPageScrollListenerTarget());
	return () => {
		pageScrollListeners.delete(registration);
		detachPageScrollListener(registration);
	};
}

export function maybeAutoScrollWhileDragging(clientY: number, options?: { thresholdPx?: number; maxStepPx?: number }): number {
	// When dragging a resize handle near the viewport edge, scroll the page a bit so
	// the user can keep resizing even when the cursor hits the bottom/top of the screen.
	//
	// This intentionally scrolls in small steps ("slowly") to avoid jumpiness.
	try {
		const thresholdPx = Math.max(12, Math.min(120, (options && options.thresholdPx) ? Number(options.thresholdPx) : 48));
		const maxStepPx = Math.max(1, Math.min(30, (options && options.maxStepPx) ? Number(options.maxStepPx) : 10));

		const viewportH = Math.max(0, (typeof window.innerHeight === 'number') ? window.innerHeight : (document.documentElement ? document.documentElement.clientHeight : 0));
		if (!viewportH) {
			return 0;
		}

		const y = Number(clientY);
		if (!Number.isFinite(y)) {
			return 0;
		}

		let scrollDeltaY = 0;
		if (y > (viewportH - thresholdPx)) {
			const t = Math.max(0, Math.min(1, (y - (viewportH - thresholdPx)) / thresholdPx));
			scrollDeltaY = Math.ceil(maxStepPx * t);
		} else if (y < thresholdPx) {
			const t = Math.max(0, Math.min(1, (thresholdPx - y) / thresholdPx));
			scrollDeltaY = -Math.ceil(maxStepPx * t);
		}

		if (scrollDeltaY) {
			try { scrollPageBy(0, scrollDeltaY); } catch (e) { console.error('[kusto]', e); }
		}
		return scrollDeltaY;
	} catch {
		return 0;
	}
}
