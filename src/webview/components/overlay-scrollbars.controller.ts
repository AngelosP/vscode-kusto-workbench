/**
 * Reusable Lit ReactiveController that auto-discovers scrollable containers
 * marked with `data-overlay-scroll` inside a component's shadow root and
 * initializes OverlayScrollbars on them.
 *
 * Usage in a Lit component:
 *   import { OverlayScrollbarsController } from './overlay-scrollbars.controller.js';
 *
 *   class MyComponent extends LitElement {
 *     private _osCtrl = new OverlayScrollbarsController(this);
 *     // ...
 *     render() {
 *       return html`<div data-overlay-scroll style="overflow:auto;">...</div>`;
 *     }
 *   }
 *
 * The component's `static styles` must include `osLibrarySheet` and
 * `osThemeSheet` for the overlay scrollbar styling to work inside Shadow DOM.
 *
 * Options can be customized per-element via data attributes:
 *   data-overlay-scroll="x:hidden y:scroll autoHide:never"  (default: x:scroll y:scroll)
 */
import { type ReactiveController, type ReactiveControllerHost } from 'lit';
import {
	OverlayScrollbars,
	type PartialOptions,
	type ScrollbarsAutoHideBehavior,
	type ScrollbarsVisibilityBehavior,
} from 'overlayscrollbars';

const ATTR = 'data-overlay-scroll';

const DEFAULT_OPTIONS: PartialOptions = {
	scrollbars: { visibility: 'auto', autoHide: 'leave', autoHideDelay: 800, autoHideSuspend: false },
	overflow: { x: 'scroll', y: 'scroll' },
};

interface ParsedOverlayScrollOptions {
	x?: string;
	y?: string;
	autoHide?: ScrollbarsAutoHideBehavior;
	visibility?: ScrollbarsVisibilityBehavior;
}

function isAutoHideBehavior(value: string): value is ScrollbarsAutoHideBehavior {
	return value === 'never' || value === 'scroll' || value === 'move' || value === 'leave';
}

function isVisibilityBehavior(value: string): value is ScrollbarsVisibilityBehavior {
	return value === 'auto' || value === 'visible' || value === 'hidden';
}

/** Parse per-element scrollbar overrides from the attribute value. */
function parseScrollOptions(attr: string | null): ParsedOverlayScrollOptions {
	if (!attr) return {};
	const result: ParsedOverlayScrollOptions = {};
	for (const part of attr.split(/\s+/)) {
		const [key, value] = part.split(':');
		if ((key === 'x' || key === 'y') && value) result[key] = value;
		else if (key === 'autoHide' && value && isAutoHideBehavior(value)) result.autoHide = value;
		else if (key === 'visibility' && value && isVisibilityBehavior(value)) result.visibility = value;
	}
	return result;
}

export class OverlayScrollbarsController implements ReactiveController {
	private _host: ReactiveControllerHost & HTMLElement;
	private _instances = new Map<HTMLElement, ReturnType<typeof OverlayScrollbars>>();

	constructor(host: ReactiveControllerHost & HTMLElement) {
		this._host = host;
		host.addController(this);
	}

	hostConnected(): void { /* init happens in hostUpdated after render */ }

	hostUpdated(): void {
		this._scan();
	}

	hostDisconnected(): void {
		this._destroyAll();
	}

	/** Force a re-scan (e.g. after conditional rendering changes). */
	rescan(): void { this._scan(); }

	/** Get the OverlayScrollbars instance for a specific element, if any. */
	getInstance(el: HTMLElement): ReturnType<typeof OverlayScrollbars> | undefined {
		return this._instances.get(el);
	}

	/** Get the actual viewport element for a specific scroll container (for virtualizer wiring). */
	getViewport(el: HTMLElement): HTMLElement | undefined {
		return this._instances.get(el)?.elements().viewport as HTMLElement | undefined;
	}

	private _scan(): void {
		const root = (this._host as HTMLElement).shadowRoot;
		if (!root) return;

		const marked = new Set(root.querySelectorAll<HTMLElement>(`[${ATTR}]`));

		// Initialize new elements.
		for (const el of marked) {
			const existing = this._instances.get(el);
			if (existing) {
				existing.update();
				continue;
			}
			const scrollOptions = parseScrollOptions(el.getAttribute(ATTR));
			const opts: PartialOptions = {
				...DEFAULT_OPTIONS,
				overflow: {
					x: (scrollOptions.x ?? 'scroll') as 'scroll' | 'hidden' | 'visible',
					y: (scrollOptions.y ?? 'scroll') as 'scroll' | 'hidden' | 'visible',
				},
				scrollbars: {
					...DEFAULT_OPTIONS.scrollbars,
					autoHide: scrollOptions.autoHide ?? DEFAULT_OPTIONS.scrollbars?.autoHide,
					visibility: scrollOptions.visibility ?? DEFAULT_OPTIONS.scrollbars?.visibility,
				},
			};
			const instance = OverlayScrollbars(el, opts);
			this._instances.set(el, instance);

			// Force-hide native scrollbar on the viewport element.
			// The library CSS uses [data-overlayscrollbars-viewport~=scrollbarHidden]
			// which should do this, but inside Shadow DOM the specificity race with
			// component styles can cause it to lose.
			const viewport = instance.elements().viewport;
			if (viewport) {
				(viewport as HTMLElement).style.scrollbarWidth = 'none';
			}
		}

		// Destroy removed elements.
		for (const [el, instance] of this._instances) {
			if (!marked.has(el)) {
				instance.destroy();
				this._instances.delete(el);
			}
		}
	}

	private _destroyAll(): void {
		for (const instance of this._instances.values()) {
			instance.destroy();
		}
		this._instances.clear();
	}
}
