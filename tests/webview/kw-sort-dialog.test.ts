import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { html, render, nothing } from 'lit';
import '../../src/webview/components/kw-sort-dialog.js';
import type { KwSortDialog } from '../../src/webview/components/kw-sort-dialog.js';
import type { SortingState } from '@tanstack/table-core';

// ── Helpers ───────────────────────────────────────────────────────────────────

let container: HTMLDivElement;

const testColumns = [
	{ name: 'Timestamp' },
	{ name: 'Count' },
	{ name: 'Category' },
	{ name: 'Value' },
];

function createSortDialog(
	columns = testColumns,
	sorting: SortingState = [],
): KwSortDialog {
	render(html`
		<kw-sort-dialog
			.columns=${columns}
			.sorting=${sorting}
		></kw-sort-dialog>
	`, container);
	return container.querySelector('kw-sort-dialog')!;
}

// ── Setup/teardown ────────────────────────────────────────────────────────────

beforeEach(() => {
	container = document.createElement('div');
	document.body.appendChild(container);
});

afterEach(() => {
	render(nothing, container);
	container.remove();
});

// ── Rendering ─────────────────────────────────────────────────────────────────

describe('kw-sort-dialog — rendering', () => {

	it('renders without errors', async () => {
		const el = createSortDialog();
		await el.updateComplete;
		expect(el).toBeTruthy();
		expect(el.shadowRoot).toBeTruthy();
	});

	it('shows "No sort applied" when sorting is empty', async () => {
		const el = createSortDialog(testColumns, []);
		await el.updateComplete;
		const emptyMsg = el.shadowRoot!.querySelector('.sd-e');
		expect(emptyMsg).toBeTruthy();
		expect(emptyMsg!.textContent).toContain('No sort applied');
	});

	it('renders existing sort rules', async () => {
		const sorting: SortingState = [
			{ id: '0', desc: false },
			{ id: '2', desc: true },
		];
		const el = createSortDialog(testColumns, sorting);
		await el.updateComplete;
		await el.updateComplete; // firstUpdated triggers a second render
		const rules = el.shadowRoot!.querySelectorAll('.sr');
		expect(rules.length).toBe(2);
	});

	it('shows column names in rule selects', async () => {
		const sorting: SortingState = [{ id: '1', desc: false }];
		const el = createSortDialog(testColumns, sorting);
		await el.updateComplete;
		await el.updateComplete;
		const select = el.shadowRoot!.querySelector('.sr .sr-col') as HTMLSelectElement;
		expect(select).toBeTruthy();
		const options = Array.from(select.querySelectorAll('option'));
		expect(options.map(o => o.textContent)).toEqual(['Timestamp', 'Count', 'Category', 'Value']);
	});

	it('shows unused columns in the "Add sort" dropdown', async () => {
		const sorting: SortingState = [{ id: '0', desc: false }];
		const el = createSortDialog(testColumns, sorting);
		await el.updateComplete;
		await el.updateComplete;
		const addCol = el.shadowRoot!.querySelector('#sr-add-col') as HTMLSelectElement;
		expect(addCol).toBeTruthy();
		const options = Array.from(addCol.querySelectorAll('option')).map(o => o.textContent);
		// Column 0 (Timestamp) is used, so not in add dropdown
		expect(options).toContain('Count');
		expect(options).toContain('Category');
		expect(options).toContain('Value');
		expect(options).not.toContain('Timestamp');
	});
});

// ── Events ────────────────────────────────────────────────────────────────────

describe('kw-sort-dialog — events', () => {

	it('dispatches sort-close on backdrop click', async () => {
		const el = createSortDialog();
		await el.updateComplete;

		let closed = false;
		el.addEventListener('sort-close', () => { closed = true; });

		const backdrop = el.shadowRoot!.querySelector('.sd-bg') as HTMLElement;
		backdrop.click();
		expect(closed).toBe(true);
	});

	it('dispatches sort-close on close button click', async () => {
		const el = createSortDialog();
		await el.updateComplete;

		let closed = false;
		el.addEventListener('sort-close', () => { closed = true; });

		const closeBtn = el.shadowRoot!.querySelector('.sd-x') as HTMLButtonElement;
		closeBtn.click();
		expect(closed).toBe(true);
	});

	it('dispatches sort-change with empty sorting on Remove Sort', async () => {
		const sorting: SortingState = [{ id: '0', desc: false }];
		const el = createSortDialog(testColumns, sorting);
		await el.updateComplete;

		let detail: any = null;
		el.addEventListener('sort-change', ((e: CustomEvent) => {
			detail = e.detail;
		}) as EventListener);

		const clearBtn = el.shadowRoot!.querySelector('.sd-btn-danger') as HTMLButtonElement;
		clearBtn.click();
		expect(detail).toEqual({ sorting: [] });
	});

	it('dispatches sort-change with current draft on Apply', async () => {
		const sorting: SortingState = [{ id: '1', desc: true }];
		const el = createSortDialog(testColumns, sorting);
		await el.updateComplete;

		let detail: any = null;
		el.addEventListener('sort-change', ((e: CustomEvent) => {
			detail = e.detail;
		}) as EventListener);

		const applyBtn = el.shadowRoot!.querySelector('.sd-btn:not(.sd-btn-danger)') as HTMLButtonElement;
		applyBtn.click();
		expect(detail).toBeTruthy();
		expect(detail.sorting).toEqual([{ id: '1', desc: true }]);
	});
});

