function escapeHtml(str) {
	const div = document.createElement('div');
	div.textContent = str;
	return div.innerHTML;
}

function escapeRegex(str) {
	return str.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
}

function __kustoGetScrollY() {
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

function __kustoMaybeAutoScrollWhileDragging(clientY, options) {
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
