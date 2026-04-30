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

export function getScrollY(): number {
	try {
		const scrollElement = getPageScrollElement();
		if (scrollElement) return scrollElement.scrollTop || 0;
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
			try { window.scrollBy(0, scrollDeltaY); } catch (e) { console.error('[kusto]', e); }
		}
		return scrollDeltaY;
	} catch {
		return 0;
	}
}
