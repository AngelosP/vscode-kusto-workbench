import { describe, it, expect, vi, afterEach } from 'vitest';
import {
	pushDismissable,
	removeDismissable,
} from '../../src/webview/components/dismiss-stack';

// NOTE: The core push/pop/LIFO behavior is also tested in popup-dismiss.test.ts
// which imports these via the popup-dismiss.ts re-export. This file covers
// additional edge cases specific to the dismiss-stack module.

// The module-level stack persists across tests, so each test must clean up.

function pressEscape(): void {
	document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
}

function pressEnter(): void {
	document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
}

// ── Edge cases ────────────────────────────────────────────────────────────────

describe('dismiss-stack — edge cases', () => {

	afterEach(() => {
		// Drain any remaining items to keep the stack clean between tests.
		// Push a sentinel, press Escape until we get it, then we know stack is clean.
		let sentinelCalled = false;
		const sentinel = () => { sentinelCalled = true; };
		pushDismissable(sentinel);
		// Pop items until our sentinel fires.
		for (let i = 0; i < 100; i++) {
			pressEscape();
			if (sentinelCalled) break;
		}
	});

	it('Escape on empty stack is a no-op', () => {
		// Stack should be empty at start (after afterEach cleanup).
		// Pressing Escape should not throw.
		pressEscape();
		// No assertion needed — we're verifying it doesn't throw.
	});

	it('removeDismissable with non-existent callback is a no-op', () => {
		const cb = vi.fn();
		removeDismissable(cb); // cb was never pushed
		// No assertion needed — we're verifying it doesn't throw.
	});

	it('removing a callback shifts remaining items correctly', () => {
		const cb1 = vi.fn();
		const cb2 = vi.fn();
		const cb3 = vi.fn();
		pushDismissable(cb1);
		pushDismissable(cb2);
		pushDismissable(cb3);

		// Remove the middle one.
		removeDismissable(cb2);

		// Escape should pop cb3 (top), then cb1.
		pressEscape();
		expect(cb3).toHaveBeenCalledOnce();
		expect(cb1).not.toHaveBeenCalled();

		pressEscape();
		expect(cb1).toHaveBeenCalledOnce();

		// cb2 should never have been called.
		expect(cb2).not.toHaveBeenCalled();
	});

	it('duplicate push results in both entries on the stack', () => {
		const cb = vi.fn();
		pushDismissable(cb);
		pushDismissable(cb);

		// First Escape pops the second push.
		pressEscape();
		expect(cb).toHaveBeenCalledTimes(1);

		// Second Escape pops the first push.
		pressEscape();
		expect(cb).toHaveBeenCalledTimes(2);
	});

	it('only the top item is popped per Escape', () => {
		const calls: string[] = [];
		const cb1 = () => calls.push('cb1');
		const cb2 = () => calls.push('cb2');
		const cb3 = () => calls.push('cb3');
		pushDismissable(cb1);
		pushDismissable(cb2);
		pushDismissable(cb3);

		pressEscape();
		expect(calls).toEqual(['cb3']);

		pressEscape();
		expect(calls).toEqual(['cb3', 'cb2']);

		pressEscape();
		expect(calls).toEqual(['cb3', 'cb2', 'cb1']);
	});

	it('non-Escape keys are ignored', () => {
		const cb = vi.fn();
		pushDismissable(cb);

		pressEnter();
		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));

		expect(cb).not.toHaveBeenCalled();

		// Cleanup
		removeDismissable(cb);
	});

	it('remove after pop does nothing (idempotent)', () => {
		const cb = vi.fn();
		pushDismissable(cb);

		pressEscape(); // pops cb
		expect(cb).toHaveBeenCalledOnce();

		// Removing again should be fine.
		removeDismissable(cb);
		pressEscape(); // empty stack
	});
});
