import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let cleanups: Array<() => void> = [];

async function loadRegistry() {
	return import('../../src/webview/core/page-scroll-dismiss.js');
}

function createScrollRoot(): HTMLDivElement {
	const root = document.createElement('div');
	root.className = 'kw-scroll-viewport';
	document.body.appendChild(root);
	return root;
}

beforeEach(() => {
	vi.resetModules();
	document.body.innerHTML = '';
	cleanups = [];
});

afterEach(() => {
	for (const cleanup of cleanups.splice(0)) {
		cleanup();
	}
	document.body.innerHTML = '';
});

describe('page-scroll-dismiss registry', () => {
	it('dismisses interactive entries only after the scroll threshold is exceeded', async () => {
		const root = createScrollRoot();
		const { registerPageScrollDismissable } = await loadRegistry();
		const onDismiss = vi.fn();
		cleanups.push(registerPageScrollDismissable(onDismiss, { thresholdPx: 20 }));

		root.scrollTop = 20;
		root.dispatchEvent(new Event('scroll'));
		expect(onDismiss).not.toHaveBeenCalled();

		root.scrollTop = 21;
		root.dispatchEvent(new Event('scroll'));
		expect(onDismiss).toHaveBeenCalledOnce();
	});

	it('dismisses ephemeral entries on any page scroll', async () => {
		const root = createScrollRoot();
		const { registerPageScrollDismissable } = await loadRegistry();
		const onDismiss = vi.fn();
		cleanups.push(registerPageScrollDismissable(onDismiss, { mode: 'ephemeral' }));

		root.scrollTop = 1;
		root.dispatchEvent(new Event('scroll'));
		expect(onDismiss).toHaveBeenCalledOnce();
	});

	it('ignores no-op scroll events for ephemeral entries', async () => {
		const root = createScrollRoot();
		const { registerPageScrollDismissable } = await loadRegistry();
		const onDismiss = vi.fn();
		cleanups.push(registerPageScrollDismissable(onDismiss, { mode: 'ephemeral' }));

		root.dispatchEvent(new Event('scroll'));
		expect(onDismiss).not.toHaveBeenCalled();
	});

	it('broadcasts scroll dismissal to every active entry', async () => {
		const root = createScrollRoot();
		const { registerPageScrollDismissable, getPageScrollDismissableCount } = await loadRegistry();
		const first = vi.fn();
		const second = vi.fn();
		cleanups.push(registerPageScrollDismissable(first, { thresholdPx: 5 }));
		cleanups.push(registerPageScrollDismissable(second, { thresholdPx: 5 }));

		root.scrollTop = 6;
		root.dispatchEvent(new Event('scroll'));

		expect(first).toHaveBeenCalledOnce();
		expect(second).toHaveBeenCalledOnce();
		expect(getPageScrollDismissableCount()).toBe(0);
	});

	it('respects shouldDismiss filters', async () => {
		const root = createScrollRoot();
		const { registerPageScrollDismissable } = await loadRegistry();
		const onDismiss = vi.fn();
		cleanups.push(registerPageScrollDismissable(onDismiss, {
			mode: 'ephemeral',
			shouldDismiss: () => false,
		}));

		root.dispatchEvent(new Event('scroll'));
		expect(onDismiss).not.toHaveBeenCalled();
	});

	it('uses wheel intent only for entries that opt in', async () => {
		const root = createScrollRoot();
		const { registerPageScrollDismissable } = await loadRegistry();
		const scrollOnly = vi.fn();
		const wheelAware = vi.fn();
		cleanups.push(registerPageScrollDismissable(scrollOnly, { thresholdPx: 20 }));
		cleanups.push(registerPageScrollDismissable(wheelAware, { thresholdPx: 20, dismissOnWheel: true }));

		root.dispatchEvent(new Event('wheel'));

		expect(scrollOnly).not.toHaveBeenCalled();
		expect(wheelAware).toHaveBeenCalledOnce();
	});

	it('uses wheel intent from body-appended floating UI outside the page scroll root', async () => {
		createScrollRoot();
		const floatingMenu = document.createElement('div');
		document.body.appendChild(floatingMenu);
		const { registerPageScrollDismissable } = await loadRegistry();
		const onDismiss = vi.fn();
		cleanups.push(registerPageScrollDismissable(onDismiss, { dismissOnWheel: true }));

		floatingMenu.dispatchEvent(new WheelEvent('wheel', { bubbles: true, composed: true, deltaY: 40 }));

		expect(onDismiss).toHaveBeenCalledOnce();
	});

	it('ignores wheel intent inside a nested scrollable that can still scroll', async () => {
		const root = createScrollRoot();
		const nested = document.createElement('div');
		nested.style.overflowY = 'auto';
		Object.defineProperty(nested, 'clientHeight', { configurable: true, value: 100 });
		Object.defineProperty(nested, 'scrollHeight', { configurable: true, value: 300 });
		root.appendChild(nested);

		const { registerPageScrollDismissable } = await loadRegistry();
		const onDismiss = vi.fn();
		cleanups.push(registerPageScrollDismissable(onDismiss, { dismissOnWheel: true }));

		nested.dispatchEvent(new WheelEvent('wheel', { bubbles: true, composed: true, deltaY: 40 }));

		expect(onDismiss).not.toHaveBeenCalled();
	});

	it('uses wheel intent at the edge of a nested scrollable', async () => {
		const root = createScrollRoot();
		const nested = document.createElement('div');
		nested.style.overflowY = 'auto';
		Object.defineProperty(nested, 'clientHeight', { configurable: true, value: 100 });
		Object.defineProperty(nested, 'scrollHeight', { configurable: true, value: 300 });
		nested.scrollTop = 200;
		root.appendChild(nested);

		const { registerPageScrollDismissable } = await loadRegistry();
		const onDismiss = vi.fn();
		cleanups.push(registerPageScrollDismissable(onDismiss, { dismissOnWheel: true }));

		nested.dispatchEvent(new WheelEvent('wheel', { bubbles: true, composed: true, deltaY: 40 }));

		expect(onDismiss).toHaveBeenCalledOnce();
	});

	it('does not call an entry removed by an earlier callback in the same broadcast', async () => {
		const root = createScrollRoot();
		const { registerPageScrollDismissable } = await loadRegistry();
		const second = vi.fn();
		let cleanupSecond: (() => void) | null = null;
		const first = vi.fn(() => cleanupSecond?.());
		cleanups.push(registerPageScrollDismissable(first, { thresholdPx: 5 }));
		cleanupSecond = registerPageScrollDismissable(second, { thresholdPx: 5 });
		cleanups.push(cleanupSecond);

		root.scrollTop = 6;
		root.dispatchEvent(new Event('scroll'));

		expect(first).toHaveBeenCalledOnce();
		expect(second).not.toHaveBeenCalled();
	});

	it('rebinds to a later-created page scroll root', async () => {
		const { registerPageScrollDismissable, refreshPageScrollDismissRoot } = await loadRegistry();
		const onDismiss = vi.fn();
		cleanups.push(registerPageScrollDismissable(onDismiss, { thresholdPx: 20 }));

		const root = createScrollRoot();
		refreshPageScrollDismissRoot();

		window.dispatchEvent(new Event('scroll'));
		expect(onDismiss).not.toHaveBeenCalled();

		root.scrollTop = 21;
		root.dispatchEvent(new Event('scroll'));
		expect(onDismiss).toHaveBeenCalledOnce();
	});

	it('cleanup is idempotent', async () => {
		const root = createScrollRoot();
		const { registerPageScrollDismissable, getPageScrollDismissableCount } = await loadRegistry();
		const onDismiss = vi.fn();
		const cleanup = registerPageScrollDismissable(onDismiss, { thresholdPx: 5 });

		cleanup();
		cleanup();
		root.scrollTop = 6;
		root.dispatchEvent(new Event('scroll'));

		expect(onDismiss).not.toHaveBeenCalled();
		expect(getPageScrollDismissableCount()).toBe(0);
	});
});