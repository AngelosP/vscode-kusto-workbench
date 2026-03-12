// Utils module — converted from legacy/utils.js
// Window bridge exports at bottom for remaining legacy callers.
export {};

const _win = window as unknown as Record<string, unknown>;

function escapeHtml(str: string): string {
	const div = document.createElement('div');
	div.textContent = str;
	return div.innerHTML;
}

function escapeRegex(str: string): string {
	return str.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
}

function __kustoGetScrollY(): number {
	try {
		if (typeof window.scrollY === 'number') {
			return window.scrollY;
		}
	} catch { /* ignore */ }
	try {
		return (document && document.documentElement && typeof document.documentElement.scrollTop === 'number')
			? document.documentElement.scrollTop
			: 0;
	} catch {
		return 0;
	}
}

function __kustoMaybeAutoScrollWhileDragging(clientY: number, options?: { thresholdPx?: number; maxStepPx?: number }): number {
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
			try { window.scrollBy(0, scrollDeltaY); } catch { /* ignore */ }
		}
		return scrollDeltaY;
	} catch {
		return 0;
	}
}

// ======================================================================
// Window bridge: expose globals for remaining legacy callers
// ======================================================================
_win.escapeHtml = escapeHtml;
_win.escapeRegex = escapeRegex;
_win.__kustoGetScrollY = __kustoGetScrollY;
_win.__kustoMaybeAutoScrollWhileDragging = __kustoMaybeAutoScrollWhileDragging;
