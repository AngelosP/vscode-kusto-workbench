import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const overlayMocks = vi.hoisted(() => {
	const instances: any[] = [];
	const OverlayScrollbars = vi.fn((host: HTMLElement, options: unknown) => {
		const viewport = document.createElement('div');
		viewport.setAttribute('data-overlayscrollbars-viewport', 'overflowYScroll');
		while (host.firstChild) {
			viewport.appendChild(host.firstChild);
		}
		host.appendChild(viewport);
		const instance = {
			host,
			options,
			viewport,
			update: vi.fn(),
			destroy: vi.fn(),
			elements: vi.fn(() => ({ viewport, scrollOffsetElement: viewport, scrollEventElement: viewport })),
		};
		instances.push(instance);
		return instance;
	}) as any;

	return { OverlayScrollbars, instances };
});

vi.mock('overlayscrollbars', () => ({
	OverlayScrollbars: overlayMocks.OverlayScrollbars,
}));

let resizeObserveMock: ReturnType<typeof vi.fn>;
let mutationObserveMock: ReturnType<typeof vi.fn>;
const originalResizeObserver = globalThis.ResizeObserver;
const originalMutationObserver = globalThis.MutationObserver;
const originalWindowScrollBy = window.scrollBy;
const originalWindowScrollTo = window.scrollTo;
const originalWindowScrollYDescriptor = Object.getOwnPropertyDescriptor(window, 'scrollY');
const originalWindowPageYOffsetDescriptor = Object.getOwnPropertyDescriptor(window, 'pageYOffset');
const originalDocumentElementScrollTopDescriptor = Object.getOwnPropertyDescriptor(document.documentElement, 'scrollTop');

function restoreDescriptor(target: object, propertyName: string, descriptor: PropertyDescriptor | undefined): void {
	if (descriptor) {
		Object.defineProperty(target, propertyName, descriptor);
	} else {
		delete (target as Record<string, unknown>)[propertyName];
	}
}

beforeEach(() => {
	vi.resetModules();
	document.body.innerHTML = '';
	document.body.removeAttribute('data-kw-page-overlay-scroll');
	document.adoptedStyleSheets = [];
	overlayMocks.instances.length = 0;
	overlayMocks.OverlayScrollbars.mockClear();
	resizeObserveMock = vi.fn();
	mutationObserveMock = vi.fn();
	globalThis.ResizeObserver = vi.fn(function ResizeObserverMock() {
		return {
		observe: resizeObserveMock,
		unobserve: vi.fn(),
		disconnect: vi.fn(),
		};
	}) as unknown as typeof ResizeObserver;
	globalThis.MutationObserver = vi.fn(function MutationObserverMock() {
		return {
		observe: mutationObserveMock,
		disconnect: vi.fn(),
		takeRecords: vi.fn(() => []),
		};
	}) as unknown as typeof MutationObserver;
});

