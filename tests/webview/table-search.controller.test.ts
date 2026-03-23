import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SearchHost } from '../../src/webview/components/table-search.controller.js';
import type { CellValue } from '../../src/webview/components/kw-data-table.js';

// ── Mock host factory ─────────────────────────────────────────────────────────

function createMockHost(rows: CellValue[][] = []): SearchHost {
	const el = document.createElement('div') as unknown as SearchHost;
	return Object.assign(el, {
		addController: vi.fn(),
		removeController: vi.fn(),
		requestUpdate: vi.fn(),
		updateComplete: Promise.resolve(true),
		getTableRows: () => rows.map(r => ({ original: r })),
		scrollToRow: vi.fn(),
		setSelectedCell: vi.fn(),
		clearSelectionRange: vi.fn(),
	});
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('TableSearchController', () => {
	// Must install fake timers BEFORE importing/constructing controller, because
	// createDebouncedSearch captures setTimeout during class field initialization.
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	// vi.useFakeTimers() must be active before any setQuery() call, because
	// the debounced search calls setTimeout inside trigger(). The dynamic
	// import is a precaution to avoid module-level side effects with real timers.
	let TableSearchController: typeof import('../../src/webview/components/table-search.controller.js').TableSearchController;

	beforeEach(async () => {
		const mod = await import('../../src/webview/components/table-search.controller.js');
		TableSearchController = mod.TableSearchController;
	});

	function createController(rows: CellValue[][] = []) {
		const host = createMockHost(rows);
		const ctrl = new TableSearchController(host);
		return { host, ctrl };
	}

	// ── toggle / close ────────────────────────────────────────────────────

	describe('toggle / close', () => {
		it('opens search bar', () => {
			const { ctrl } = createController();
			ctrl.toggle();
			expect(ctrl.visible).toBe(true);
		});

		it('closes and resets state', () => {
			const { ctrl } = createController();
			ctrl.toggle(); // open
			ctrl.query = 'foo';
			ctrl.matches = [{ row: 0, col: 0 }];
			ctrl.toggle(); // close
			expect(ctrl.visible).toBe(false);
			expect(ctrl.query).toBe('');
			expect(ctrl.matches).toEqual([]);
		});

		it('close() is a no-op when already closed', () => {
			const { ctrl, host } = createController();
			(host.requestUpdate as any).mockClear();
			ctrl.close();
			expect(ctrl.visible).toBe(false);
			expect(host.requestUpdate).not.toHaveBeenCalled();
		});

		it('close() hides when open', () => {
			const { ctrl } = createController();
			ctrl.toggle();
			ctrl.close();
			expect(ctrl.visible).toBe(false);
		});
	});

	// ── search execution (setQuery + debounce) ────────────────────────────

	describe('setQuery', () => {
		const rows: CellValue[][] = [
			['apple', 'banana', 'cherry'],
			['avocado', 'blueberry', 'coconut'],
			['apricot', 'blackberry', 'cranberry'],
		];

		it('finds matches after debounce fires', () => {
			const { ctrl } = createController(rows);
			ctrl.setQuery('apple');
			expect(ctrl.matches).toEqual([]); // not yet
			vi.advanceTimersByTime(200);
			expect(ctrl.matches).toEqual([{ row: 0, col: 0 }]);
		});

		it('finds multiple matches', () => {
			const { ctrl } = createController(rows);
			ctrl.setQuery('a*berry');
			vi.advanceTimersByTime(200);
			// wildcard: avocado? no. blueberry starts with b. blackberry? a*berry → hmm.
			// "a*berry" in wildcard = /a.*?berry/gi
			// Row 0: apple, banana, cherry — no
			// Row 1: avocado no, blueberry no, coconut no
			// Actually let's check: 'blueberry'.match(/a.*?berry/) → no (doesn't start with a)
			// 'blackberry'.match(/a.*?berry/) → matches 'ackberry' inside 'blackberry'? No, 'blackberry' starts with 'b'
			// Actually: blackberry → does /a.*?berry/gi match? regex.test('blackberry') → 'a' at index 2, then '.*?' matches 'ckb', then 'berry' at 6 → yes!
			// 'cranberry' → /a.*?berry/gi → 'a' at index 2, '.*?' matches 'nb', 'berry' at index 5 → yes!
			expect(ctrl.matches.length).toBeGreaterThanOrEqual(2);
		});

		it('resets current match index on new query', () => {
			const { ctrl } = createController(rows);
			ctrl.setQuery('a');
			vi.advanceTimersByTime(200);
			ctrl.nextMatch(); // move to index 1
			ctrl.setQuery('apple');
			vi.advanceTimersByTime(200);
			expect(ctrl.currentMatchIndex).toBe(0);
		});

		it('empty query clears matches', () => {
			const { ctrl } = createController(rows);
			ctrl.setQuery('apple');
			vi.advanceTimersByTime(200);
			expect(ctrl.matches.length).toBe(1);
			ctrl.setQuery('');
			vi.advanceTimersByTime(200);
			expect(ctrl.matches).toEqual([]);
		});

		it('scrolls to first match', () => {
			const { ctrl, host } = createController(rows);
			ctrl.setQuery('coconut');
			vi.advanceTimersByTime(200);
			expect(host.scrollToRow).toHaveBeenCalledWith(1, { align: 'center' });
			expect(host.setSelectedCell).toHaveBeenCalledWith({ row: 1, col: 2 });
		});
	});

	// ── setMode ───────────────────────────────────────────────────────────

	describe('setMode', () => {
		it('re-executes search immediately (no debounce)', () => {
			const rows: CellValue[][] = [['test123'], ['hello']];
			const { ctrl } = createController(rows);
			ctrl.query = '\\d+';
			ctrl.setMode('regex');
			// regex mode: \d+ matches test123
			expect(ctrl.matches).toEqual([{ row: 0, col: 0 }]);
		});

		it('wildcard mode treats regex chars literally', () => {
			const rows: CellValue[][] = [['file.txt'], ['filetxt']];
			const { ctrl } = createController(rows);
			ctrl.query = 'file.txt';
			ctrl.setMode('wildcard');
			// wildcard escapes '.', so 'filetxt' should NOT match
			expect(ctrl.matches).toEqual([{ row: 0, col: 0 }]);
		});

		it('handles invalid regex gracefully', () => {
			const rows: CellValue[][] = [['test']];
			const { ctrl } = createController(rows);
			ctrl.query = '['; // unclosed bracket — invalid regex
			ctrl.setMode('regex');
			expect(ctrl.matches).toEqual([]);
		});
	});

	// ── match navigation ──────────────────────────────────────────────────

	describe('nextMatch / prevMatch', () => {
		const rows: CellValue[][] = [
			['a', 'b'],
			['a', 'c'],
			['a', 'd'],
		];

		it('navigates forward with wrap', () => {
			const { ctrl } = createController(rows);
			ctrl.setQuery('a');
			vi.advanceTimersByTime(200);
			expect(ctrl.matches.length).toBe(3);
			expect(ctrl.currentMatchIndex).toBe(0);
			ctrl.nextMatch();
			expect(ctrl.currentMatchIndex).toBe(1);
			ctrl.nextMatch();
			expect(ctrl.currentMatchIndex).toBe(2);
			ctrl.nextMatch();
			expect(ctrl.currentMatchIndex).toBe(0); // wrap
		});

		it('navigates backward with wrap', () => {
			const { ctrl } = createController(rows);
			ctrl.setQuery('a');
			vi.advanceTimersByTime(200);
			ctrl.prevMatch();
			expect(ctrl.currentMatchIndex).toBe(2); // wraps to last
		});

		it('no-ops when matches is empty', () => {
			const { ctrl, host } = createController(rows);
			(host.requestUpdate as any).mockClear();
			ctrl.nextMatch();
			ctrl.prevMatch();
			// No requestUpdate calls since matches is empty
			expect(host.requestUpdate).not.toHaveBeenCalled();
		});

		it('scrolls and selects cell on navigation', () => {
			const { ctrl, host } = createController(rows);
			ctrl.setQuery('a');
			vi.advanceTimersByTime(200);
			(host.scrollToRow as any).mockClear();
			(host.setSelectedCell as any).mockClear();
			ctrl.nextMatch();
			expect(host.scrollToRow).toHaveBeenCalled();
			expect(host.setSelectedCell).toHaveBeenCalled();
		});
	});

	// ── isMatch / isCurMatch ──────────────────────────────────────────────

	describe('isMatch / isCurMatch', () => {
		it('returns true for matching cells', () => {
			const rows: CellValue[][] = [['a', 'b'], ['a', 'c']];
			const { ctrl } = createController(rows);
			ctrl.setQuery('a');
			vi.advanceTimersByTime(200);
			expect(ctrl.isMatch(0, 0)).toBe(true);
			expect(ctrl.isMatch(1, 0)).toBe(true);
			expect(ctrl.isMatch(0, 1)).toBe(false);
		});

		it('isCurMatch returns true only for the current match', () => {
			const rows: CellValue[][] = [['a', 'b'], ['a', 'c']];
			const { ctrl } = createController(rows);
			ctrl.setQuery('a');
			vi.advanceTimersByTime(200);
			expect(ctrl.isCurMatch(0, 0)).toBe(true);
			expect(ctrl.isCurMatch(1, 0)).toBe(false);
			ctrl.nextMatch();
			expect(ctrl.isCurMatch(0, 0)).toBe(false);
			expect(ctrl.isCurMatch(1, 0)).toBe(true);
		});
	});

	// ── reset ─────────────────────────────────────────────────────────────

	describe('reset', () => {
		it('clears matches and index', () => {
			const rows: CellValue[][] = [['a']];
			const { ctrl } = createController(rows);
			ctrl.setQuery('a');
			vi.advanceTimersByTime(200);
			ctrl.reset();
			expect(ctrl.matches).toEqual([]);
			expect(ctrl.currentMatchIndex).toBe(0);
		});
	});

	// ── searchRegex getter ────────────────────────────────────────────────

	describe('searchRegex', () => {
		it('returns null for empty query', () => {
			const { ctrl } = createController();
			expect(ctrl.searchRegex).toBeNull();
		});

		it('returns a regex for valid query', () => {
			const { ctrl } = createController();
			ctrl.query = 'test';
			expect(ctrl.searchRegex).toBeInstanceOf(RegExp);
		});
	});

	// ── cell with object shape ────────────────────────────────────────────

	describe('object cell values', () => {
		it('searches the full field of object cells', () => {
			const rows: CellValue[][] = [
				[{ display: 'short', full: 'this is the full text to search' }],
			];
			const { ctrl } = createController(rows);
			ctrl.setQuery('full text');
			vi.advanceTimersByTime(200);
			expect(ctrl.matches).toEqual([{ row: 0, col: 0 }]);
		});
	});
});
