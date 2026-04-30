import { getPageScrollElement, getScrollY } from './utils.js';

export type PageScrollDismissKind = 'scroll' | 'wheel';
export type PageScrollDismissMode = 'interactive' | 'ephemeral';

export interface PageScrollDismissContext {
	kind: PageScrollDismissKind;
	event: Event;
	scrollY: number;
	scrollAtOpen: number;
	deltaY: number;
}

export interface PageScrollDismissOptions {
	/** Interactive controls default to a 20px page-scroll threshold. */
	thresholdPx?: number;
	/** Ephemeral controls dismiss on the first real page-scroll movement. */
	mode?: PageScrollDismissMode;
	/** Close on wheel intent even if page scrollTop does not change. */
	dismissOnWheel?: boolean;
	/** Keep the registration after dismissal callback fires. */
	once?: boolean;
	/** Optional target/event filter for special cases such as Monaco suggest. */
	shouldDismiss?: (context: PageScrollDismissContext) => boolean;
	/** Debug label for tests and diagnostics. */
	label?: string;
}

type DismissCallback = (context: PageScrollDismissContext) => void;

interface RegistryEntry {
	id: number;
	onDismiss: DismissCallback;
	scrollAtOpen: number;
	thresholdPx: number;
	dismissOnWheel: boolean;
	once: boolean;
	shouldDismiss?: (context: PageScrollDismissContext) => boolean;
	label?: string;
}

const entries = new Map<number, RegistryEntry>();
let nextId = 1;
let scrollTarget: Window | HTMLElement | null = null;
let installed = false;
let mutationObserver: MutationObserver | null = null;
let rebindRaf = 0;

const scrollListenerOptions: AddEventListenerOptions = { passive: true };
const wheelListenerOptions: AddEventListenerOptions = { passive: true, capture: true };

function getCurrentPageScrollTarget(): Window | HTMLElement {
	return getPageScrollElement() || window;
}

function addListeners(target: Window | HTMLElement): void {
	target.addEventListener('scroll', onPageScroll, scrollListenerOptions);
	document.addEventListener('wheel', onPageWheel, wheelListenerOptions);
}

function removeListeners(target: Window | HTMLElement): void {
	target.removeEventListener('scroll', onPageScroll, scrollListenerOptions);
	document.removeEventListener('wheel', onPageWheel, wheelListenerOptions);
}

function ensureMutationObserver(): void {
	if (mutationObserver || typeof MutationObserver === 'undefined' || !document.body) return;
	mutationObserver = new MutationObserver(() => schedulePageScrollDismissRootRefresh());
	mutationObserver.observe(document.body, { childList: true, subtree: false, attributes: true, attributeFilter: ['class', 'data-kw-page-overlay-scroll'] });
}

function disconnectMutationObserver(): void {
	mutationObserver?.disconnect();
	mutationObserver = null;
}

function ensureListeners(): void {
	if (entries.size === 0) return;
	ensureMutationObserver();
	refreshPageScrollDismissRoot();
	if (installed) return;
	scrollTarget = getCurrentPageScrollTarget();
	addListeners(scrollTarget);
	installed = true;
	schedulePageScrollDismissRootRefresh();
}

function removeAllListeners(): void {
	if (rebindRaf) {
		cancelAnimationFrame(rebindRaf);
		rebindRaf = 0;
	}
	if (installed && scrollTarget) {
		removeListeners(scrollTarget);
	}
	installed = false;
	scrollTarget = null;
	disconnectMutationObserver();
}

export function refreshPageScrollDismissRoot(): void {
	if (entries.size === 0) return;
	const nextTarget = getCurrentPageScrollTarget();
	if (installed && scrollTarget === nextTarget) return;
	if (installed && scrollTarget) {
		removeListeners(scrollTarget);
	}
	scrollTarget = nextTarget;
	addListeners(scrollTarget);
	installed = true;
}

function schedulePageScrollDismissRootRefresh(): void {
	if (entries.size === 0 || rebindRaf) return;
	rebindRaf = requestAnimationFrame(() => {
		rebindRaf = 0;
		refreshPageScrollDismissRoot();
	});
}

function removeEntry(id: number): void {
	entries.delete(id);
	if (entries.size === 0) {
		removeAllListeners();
	}
}

function shouldDismissEntry(entry: RegistryEntry, context: PageScrollDismissContext): boolean {
	if (entry.shouldDismiss && !entry.shouldDismiss(context)) return false;
	if (context.kind === 'wheel') return entry.dismissOnWheel;
	const distance = Math.abs(context.scrollY - entry.scrollAtOpen);
	if (entry.thresholdPx <= 0) return distance > 0;
	return distance > entry.thresholdPx;
}

function canScrollElementVertically(element: HTMLElement, deltaY: number): boolean {
	try {
		if (!deltaY) return false;
		const style = getComputedStyle(element);
		const overflowY = style.overflowY || style.overflow;
		if (overflowY !== 'auto' && overflowY !== 'scroll') return false;
		const maxScrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
		if (maxScrollTop <= 0) return false;
		if (deltaY > 0) return element.scrollTop < maxScrollTop;
		return element.scrollTop > 0;
	} catch {
		return false;
	}
}

function wheelStartedInNestedScrollable(event: Event): boolean {
	try {
		if (!(event instanceof WheelEvent)) return false;
		const pageScrollElement = getPageScrollElement();
		const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
		for (const target of path) {
			if (target === pageScrollElement || target === window || target === document || target === document.body || target === document.documentElement) {
				return false;
			}
			if (!(target instanceof HTMLElement)) continue;
			if (canScrollElementVertically(target, event.deltaY)) return true;
		}
	} catch {
		return false;
	}
	return false;
}

function notifyEntries(kind: PageScrollDismissKind, event: Event): void {
	refreshPageScrollDismissRoot();
	if (kind === 'wheel' && wheelStartedInNestedScrollable(event)) return;
	const scrollY = getScrollY();
	const snapshot = [...entries.values()];
	for (const entry of snapshot) {
		if (!entries.has(entry.id)) continue;
		const context: PageScrollDismissContext = {
			kind,
			event,
			scrollY,
			scrollAtOpen: entry.scrollAtOpen,
			deltaY: scrollY - entry.scrollAtOpen,
		};
		if (!shouldDismissEntry(entry, context)) continue;
		if (entry.once) removeEntry(entry.id);
		entry.onDismiss(context);
	}
}

function onPageScroll(event: Event): void {
	notifyEntries('scroll', event);
}

function onPageWheel(event: Event): void {
	notifyEntries('wheel', event);
}

export function registerPageScrollDismissable(
	onDismiss: DismissCallback | (() => void),
	options: PageScrollDismissOptions = {},
): () => void {
	const mode = options.mode ?? 'interactive';
	const thresholdPx = options.thresholdPx ?? (mode === 'ephemeral' ? 0 : 20);
	const id = nextId++;
	const entry: RegistryEntry = {
		id,
		onDismiss: onDismiss as DismissCallback,
		scrollAtOpen: getScrollY(),
		thresholdPx,
		dismissOnWheel: !!options.dismissOnWheel,
		once: options.once !== false,
		shouldDismiss: options.shouldDismiss,
		label: options.label,
	};
	entries.set(id, entry);
	ensureListeners();

	let removed = false;
	return () => {
		if (removed) return;
		removed = true;
		removeEntry(id);
	};
}

export function getPageScrollDismissableCount(): number {
	return entries.size;
}