afterEach(() => {
	document.body.innerHTML = '';
	document.body.removeAttribute('data-kw-page-overlay-scroll');
	document.adoptedStyleSheets = [];
	window.scrollBy = originalWindowScrollBy;
	window.scrollTo = originalWindowScrollTo;
	restoreDescriptor(window, 'scrollY', originalWindowScrollYDescriptor);
	restoreDescriptor(window, 'pageYOffset', originalWindowPageYOffsetDescriptor);
	restoreDescriptor(document.documentElement, 'scrollTop', originalDocumentElementScrollTopDescriptor);
	if (originalResizeObserver) globalThis.ResizeObserver = originalResizeObserver;
	else delete (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
	if (originalMutationObserver) globalThis.MutationObserver = originalMutationObserver;
	else delete (globalThis as { MutationObserver?: typeof MutationObserver }).MutationObserver;
});

describe('page OverlayScrollbars bootstrap', () => {
	it('adopts structural CSS and initializes for standalone viewer opt-in', async () => {
		const { osLibrarySheet } = await import('../../src/webview/shared/os-library-styles.js');
		const { osThemeSheet } = await import('../../src/webview/shared/os-theme-styles.js');
		document.body.dataset.kwPageOverlayScroll = 'true';
		const viewer = document.createElement('kw-cached-values');
		document.body.appendChild(viewer);

		await import('../../src/webview/core/overlay-scrollbars.js');
		document.dispatchEvent(new Event('DOMContentLoaded'));

		const wrapper = document.querySelector('.kw-scroll-viewport') as HTMLElement | null;
		expect(wrapper).not.toBeNull();
		expect(wrapper!.querySelector('kw-cached-values')).toBe(viewer);
		expect(document.adoptedStyleSheets).toContain(osLibrarySheet);
		expect(document.adoptedStyleSheets).toContain(osThemeSheet);
		expect(overlayMocks.OverlayScrollbars).toHaveBeenCalledWith(wrapper, expect.objectContaining({
			overflow: { x: 'hidden', y: 'scroll' },
		}));
		const options = overlayMocks.OverlayScrollbars.mock.calls[0][1] as any;
		expect(typeof options.update?.ignoreMutation).toBe('function');
		expect(options.update?.attributes).toEqual(['hidden']);
		expect(resizeObserveMock).toHaveBeenCalledWith(viewer);
		expect(mutationObserveMock).toHaveBeenCalledWith(viewer, { childList: true });
	});

	it('ignores deep notebook mutations while allowing root layout mutations', async () => {
		document.body.dataset.kwPageOverlayScroll = 'true';
		const viewer = document.createElement('div');
		document.body.appendChild(viewer);

		await import('../../src/webview/core/overlay-scrollbars.js');
		document.dispatchEvent(new Event('DOMContentLoaded'));

		const wrapper = document.querySelector('.kw-scroll-viewport') as HTMLElement;
		const options = overlayMocks.OverlayScrollbars.mock.calls[0][1] as any;
		const ignoreMutation = options.update.ignoreMutation as (mutation: MutationRecord) => boolean;
		const section = document.createElement('kw-query-section');
		const internal = document.createElement('div');
		const sibling = document.createElement('div');
		const siblingInternal = document.createElement('button');
		viewer.appendChild(section);
		section.appendChild(internal);
		wrapper.appendChild(sibling);
		sibling.appendChild(siblingInternal);

		expect(ignoreMutation({ type: 'attributes', target: internal, attributeName: 'style' } as MutationRecord)).toBe(true);
		expect(ignoreMutation({ type: 'attributes', target: section, attributeName: 'class' } as MutationRecord)).toBe(false);
		expect(ignoreMutation({ type: 'attributes', target: section, attributeName: 'data-testid' } as MutationRecord)).toBe(true);
		expect(ignoreMutation({ type: 'childList', target: viewer } as MutationRecord)).toBe(false);
		expect(ignoreMutation({ type: 'attributes', target: siblingInternal, attributeName: 'style' } as MutationRecord)).toBe(false);
	});

	it('keeps pending forced updates regardless of request order in the frame', async () => {
		document.body.dataset.kwPageOverlayScroll = 'true';
		document.body.appendChild(document.createElement('kw-cached-values'));

		const overlayModule = await import('../../src/webview/core/overlay-scrollbars.js');
		document.dispatchEvent(new Event('DOMContentLoaded'));
		const instance = overlayMocks.instances[0];
		instance.update.mockClear();

		overlayModule.requestOverlayScrollbarUpdate(true);
		overlayModule.requestOverlayScrollbarUpdate(false);
		await new Promise(resolve => requestAnimationFrame(() => resolve(undefined)));

		expect(instance.update).toHaveBeenCalledTimes(1);
		expect(instance.update).toHaveBeenCalledWith(true);

		instance.update.mockClear();
		overlayModule.requestOverlayScrollbarUpdate(false);
		overlayModule.requestOverlayScrollbarUpdate(true);
		await new Promise(resolve => requestAnimationFrame(() => resolve(undefined)));

		expect(instance.update).toHaveBeenCalledTimes(1);
		expect(instance.update).toHaveBeenCalledWith(true);
	});

	it('uses the generated OverlayScrollbars viewport as the page scroll element', async () => {
		document.body.dataset.kwPageOverlayScroll = 'true';
		document.body.appendChild(document.createElement('kw-cached-values'));
		const scrollYDescriptor = Object.getOwnPropertyDescriptor(window, 'scrollY');
		const pageYOffsetDescriptor = Object.getOwnPropertyDescriptor(window, 'pageYOffset');
		const documentScrollTopDescriptor = Object.getOwnPropertyDescriptor(document.documentElement, 'scrollTop');

		const overlayModule = await import('../../src/webview/core/overlay-scrollbars.js');
		document.dispatchEvent(new Event('DOMContentLoaded'));
		const { getPageScrollElement, getScrollY } = await import('../../src/webview/core/utils.js');

		const instance = overlayMocks.instances[0];
		const viewport = instance.viewport as HTMLElement;
		viewport.scrollTop = 10;

		expect(viewport.getAttribute('data-kw-page-scroll-element')).toBe('true');
		expect(overlayModule.getOverlayScrollViewport()).toBe(viewport);
		expect(getPageScrollElement()).toBe(viewport);
		expect(getScrollY()).toBe(10);
		expect(Object.getOwnPropertyDescriptor(window, 'scrollY')).toEqual(scrollYDescriptor);
		expect(Object.getOwnPropertyDescriptor(window, 'pageYOffset')).toEqual(pageYOffsetDescriptor);
		expect(Object.getOwnPropertyDescriptor(document.documentElement, 'scrollTop')).toEqual(documentScrollTopDescriptor);

		window.scrollBy(0, 15);
		expect(viewport.scrollTop).toBe(25);

		window.scrollTo({ top: 3 });
		expect(viewport.scrollTop).toBe(3);
	});
});