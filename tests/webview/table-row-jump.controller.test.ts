import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RowJumpHost } from '../../src/webview/components/table-row-jump.controller.js';
import { TableRowJumpController } from '../../src/webview/components/table-row-jump.controller.js';

// ── Mock host factory ─────────────────────────────────────────────────────────

function createMockHost(): RowJumpHost {
	const el = document.createElement('div') as unknown as RowJumpHost;
	return Object.assign(el, {
		addController: vi.fn(),
		removeController: vi.fn(),
		requestUpdate: vi.fn(),
		updateComplete: Promise.resolve(true),
		getSelectedCol: () => 0,
	});
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('TableRowJumpController', () => {
	let host: RowJumpHost;
	let ctrl: TableRowJumpController;
	let scrollSpy: ReturnType<typeof vi.fn<(index: number) => void>>;

	beforeEach(() => {
		host = createMockHost();
		ctrl = new TableRowJumpController(host);
		scrollSpy = vi.fn<(index: number) => void>();
		ctrl.scrollToRow = scrollSpy;
	});

	// ── toggle / close ────────────────────────────────────────────────────

	describe('toggle / close', () => {
		it('opens when closed', () => {
			ctrl.toggle(100);
			expect(ctrl.visible).toBe(true);
		});

		it('closes when open', () => {
			ctrl.toggle(100);
			ctrl.query = '5';
			ctrl.toggle(100);
			expect(ctrl.visible).toBe(false);
			expect(ctrl.query).toBe('');
			expect(ctrl.targets).toEqual([]);
			expect(ctrl.error).toBe('');
		});

		it('close() is a no-op when already closed', () => {
			ctrl.close(100);
			expect(ctrl.visible).toBe(false);
		});

		it('close() hides when open', () => {
			ctrl.toggle(100);
			ctrl.close(100);
			expect(ctrl.visible).toBe(false);
		});
	});

	// ── target parsing via exec / setQuery ────────────────────────────────

	describe('target parsing', () => {
		it('parses a single row number', () => {
			ctrl.setQuery('5', 100);
			expect(ctrl.targets).toEqual([4]); // 1-based → 0-based
			expect(ctrl.error).toBe('');
		});

		it('parses comma-separated row numbers', () => {
			ctrl.setQuery('1, 3, 5', 100);
			expect(ctrl.targets).toEqual([0, 2, 4]);
		});

		it('parses a range', () => {
			ctrl.setQuery('2-4', 10);
			expect(ctrl.targets).toEqual([1, 2, 3]);
		});

		it('handles reversed range (5-3)', () => {
			ctrl.setQuery('5-3', 10);
			expect(ctrl.targets).toEqual([2, 3, 4]);
		});

		it('parses mixed ranges and singles', () => {
			ctrl.setQuery('1, 3-5, 8', 10);
			expect(ctrl.targets).toEqual([0, 2, 3, 4, 7]);
		});

		it('deduplicates overlapping ranges', () => {
			ctrl.setQuery('1-3, 2-5', 10);
			expect(ctrl.targets).toEqual([0, 1, 2, 3, 4]);
		});

		it('returns empty targets and no error for empty query', () => {
			ctrl.setQuery('', 100);
			expect(ctrl.targets).toEqual([]);
			expect(ctrl.error).toBe('');
		});

		it('skips out-of-range rows silently', () => {
			ctrl.setQuery('99, 100, 101', 100);
			// Rows 99 and 100 are valid (1-based), 101 is out of range
			expect(ctrl.targets).toEqual([98, 99]);
			expect(ctrl.error).toBe('');
		});

		it('returns error when all rows are out of range', () => {
			ctrl.setQuery('200', 100);
			expect(ctrl.targets).toEqual([]);
			expect(ctrl.error).toBe('No rows in range (1-100)');
		});

		it('returns error for non-numeric input', () => {
			ctrl.setQuery('abc', 100);
			expect(ctrl.targets).toEqual([]);
			expect(ctrl.error).toBe('Invalid row number: abc');
		});

		it('returns error for row number 0', () => {
			ctrl.setQuery('0', 100);
			expect(ctrl.targets).toEqual([]);
			expect(ctrl.error).toContain('Invalid row number');
		});

		it('returns error for negative range start', () => {
			ctrl.setQuery('-1-5', 100);
			expect(ctrl.error).not.toBe('');
		});

		it('returns error when maxRows is 0', () => {
			ctrl.setQuery('1', 0);
			expect(ctrl.error).toBe('No rows available');
		});

		it('scrolls to first target on exec', () => {
			ctrl.setQuery('3', 10);
			expect(scrollSpy).toHaveBeenCalledWith(2); // 0-based
		});

		it('does not scroll when there are no valid targets', () => {
			ctrl.setQuery('abc', 10);
			expect(scrollSpy).not.toHaveBeenCalled();
		});
	});

	// ── navigation ────────────────────────────────────────────────────────

	describe('nextTarget / prevTarget', () => {
		beforeEach(() => {
			ctrl.setQuery('1, 5, 10', 20);
			// targets = [0, 4, 9]
		});

		it('next wraps around', () => {
			expect(ctrl.currentIndex).toBe(0);
			ctrl.nextTarget();
			expect(ctrl.currentIndex).toBe(1);
			ctrl.nextTarget();
			expect(ctrl.currentIndex).toBe(2);
			ctrl.nextTarget();
			expect(ctrl.currentIndex).toBe(0); // wraps
		});

		it('prev wraps around', () => {
			ctrl.prevTarget();
			expect(ctrl.currentIndex).toBe(2); // wraps to last
			ctrl.prevTarget();
			expect(ctrl.currentIndex).toBe(1);
		});

		it('scrolls to the current target', () => {
			ctrl.nextTarget();
			expect(scrollSpy).toHaveBeenLastCalledWith(4); // targets[1] = 4
		});

		it('no-ops when targets is empty', () => {
			ctrl.setQuery('', 10);
			scrollSpy.mockClear();
			ctrl.nextTarget();
			ctrl.prevTarget();
			expect(scrollSpy).not.toHaveBeenCalled();
		});
	});

	// ── reset ─────────────────────────────────────────────────────────────

	describe('reset', () => {
		it('clears targets, index, and error', () => {
			ctrl.setQuery('1, 2', 10);
			ctrl.reset();
			expect(ctrl.targets).toEqual([]);
			expect(ctrl.currentIndex).toBe(0);
			expect(ctrl.error).toBe('');
		});
	});
});
