import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SelectionHost } from '../../src/webview/components/table-selection.controller.js';
import { TableSelectionController } from '../../src/webview/components/table-selection.controller.js';
import type { CellValue, DataTableColumn } from '../../src/webview/components/kw-data-table.js';

// ── Mock host factory ─────────────────────────────────────────────────────────

function createMockHost(
	columns: DataTableColumn[] = [{ name: 'A' }, { name: 'B' }, { name: 'C' }],
	rows: CellValue[][] = [
		['a1', 'b1', 'c1'],
		['a2', 'b2', 'c2'],
		['a3', 'b3', 'c3'],
	],
): SelectionHost {
	const el = document.createElement('div') as unknown as SelectionHost;
	return Object.assign(el, {
		addController: vi.fn(),
		removeController: vi.fn(),
		requestUpdate: vi.fn(),
		updateComplete: Promise.resolve(true),
		columns,
		getTableRows: () => rows.map(r => ({ original: r })),
		getColumnCount: () => columns.length,
		scrollToRow: vi.fn(),
		scrollColumnIntoView: vi.fn(),
	});
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeKeyEvent(key: string, opts: Partial<KeyboardEvent> = {}): KeyboardEvent {
	return { key, ctrlKey: false, metaKey: false, shiftKey: false, preventDefault: vi.fn(), ...opts } as unknown as KeyboardEvent;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('TableSelectionController', () => {
	let host: SelectionHost;
	let ctrl: TableSelectionController;

	beforeEach(() => {
		host = createMockHost();
		ctrl = new TableSelectionController(host);
	});

	afterEach(() => {
		// Clean up document listeners if hostConnected was called
		ctrl.hostDisconnected();
	});

	// ── clear ─────────────────────────────────────────────────────────────

	describe('clear', () => {
		it('resets selectedCell and selectionRange', () => {
			ctrl.setSelectedCell({ row: 1, col: 1 });
			ctrl.clear();
			expect(ctrl.selectedCell).toBeNull();
			expect(ctrl.selectionRange).toBeNull();
		});
	});

	// ── setSelectedCell ───────────────────────────────────────────────────

	describe('setSelectedCell', () => {
		it('sets the cell and requests update', () => {
			ctrl.setSelectedCell({ row: 2, col: 1 });
			expect(ctrl.selectedCell).toEqual({ row: 2, col: 1 });
			expect(host.requestUpdate).toHaveBeenCalled();
		});

		it('can set to null', () => {
			ctrl.setSelectedCell({ row: 0, col: 0 });
			ctrl.setSelectedCell(null);
			expect(ctrl.selectedCell).toBeNull();
		});
	});

	// ── clearSelectionRange ───────────────────────────────────────────────

	describe('clearSelectionRange', () => {
		it('clears the range but keeps selectedCell', () => {
			ctrl.setSelectedCell({ row: 0, col: 0 });
			ctrl.selectAll();
			ctrl.clearSelectionRange();
			expect(ctrl.selectionRange).toBeNull();
			expect(ctrl.selectedCell).not.toBeNull();
		});
	});

	// ── selectAll ─────────────────────────────────────────────────────────

	describe('selectAll', () => {
		it('selects the full grid', () => {
			ctrl.selectAll();
			expect(ctrl.selectedCell).toEqual({ row: 0, col: 0 });
			expect(ctrl.selectionRange).toEqual({ rowMin: 0, rowMax: 2, colMin: 0, colMax: 2 });
		});

		it('handles single-row table', () => {
			host = createMockHost([{ name: 'X' }], [['val']]);
			ctrl = new TableSelectionController(host);
			ctrl.selectAll();
			expect(ctrl.selectionRange).toEqual({ rowMin: 0, rowMax: 0, colMin: 0, colMax: 0 });
		});
	});

	// ── selectRow ─────────────────────────────────────────────────────────

	describe('selectRow', () => {
		it('selects an entire row', () => {
			const e = { shiftKey: false } as MouseEvent;
			ctrl.selectRow(e, 1);
			expect(ctrl.selectedCell).toEqual({ row: 1, col: 0 });
			expect(ctrl.selectionRange).toEqual({ rowMin: 1, rowMax: 1, colMin: 0, colMax: 2 });
		});

		it('toggles off when clicking the same row again', () => {
			const e = { shiftKey: false } as MouseEvent;
			ctrl.selectRow(e, 1);
			ctrl.selectRow(e, 1);
			expect(ctrl.selectedCell).toBeNull();
			expect(ctrl.selectionRange).toBeNull();
		});

		it('extends selection with shift-click', () => {
			const e1 = { shiftKey: false } as MouseEvent;
			ctrl.selectRow(e1, 0);
			const e2 = { shiftKey: true } as MouseEvent;
			ctrl.selectRow(e2, 2);
			expect(ctrl.selectionRange).toEqual({ rowMin: 0, rowMax: 2, colMin: 0, colMax: 2 });
			expect(ctrl.selectedCell).toEqual({ row: 2, col: 0 });
		});

		it('shift-click without anchor does nothing special', () => {
			// No prior selection → no anchor
			const e = { shiftKey: true } as MouseEvent;
			ctrl.selectRow(e, 1);
			// Since _selectionAnchor is null, shift path is skipped, falls to normal select
			expect(ctrl.selectedCell).toEqual({ row: 1, col: 0 });
		});
	});

	// ── handleKeydown — arrow navigation ──────────────────────────────────

	describe('handleKeydown — arrows', () => {
		beforeEach(() => {
			ctrl.setSelectedCell({ row: 1, col: 1 });
		});

		it('ArrowUp moves up', () => {
			ctrl.handleKeydown(makeKeyEvent('ArrowUp'));
			expect(ctrl.selectedCell).toEqual({ row: 0, col: 1 });
		});

		it('ArrowDown moves down', () => {
			ctrl.handleKeydown(makeKeyEvent('ArrowDown'));
			expect(ctrl.selectedCell).toEqual({ row: 2, col: 1 });
		});

		it('ArrowLeft moves left', () => {
			ctrl.handleKeydown(makeKeyEvent('ArrowLeft'));
			expect(ctrl.selectedCell).toEqual({ row: 1, col: 0 });
		});

		it('ArrowRight moves right', () => {
			ctrl.handleKeydown(makeKeyEvent('ArrowRight'));
			expect(ctrl.selectedCell).toEqual({ row: 1, col: 2 });
		});

		it('clamps at top boundary', () => {
			ctrl.setSelectedCell({ row: 0, col: 0 });
			ctrl.handleKeydown(makeKeyEvent('ArrowUp'));
			expect(ctrl.selectedCell).toEqual({ row: 0, col: 0 });
		});

		it('clamps at bottom boundary', () => {
			ctrl.setSelectedCell({ row: 2, col: 2 });
			ctrl.handleKeydown(makeKeyEvent('ArrowDown'));
			expect(ctrl.selectedCell).toEqual({ row: 2, col: 2 });
		});

		it('clamps at left boundary', () => {
			ctrl.setSelectedCell({ row: 0, col: 0 });
			ctrl.handleKeydown(makeKeyEvent('ArrowLeft'));
			expect(ctrl.selectedCell).toEqual({ row: 0, col: 0 });
		});

		it('clamps at right boundary', () => {
			ctrl.setSelectedCell({ row: 0, col: 2 });
			ctrl.handleKeydown(makeKeyEvent('ArrowRight'));
			expect(ctrl.selectedCell).toEqual({ row: 0, col: 2 });
		});

		it('no-op when no selectedCell', () => {
			ctrl.selectedCell = null;
			ctrl.handleKeydown(makeKeyEvent('ArrowDown'));
			expect(ctrl.selectedCell).toBeNull();
		});
	});

	// ── handleKeydown — Home/End ──────────────────────────────────────────

	describe('handleKeydown — Home/End', () => {
		it('Home goes to first column', () => {
			ctrl.setSelectedCell({ row: 1, col: 2 });
			ctrl.handleKeydown(makeKeyEvent('Home'));
			expect(ctrl.selectedCell).toEqual({ row: 1, col: 0 });
		});

		it('End goes to last column', () => {
			ctrl.setSelectedCell({ row: 1, col: 0 });
			ctrl.handleKeydown(makeKeyEvent('End'));
			expect(ctrl.selectedCell).toEqual({ row: 1, col: 2 });
		});

		it('Ctrl+Home goes to top-left', () => {
			ctrl.setSelectedCell({ row: 2, col: 2 });
			ctrl.handleKeydown(makeKeyEvent('Home', { ctrlKey: true }));
			expect(ctrl.selectedCell).toEqual({ row: 0, col: 0 });
		});

		it('Ctrl+End goes to bottom-right', () => {
			ctrl.setSelectedCell({ row: 0, col: 0 });
			ctrl.handleKeydown(makeKeyEvent('End', { ctrlKey: true }));
			expect(ctrl.selectedCell).toEqual({ row: 2, col: 2 });
		});
	});

	// ── handleKeydown — PageUp/PageDown ───────────────────────────────────

	describe('handleKeydown — PageUp/PageDown', () => {
		it('PageDown jumps 20 rows (clamped)', () => {
			ctrl.setSelectedCell({ row: 0, col: 0 });
			ctrl.handleKeydown(makeKeyEvent('PageDown'));
			expect(ctrl.selectedCell).toEqual({ row: 2, col: 0 }); // clamped to max row
		});

		it('PageUp jumps 20 rows (clamped)', () => {
			ctrl.setSelectedCell({ row: 2, col: 0 });
			ctrl.handleKeydown(makeKeyEvent('PageUp'));
			expect(ctrl.selectedCell).toEqual({ row: 0, col: 0 }); // clamped to 0
		});
	});

	// ── handleKeydown — Shift extends selection ───────────────────────────

	describe('handleKeydown — Shift selection', () => {
		it('Shift+ArrowDown creates selection range', () => {
			ctrl.setSelectedCell({ row: 0, col: 0 });
			ctrl.handleKeydown(makeKeyEvent('ArrowDown', { shiftKey: true }));
			expect(ctrl.selectionRange).toEqual({ rowMin: 0, rowMax: 1, colMin: 0, colMax: 0 });
			expect(ctrl.selectedCell).toEqual({ row: 1, col: 0 });
		});

		it('Shift extends range over multiple steps', () => {
			ctrl.setSelectedCell({ row: 0, col: 0 });
			ctrl.handleKeydown(makeKeyEvent('ArrowDown', { shiftKey: true }));
			ctrl.handleKeydown(makeKeyEvent('ArrowRight', { shiftKey: true }));
			expect(ctrl.selectionRange).toEqual({ rowMin: 0, rowMax: 1, colMin: 0, colMax: 1 });
		});

		it('non-Shift after Shift clears range', () => {
			ctrl.setSelectedCell({ row: 0, col: 0 });
			ctrl.handleKeydown(makeKeyEvent('ArrowDown', { shiftKey: true }));
			expect(ctrl.selectionRange).not.toBeNull();
			ctrl.handleKeydown(makeKeyEvent('ArrowDown'));
			expect(ctrl.selectionRange).toBeNull();
		});
	});

	// ── handleKeydown — Ctrl+A ────────────────────────────────────────────

	describe('handleKeydown — Ctrl+A', () => {
		it('selects all', () => {
			ctrl.handleKeydown(makeKeyEvent('a', { ctrlKey: true }));
			expect(ctrl.selectionRange).toEqual({ rowMin: 0, rowMax: 2, colMin: 0, colMax: 2 });
		});

		it('works even without prior selection', () => {
			ctrl.selectedCell = null;
			ctrl.handleKeydown(makeKeyEvent('a', { ctrlKey: true }));
			expect(ctrl.selectionRange).toEqual({ rowMin: 0, rowMax: 2, colMin: 0, colMax: 2 });
		});
	});

	// ── scrollToRow ───────────────────────────────────────────────────────

	describe('scrollToRow integration', () => {
		it('scrolls when navigating with arrows', () => {
			ctrl.setSelectedCell({ row: 0, col: 0 });
			ctrl.handleKeydown(makeKeyEvent('ArrowDown'));
			expect(host.scrollToRow).toHaveBeenCalledWith(1, { align: 'auto' });
		});
	});

	// ── document keydown integration ──────────────────────────────────────

	describe('document keydown integration', () => {
		it('Ctrl+A inside table host selects all', () => {
			document.body.appendChild(host as unknown as HTMLElement);
			ctrl.hostConnected();

			const child = document.createElement('div');
			child.tabIndex = 0;
			(host as unknown as HTMLElement).appendChild(child);
			child.focus();

			const ev = new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true, cancelable: true });
			child.dispatchEvent(ev);

			expect(ctrl.selectionRange).toEqual({ rowMin: 0, rowMax: 2, colMin: 0, colMax: 2 });
			(host as unknown as HTMLElement).remove();
		});

		it('Ctrl+A inside text input does not hijack native text selection', () => {
			document.body.appendChild(host as unknown as HTMLElement);
			ctrl.hostConnected();

			const inp = document.createElement('input');
			(host as unknown as HTMLElement).appendChild(inp);
			inp.focus();

			const ev = new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true, cancelable: true });
			inp.dispatchEvent(ev);

			expect(ctrl.selectionRange).toBeNull();
			(host as unknown as HTMLElement).remove();
		});
	});

	// ── copy (via buildClipboardText) ─────────────────────────────────────

	describe('copy', () => {
		let writeSpy: ReturnType<typeof vi.fn>;

		beforeEach(() => {
			writeSpy = vi.fn(() => Promise.resolve());
			Object.defineProperty(navigator, 'clipboard', {
				value: { writeText: writeSpy },
				configurable: true,
			});
		});

		it('copies single cell value', () => {
			ctrl.setSelectedCell({ row: 0, col: 1 });
			ctrl.copy();
			expect(writeSpy).toHaveBeenCalledWith('b1');
		});

		it('copies selection range with headers', () => {
			ctrl.setSelectedCell({ row: 0, col: 0 });
			ctrl.selectionRange = { rowMin: 0, rowMax: 1, colMin: 0, colMax: 1 };
			ctrl.copy();
			expect(writeSpy).toHaveBeenCalledWith('A\tB\na1\tb1\na2\tb2');
		});

		it('copies all rows when nothing is specifically selected', () => {
			ctrl.selectedCell = null;
			ctrl.selectionRange = null;
			ctrl.copy();
			// buildClipboardText with no selection falls through to copy-all
			expect(writeSpy).toHaveBeenCalled();
		});
	});

	// ── cross-table coordination ──────────────────────────────────────────

	describe('cross-table coordination', () => {
		let hostA: SelectionHost;
		let hostB: SelectionHost;
		let ctrlA: TableSelectionController;
		let ctrlB: TableSelectionController;

		beforeEach(() => {
			// Reset static state that may leak from a prior test.
			(TableSelectionController as any)._activeInstance = null;

			hostA = createMockHost();
			hostB = createMockHost(
				[{ name: 'X' }, { name: 'Y' }],
				[['x1', 'y1'], ['x2', 'y2']],
			);
			ctrlA = new TableSelectionController(hostA);
			ctrlB = new TableSelectionController(hostB);
		});

		afterEach(() => {
			ctrlA.hostDisconnected();
			ctrlB.hostDisconnected();
		});

		it('clicking in table B clears table A selection', () => {
			// Simulate mousedown on table A (no cell resolved — just activate).
			ctrlA.setSelectedCell({ row: 0, col: 0 });
			(ctrlA as any)._becomeActive();

			expect(ctrlA.selectedCell).toEqual({ row: 0, col: 0 });

			// Now activate table B.
			(ctrlB as any)._becomeActive();

			expect(ctrlA.selectedCell).toBeNull();
			expect(ctrlA.selectionRange).toBeNull();
		});

		it('isSelectionInThisTable returns true only for the active table', () => {
			ctrlA.setSelectedCell({ row: 0, col: 0 });
			(ctrlA as any)._becomeActive();

			ctrlB.setSelectedCell({ row: 0, col: 0 });
			(ctrlB as any)._becomeActive();

			expect(ctrlB.isSelectionInThisTable()).toBe(true);
			// ctrlA's selection was cleared by _becomeActive, so the
			// early null-check short-circuits.
			expect(ctrlA.isSelectionInThisTable()).toBe(false);
		});

		it('selectRow activates the table and clears the other', () => {
			ctrlA.setSelectedCell({ row: 1, col: 1 });
			(ctrlA as any)._becomeActive();

			const e = { shiftKey: false } as MouseEvent;
			ctrlB.selectRow(e, 0);

			expect(ctrlA.selectedCell).toBeNull();
			expect(ctrlB.selectedCell).toEqual({ row: 0, col: 0 });
			expect(ctrlB.isSelectionInThisTable()).toBe(true);
		});

		it('selectAll activates the table and clears the other', () => {
			ctrlA.setSelectedCell({ row: 0, col: 0 });
			(ctrlA as any)._becomeActive();

			ctrlB.selectAll();

			expect(ctrlA.selectedCell).toBeNull();
			expect(ctrlB.selectionRange).toEqual({ rowMin: 0, rowMax: 1, colMin: 0, colMax: 1 });
			expect(ctrlB.isSelectionInThisTable()).toBe(true);
		});

		it('hostDisconnected clears active instance when it is the active one', () => {
			(ctrlA as any)._becomeActive();
			expect((TableSelectionController as any)._activeInstance).toBe(ctrlA);

			ctrlA.hostDisconnected();
			expect((TableSelectionController as any)._activeInstance).toBeNull();
		});

		it('hostDisconnected does not clear active instance for a different table', () => {
			(ctrlB as any)._becomeActive();
			ctrlA.hostDisconnected();
			expect((TableSelectionController as any)._activeInstance).toBe(ctrlB);
		});

		it('activating the same table twice is a no-op for the other table', () => {
			ctrlA.setSelectedCell({ row: 0, col: 0 });
			(ctrlA as any)._becomeActive();
			// Activate A again — should NOT clear A.
			(ctrlA as any)._becomeActive();
			expect(ctrlA.selectedCell).toEqual({ row: 0, col: 0 });
		});

		it('isSelectionInThisTable returns false when focus is outside all tables', () => {
			// Simulate: select rows in table B, then focus a title input outside any table.
			ctrlB.setSelectedCell({ row: 0, col: 0 });
			ctrlB.selectionRange = { rowMin: 0, rowMax: 1, colMin: 0, colMax: 1 };
			(ctrlB as any)._becomeActive();

			// Focus an element outside any table host (e.g. a section title input).
			const outsideInput = document.createElement('input');
			document.body.appendChild(outsideInput);
			outsideInput.focus();

			expect(ctrlB.isSelectionInThisTable()).toBe(false);
			expect(ctrlA.isSelectionInThisTable()).toBe(false);

			outsideInput.remove();
		});
	});
});
