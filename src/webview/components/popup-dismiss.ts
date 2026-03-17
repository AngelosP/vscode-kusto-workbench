// Shared popup dismiss utilities.
// Three reusable behaviours: click-outside, scroll-threshold, and Escape-key
// (Escape is delegated to the existing dismiss-stack module).

export { pushDismissable, removeDismissable } from './dismiss-stack.js';

/**
 * Click-outside dismiss.
 * Adds a `mousedown` listener on `document` after a `setTimeout(0)` so the
 * opening click doesn't immediately close the popup.
 * Uses `composedPath()` for correct shadow-DOM traversal.
 * Returns a cleanup function that removes the listener.
 */
export function setupClickOutsideDismiss(
	container: HTMLElement | null,
	onDismiss: () => void,
): () => void {
	let handler: ((e: MouseEvent) => void) | null = null;

	const timer = setTimeout(() => {
		handler = (e: MouseEvent) => {
			if (container && e.composedPath().includes(container)) return;
			onDismiss();
		};
		document.addEventListener('mousedown', handler);
	}, 0);

	return () => {
		clearTimeout(timer);
		if (handler) document.removeEventListener('mousedown', handler);
	};
}

/**
 * Scroll dismiss with threshold.
 * Captures `scrollTop` at setup time. Fires `onDismiss` if scroll distance
 * exceeds `thresholdPx` (default 20). Uses a passive, capture-phase listener
 * on `document` so it fires before any child handlers.
 * Returns a cleanup function.
 */
export function setupScrollDismiss(
	onDismiss: () => void,
	thresholdPx = 20,
): () => void {
	const scrollAtOpen =
		document.documentElement.scrollTop || document.body.scrollTop || 0;

	let removed = false;

	const onScroll = () => {
		const scrollY =
			document.documentElement.scrollTop || document.body.scrollTop || 0;
		if (Math.abs(scrollY - scrollAtOpen) > thresholdPx) {
			onDismiss();
			cleanup();
		}
	};

	function cleanup() {
		if (removed) return;
		removed = true;
		document.removeEventListener('scroll', onScroll, true);
	}

	document.addEventListener('scroll', onScroll, { capture: true, passive: true } as AddEventListenerOptions);

	return cleanup;
}
