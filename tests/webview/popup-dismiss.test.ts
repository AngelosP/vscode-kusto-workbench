import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
	setupClickOutsideDismiss,
	setupScrollDismiss,
	pushDismissable,
	removeDismissable,
} from '../../src/webview/components/popup-dismiss.js';

// ── Click-outside dismiss ─────────────────────────────────────────────────────

describe('setupClickOutsideDismiss', () => {
	let container: HTMLDivElement;
	let onDismiss: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.useFakeTimers();
		container = document.createElement('div');
		document.body.appendChild(container);
		onDismiss = vi.fn();
	});

	afterEach(() => {
		container.remove();
		vi.useRealTimers();
	});

	it('does not dismiss on click inside the container', () => {
		setupClickOutsideDismiss(container, onDismiss);
		vi.advanceTimersByTime(1); // flush the deferred setTimeout(0)
		container.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, composed: true }));
		expect(onDismiss).not.toHaveBeenCalled();
	});

	it('dismisses on click outside the container', () => {
		setupClickOutsideDismiss(container, onDismiss);
		vi.advanceTimersByTime(1);
		document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, composed: true }));
		expect(onDismiss).toHaveBeenCalledOnce();
	});

	it('does not dismiss before deferred install', () => {
		setupClickOutsideDismiss(container, onDismiss);
		// Don't advance timers — listener not installed yet
		document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, composed: true }));
		expect(onDismiss).not.toHaveBeenCalled();
	});

	it('cleanup removes the listener', () => {
		const cleanup = setupClickOutsideDismiss(container, onDismiss);
		vi.advanceTimersByTime(1);
		cleanup();
		document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, composed: true }));
		expect(onDismiss).not.toHaveBeenCalled();
	});

	it('cleanup before install cancels the timer', () => {
		const cleanup = setupClickOutsideDismiss(container, onDismiss);
		cleanup(); // before setTimeout fires
		vi.advanceTimersByTime(1);
		document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, composed: true }));
		expect(onDismiss).not.toHaveBeenCalled();
	});
});

// ── Scroll dismiss ────────────────────────────────────────────────────────────

describe('setupScrollDismiss', () => {
	let onDismiss: ReturnType<typeof vi.fn>;
	let scrollEl: HTMLDivElement;

	beforeEach(() => {
		onDismiss = vi.fn();
		scrollEl = document.createElement('div');
		scrollEl.className = 'kw-scroll-viewport';
		document.body.appendChild(scrollEl);
	});

	afterEach(() => {
		scrollEl.remove();
	});

	it('does not dismiss on document-level scroll noise', () => {
		setupScrollDismiss(onDismiss, 20);
		document.dispatchEvent(new Event('scroll'));
		expect(onDismiss).not.toHaveBeenCalled();
	});

	it('does not dismiss when page scroll is within threshold', () => {
		setupScrollDismiss(onDismiss, 20);
		scrollEl.scrollTop = 10;
		scrollEl.dispatchEvent(new Event('scroll'));
		expect(onDismiss).not.toHaveBeenCalled();
	});

	it('dismisses when page scroll exceeds threshold', () => {
		setupScrollDismiss(onDismiss, 20);
		scrollEl.scrollTop = 21;
		scrollEl.dispatchEvent(new Event('scroll'));
		expect(onDismiss).toHaveBeenCalledOnce();
	});

	it('cleanup removes the listener', () => {
		const cleanup = setupScrollDismiss(onDismiss, 20);
		cleanup();
		scrollEl.scrollTop = 30;
		scrollEl.dispatchEvent(new Event('scroll'));
		expect(onDismiss).not.toHaveBeenCalled();
	});

	it('cleanup is idempotent', () => {
		const cleanup = setupScrollDismiss(onDismiss, 20);
		cleanup();
		cleanup(); // second call does nothing
		expect(onDismiss).not.toHaveBeenCalled();
	});
});

// ── Escape dismiss stack ──────────────────────────────────────────────────────

describe('pushDismissable / removeDismissable', () => {
	it('Escape calls the last pushed callback', () => {
		const cb1 = vi.fn();
		const cb2 = vi.fn();
		pushDismissable(cb1);
		pushDismissable(cb2);

		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

		expect(cb2).toHaveBeenCalledOnce();
		expect(cb1).not.toHaveBeenCalled();

		// Second Escape pops cb1
		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		expect(cb1).toHaveBeenCalledOnce();
	});

	it('removeDismissable prevents the callback from being called', () => {
		const cb = vi.fn();
		pushDismissable(cb);
		removeDismissable(cb);

		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		expect(cb).not.toHaveBeenCalled();
	});

	it('non-Escape keys do not fire callbacks', () => {
		const cb = vi.fn();
		pushDismissable(cb);

		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		expect(cb).not.toHaveBeenCalled();

		// Cleanup
		removeDismissable(cb);
	});
});
