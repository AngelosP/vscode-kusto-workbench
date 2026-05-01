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
 * Strategy: in webviews that opt into page overlay scrolling, wrap all body
 * children in a `.kw-scroll-viewport` div, set body to
 * `overflow: hidden; height: 100vh`, and initialise OverlayScrollbars on the
 * wrapper. This avoids breaking the 20+ call sites that read
 * `document.documentElement.scrollTop` — we patch `getScrollY()` and
 * `window.scrollBy/scrollTo` to delegate to the wrapper.
 */
import { OverlayScrollbars } from 'overlayscrollbars';
import { osLibrarySheet } from '../shared/os-library-styles.js';
import { osThemeSheet } from '../shared/os-theme-styles.js';
import { refreshPageScrollDismissRoot } from './page-scroll-dismiss.js';
import { refreshPageScrollListeners } from './utils.js';

// ── Body-specific overrides ──
const bodyStyles = /* css */ `
/* Lock body — the wrapper handles scrolling */
body {
	overflow: hidden !important;
	width: 100% !important;
	height: 100vh !important;
	margin: 0 !important;
	padding: 0 !important;
}

/* Scroll wrapper fills the viewport and provides the actual scroll */
.kw-scroll-viewport {
	box-sizing: border-box;
	width: 100%;
	height: 100vh;
	overflow: auto;
	padding: 16px; /* body padding moved here */
}

body[data-kw-page-overlay-scroll="true"] .kw-scroll-viewport {
	padding: 0;
}
`;

const bodySheet = new CSSStyleSheet();
bodySheet.replaceSync(bodyStyles);
document.adoptedStyleSheets = [...document.adoptedStyleSheets, osLibrarySheet, osThemeSheet];

function adoptBodySheet(): void {
	if (document.adoptedStyleSheets.includes(bodySheet)) return;
	document.adoptedStyleSheets = [...document.adoptedStyleSheets, bodySheet];
}

function shouldInitializePageScrollbars(): boolean {
	return !!document.getElementById('queries-container') || document.body?.dataset.kwPageOverlayScroll === 'true';
}

/** The actual page scroll element — used by getScrollY() and scrollBy(). */
let scrollViewport: HTMLElement | null = null;
let scrollbarsInstance: ReturnType<typeof OverlayScrollbars> | null = null;
let updateRaf = 0;
let pendingUpdateForce = false;

/** Expose the scroll viewport for tests and diagnostics. */
export function getOverlayScrollViewport(): HTMLElement | null {
	return scrollViewport;
}

function markPageScrollElement(element: HTMLElement): void {
	try { element.setAttribute('data-kw-page-scroll-element', 'true'); } catch (e) { console.error('[kusto]', e); }
}

function scrollElementBy(element: HTMLElement, xOrOptions?: number | ScrollToOptions, y?: number): void {
	if (typeof xOrOptions === 'object') {
		const top = Number(xOrOptions.top ?? 0);
		const left = Number(xOrOptions.left ?? 0);
		element.scrollTop += Number.isFinite(top) ? top : 0;
		element.scrollLeft += Number.isFinite(left) ? left : 0;
		return;
	}
	element.scrollLeft += Number.isFinite(Number(xOrOptions)) ? Number(xOrOptions) : 0;
	element.scrollTop += Number.isFinite(Number(y)) ? Number(y) : 0;
}

function scrollElementTo(element: HTMLElement, xOrOptions?: number | ScrollToOptions, y?: number): void {
	if (typeof xOrOptions === 'object') {
		if (xOrOptions.left !== undefined) element.scrollLeft = Number(xOrOptions.left) || 0;
		if (xOrOptions.top !== undefined) element.scrollTop = Number(xOrOptions.top) || 0;
		return;
	}
	element.scrollLeft = Number(xOrOptions) || 0;
	element.scrollTop = Number(y) || 0;
}

function isLayoutRelevantDirectAttribute(attributeName: string | null): boolean {
	return attributeName === 'class' || attributeName === 'style' || attributeName === 'hidden' || attributeName === 'open';
}

function shouldIgnorePageOverlayMutation(mutation: MutationRecord, contentRoot: HTMLElement, wrapper: HTMLElement): boolean {
	const target = mutation.target;
	if (!(target instanceof Element)) return true;
	if (target === contentRoot || target === wrapper) return false;
	if (!contentRoot.contains(target)) return false;
	if (target.parentElement === contentRoot) {
		return mutation.type === 'attributes' && !isLayoutRelevantDirectAttribute(mutation.attributeName);
	}
	return true;
}

export function requestOverlayScrollbarUpdate(force = false): void {
	if (!scrollbarsInstance) return;
	pendingUpdateForce = pendingUpdateForce || force;
	if (updateRaf) return;
	updateRaf = requestAnimationFrame(() => {
		const forceUpdate = pendingUpdateForce;
		updateRaf = 0;
		pendingUpdateForce = false;
		try { scrollbarsInstance?.update(forceUpdate); } catch (e) { console.error('[kusto]', e); }
	});
}

function init() {
	// Main editor opts in with #queries-container. Standalone viewers opt in with
	// a body data attribute when they want the same page-level VS Code scrollbar.
	if (!shouldInitializePageScrollbars()) return;
	adoptBodySheet();

	// Wrap all body children in a scroll container.
	const wrapper = document.createElement('div');
	wrapper.className = 'kw-scroll-viewport';

	// Move every existing body child into the wrapper.
	while (document.body.firstChild) {
		wrapper.appendChild(document.body.firstChild);
	}
	document.body.appendChild(wrapper);
	const content = document.getElementById('queries-container') || wrapper.firstElementChild || wrapper;

	// Initialise OverlayScrollbars on the wrapper.
	scrollbarsInstance = OverlayScrollbars(wrapper, {
		update: {
			attributes: ['hidden'],
			ignoreMutation: mutation => shouldIgnorePageOverlayMutation(mutation, content as HTMLElement, wrapper),
		},
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

	const elements = scrollbarsInstance.elements();
	const viewport = (elements.scrollOffsetElement || elements.viewport) as HTMLElement;
	scrollViewport = viewport || wrapper;
	markPageScrollElement(scrollViewport);
	refreshPageScrollListeners();
	refreshPageScrollDismissRoot();

	try {
		new ResizeObserver(() => requestOverlayScrollbarUpdate(true)).observe(content);
	} catch (e) { console.error('[kusto]', e); }
	try {
		new MutationObserver(() => requestOverlayScrollbarUpdate()).observe(content, { childList: true });
	} catch (e) { console.error('[kusto]', e); }
	window.addEventListener('resize', () => requestOverlayScrollbarUpdate(true));

	// ── Patch window.scrollBy / window.scrollTo to delegate to the wrapper ──
	// This ensures the 20+ existing call sites that use window.scrollBy() or
	// document.documentElement.scrollTop continue to work correctly.
	const origScrollBy = window.scrollBy.bind(window);
	const origScrollTo = window.scrollTo.bind(window);

	window.scrollBy = function scrollByPatched(xOrOptions?: number | ScrollToOptions, y?: number) {
		if (!scrollViewport) { origScrollBy(xOrOptions as number, y as number); return; }
		scrollElementBy(scrollViewport, xOrOptions, y);
	} as typeof window.scrollBy;

	window.scrollTo = function scrollToPatched(xOrOptions?: number | ScrollToOptions, y?: number) {
		if (!scrollViewport) { origScrollTo(xOrOptions as number, y as number); return; }
		scrollElementTo(scrollViewport, xOrOptions, y);
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
