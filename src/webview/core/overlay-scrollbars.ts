/**
 * DOM-based overlay scrollbars for the main webview.
 *
 * Replaces the native browser scrollbar on the page-level scroll container
 * with a lightweight overlay that matches VS Code's look: thin rectangular
 * thumb, no arrow buttons, transparent track, theme-aware colors.
 *
 * Uses the OverlayScrollbars library which preserves native scroll feel
 * (momentum, keyboard, touch) while rendering a custom DOM scrollbar.
 *
 * Strategy: wrap all body children in a `.kw-scroll-viewport` div, set
 * body to `overflow: hidden; height: 100vh`, and initialise OverlayScrollbars
 * on the wrapper. This avoids breaking the 20+ call sites that read
 * `document.documentElement.scrollTop` — we patch `getScrollY()` and
 * `window.scrollBy/scrollTo` to delegate to the wrapper.
 */
import { OverlayScrollbars } from 'overlayscrollbars';
import { osThemeSheet } from '../shared/os-theme-styles.js';

// ── Body-specific overrides ──
const bodyStyles = /* css */ `
/* Lock body — the wrapper handles scrolling */
body {
	overflow: hidden !important;
	height: 100vh !important;
	padding: 0 !important;
}

/* Scroll wrapper fills the viewport and provides the actual scroll */
.kw-scroll-viewport {
	height: 100vh;
	overflow: auto;
	padding: 16px; /* body padding moved here */
}
`;

const bodySheet = new CSSStyleSheet();
bodySheet.replaceSync(bodyStyles);
document.adoptedStyleSheets = [...document.adoptedStyleSheets, osThemeSheet, bodySheet];

/** The scroll wrapper element — used by getScrollY() and scrollBy(). */
let scrollViewport: HTMLElement | null = null;
let scrollbarsInstance: ReturnType<typeof OverlayScrollbars> | null = null;
let updateRaf = 0;

/** Expose the scroll viewport for `getScrollY()` in utils.ts. */
export function getOverlayScrollViewport(): HTMLElement | null {
	return scrollViewport;
}

export function requestOverlayScrollbarUpdate(force = false): void {
	if (!scrollbarsInstance) return;
	if (updateRaf) cancelAnimationFrame(updateRaf);
	updateRaf = requestAnimationFrame(() => {
		updateRaf = 0;
		try { scrollbarsInstance?.update(force); } catch (e) { console.error('[kusto]', e); }
	});
}

function init() {
	// Only run in the main query editor webview (has #queries-container).
	// Viewer webviews (Connection Manager, Cached Values) have their own
	// root elements and must not have their DOM reparented.
	if (!document.getElementById('queries-container')) return;

	// Wrap all body children in a scroll container.
	const wrapper = document.createElement('div');
	wrapper.className = 'kw-scroll-viewport';

	// Move every existing body child into the wrapper.
	while (document.body.firstChild) {
		wrapper.appendChild(document.body.firstChild);
	}
	document.body.appendChild(wrapper);

	scrollViewport = wrapper;

	// Initialise OverlayScrollbars on the wrapper.
	scrollbarsInstance = OverlayScrollbars(wrapper, {
		scrollbars: {
			visibility: 'auto',
			autoHide: 'move',
			autoHideDelay: 800,
			autoHideSuspend: true,
		},
		overflow: {
			x: 'hidden',
			y: 'scroll',
		},
	});

	const content = document.getElementById('queries-container') || wrapper;
	try {
		new ResizeObserver(() => requestOverlayScrollbarUpdate(true)).observe(content);
	} catch (e) { console.error('[kusto]', e); }
	try {
		new MutationObserver(() => requestOverlayScrollbarUpdate(true)).observe(content, { childList: true, subtree: true, attributes: true });
	} catch (e) { console.error('[kusto]', e); }
	window.addEventListener('resize', () => requestOverlayScrollbarUpdate(true));

	// ── Patch window.scrollBy / window.scrollTo to delegate to the wrapper ──
	// This ensures the 20+ existing call sites that use window.scrollBy() or
	// document.documentElement.scrollTop continue to work correctly.
	const origScrollBy = window.scrollBy.bind(window);
	const origScrollTo = window.scrollTo.bind(window);

	window.scrollBy = function scrollByPatched(xOrOptions?: number | ScrollToOptions, y?: number) {
		if (!scrollViewport) { origScrollBy(xOrOptions as number, y as number); return; }
		if (typeof xOrOptions === 'object') {
			scrollViewport.scrollBy(xOrOptions);
		} else {
			scrollViewport.scrollBy(xOrOptions ?? 0, y ?? 0);
		}
	} as typeof window.scrollBy;

	window.scrollTo = function scrollToPatched(xOrOptions?: number | ScrollToOptions, y?: number) {
		if (!scrollViewport) { origScrollTo(xOrOptions as number, y as number); return; }
		if (typeof xOrOptions === 'object') {
			scrollViewport.scrollTo(xOrOptions);
		} else {
			scrollViewport.scrollTo(xOrOptions ?? 0, y ?? 0);
		}
	} as typeof window.scrollTo;

	// Patch document.documentElement.scrollTop and window.scrollY
	// to read from the wrapper.
	Object.defineProperty(document.documentElement, 'scrollTop', {
		get() { return scrollViewport ? scrollViewport.scrollTop : 0; },
		set(v: number) { if (scrollViewport) scrollViewport.scrollTop = v; },
		configurable: true,
	});

	Object.defineProperty(window, 'scrollY', {
		get() { return scrollViewport ? scrollViewport.scrollTop : 0; },
		configurable: true,
	});

	Object.defineProperty(window, 'pageYOffset', {
		get() { return scrollViewport ? scrollViewport.scrollTop : 0; },
		configurable: true,
	});
}

if (document.readyState === 'loading') {
	document.addEventListener('DOMContentLoaded', init);
} else {
	init();
}