// ── Draft manipulation ────────────────────────────────────────────────────────

describe('kw-sort-dialog — draft manipulation', () => {

	it('remove button removes the rule from draft', async () => {
		const sorting: SortingState = [
			{ id: '0', desc: false },
			{ id: '1', desc: true },
		];
		const el = createSortDialog(testColumns, sorting);
		await el.updateComplete;
		await el.updateComplete;

		// Remove the first rule.
		const rmBtns = el.shadowRoot!.querySelectorAll('.sr-rm');
		expect(rmBtns.length).toBe(2);
		(rmBtns[0] as HTMLButtonElement).click();
		await el.updateComplete;

		// Should now have 1 rule.
		const rules = el.shadowRoot!.querySelectorAll('.sr');
		expect(rules.length).toBe(1);

		// Apply and verify.
		let detail: any = null;
		el.addEventListener('sort-change', ((e: CustomEvent) => {
			detail = e.detail;
		}) as EventListener);

		const applyBtn = el.shadowRoot!.querySelector('.sd-btn:not(.sd-btn-danger)') as HTMLButtonElement;
		applyBtn.click();
		expect(detail.sorting).toEqual([{ id: '1', desc: true }]);
	});

	it('syncs draft when sorting property changes externally', async () => {
		const el = createSortDialog(testColumns, []);
		await el.updateComplete;
		await el.updateComplete;

		// Initially empty.
		expect(el.shadowRoot!.querySelectorAll('.sr').length).toBe(0);

		// Update sorting externally.
		el.sorting = [{ id: '2', desc: false }];
		await el.updateComplete;
		await el.updateComplete;

		// Draft should sync.
		expect(el.shadowRoot!.querySelectorAll('.sr').length).toBe(1);
	});

	it('add inline adds a new rule via the selects', async () => {
		const el = createSortDialog(testColumns, []);
		await el.updateComplete;
		await el.updateComplete;

		// Select a column in the "Add sort" row.
		const addCol = el.shadowRoot!.querySelector('#sr-add-col') as HTMLSelectElement;
		const addDir = el.shadowRoot!.querySelector('#sr-add-dir') as HTMLSelectElement;
		addCol.value = '2'; // Category
		addDir.value = 'desc';

		// Click the + button.
		const addBtn = el.shadowRoot!.querySelector('.sr-add-btn') as HTMLButtonElement;
		addBtn.click();
		await el.updateComplete;

		// Should now have 1 rule.
		expect(el.shadowRoot!.querySelectorAll('.sr').length).toBe(1);
	});

	it('Apply auto-adds pending inline selection', async () => {
		const el = createSortDialog(testColumns, []);
		await el.updateComplete;
		await el.updateComplete;

		// Set up a pending inline selection.
		const addCol = el.shadowRoot!.querySelector('#sr-add-col') as HTMLSelectElement;
		const addDir = el.shadowRoot!.querySelector('#sr-add-dir') as HTMLSelectElement;
		addCol.value = '3'; // Value
		addDir.value = 'asc';

		// Click Apply — should auto-add the pending selection.
		let detail: any = null;
		el.addEventListener('sort-change', ((e: CustomEvent) => {
			detail = e.detail;
		}) as EventListener);

		const applyBtn = el.shadowRoot!.querySelector('.sd-btn:not(.sd-btn-danger)') as HTMLButtonElement;
		applyBtn.click();

		expect(detail).toBeTruthy();
		expect(detail.sorting.length).toBe(1);
		expect(detail.sorting[0].id).toBe('3');
		expect(detail.sorting[0].desc).toBe(false);
	});
});
