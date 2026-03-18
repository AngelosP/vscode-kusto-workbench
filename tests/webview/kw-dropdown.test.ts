import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { html, render, nothing } from 'lit';
import type { DropdownItem, DropdownAction } from '../../src/webview/components/kw-dropdown.js';
import '../../src/webview/components/kw-dropdown.js';
import type { KwDropdown } from '../../src/webview/components/kw-dropdown.js';

// ── Test helpers ──────────────────────────────────────────────────────────────

let container: HTMLDivElement;

function createDropdown(attrs: {
	items?: DropdownItem[];
	actions?: DropdownAction[];
	selectedId?: string;
	placeholder?: string;
	disabled?: boolean;
	loading?: boolean;
	loadingText?: string;
	showDelete?: boolean;
	emptyText?: string;
} = {}): KwDropdown {
	const {
		items = [],
		actions = [],
		selectedId = '',
		placeholder = 'Select...',
		disabled = false,
		loading = false,
		loadingText = 'Loading...',
		showDelete = false,
		emptyText = 'No items available',
	} = attrs;

	render(html`
		<kw-dropdown
			.items=${items}
			.actions=${actions}
			.selectedId=${selectedId}
			.placeholder=${placeholder}
			?disabled=${disabled}
			?loading=${loading}
			.loadingText=${loadingText}
			?showDelete=${showDelete}
			.emptyText=${emptyText}
		></kw-dropdown>
	`, container);

	return container.querySelector('kw-dropdown')!;
}

function getButton(el: KwDropdown): HTMLButtonElement {
	return el.shadowRoot!.querySelector('.kusto-dropdown-btn')! as HTMLButtonElement;
}

function getMenu(el: KwDropdown): HTMLElement | null {
	return el.shadowRoot!.querySelector('.kusto-dropdown-menu');
}

function getItems(el: KwDropdown): HTMLElement[] {
	return Array.from(el.shadowRoot!.querySelectorAll('.kusto-dropdown-item'));
}

function getActions(el: KwDropdown): HTMLElement[] {
	return Array.from(el.shadowRoot!.querySelectorAll('.kusto-dropdown-action'));
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

// ── Tests ─────────────────────────────────────────────────────────────────────

const sampleItems: DropdownItem[] = [
	{ id: 'a', label: 'Alpha' },
	{ id: 'b', label: 'Beta' },
	{ id: 'c', label: 'Charlie' },
];

describe('kw-dropdown', () => {

	it('renders button with placeholder when no selectedId', async () => {
		const el = createDropdown({ items: sampleItems });
		await el.updateComplete;

		const btn = getButton(el);
		const text = btn.querySelector('.kusto-dropdown-btn-text')!;
		expect(text.textContent?.trim()).toBe('Select...');
	});

	it('renders button with selected item label', async () => {
		const el = createDropdown({ items: sampleItems, selectedId: 'b' });
		await el.updateComplete;

		const btn = getButton(el);
		const text = btn.querySelector('.kusto-dropdown-btn-text')!;
		expect(text.textContent?.trim()).toBe('Beta');
	});

	it('renders loading text when loading=true', async () => {
		const el = createDropdown({ items: sampleItems, loading: true, loadingText: 'Fetching...' });
		await el.updateComplete;

		const btn = getButton(el);
		const text = btn.querySelector('.kusto-dropdown-btn-text')!;
		expect(text.textContent?.trim()).toBe('Fetching...');
	});

	it('button disabled when disabled=true', async () => {
		const el = createDropdown({ items: sampleItems, disabled: true });
		await el.updateComplete;

		const btn = getButton(el);
		expect(btn.disabled).toBe(true);
	});

	it('button disabled when loading=true', async () => {
		const el = createDropdown({ items: sampleItems, loading: true });
		await el.updateComplete;

		const btn = getButton(el);
		expect(btn.disabled).toBe(true);
	});

	it('click button opens menu, click again closes', async () => {
		const el = createDropdown({ items: sampleItems });
		await el.updateComplete;

		const btn = getButton(el);
		expect(getMenu(el)).toBeNull();

		btn.click();
		await el.updateComplete;
		expect(getMenu(el)).not.toBeNull();

		btn.click();
		await el.updateComplete;
		expect(getMenu(el)).toBeNull();
	});

	it('items rendered in menu with correct labels', async () => {
		const el = createDropdown({ items: sampleItems });
		await el.updateComplete;

		getButton(el).click();
		await el.updateComplete;

		const items = getItems(el);
		expect(items).toHaveLength(3);
		expect(items[0].textContent).toContain('Alpha');
		expect(items[1].textContent).toContain('Beta');
		expect(items[2].textContent).toContain('Charlie');
	});

	it('actions rendered at top of menu by default', async () => {
		const el = createDropdown({
			items: sampleItems,
			actions: [{ id: 'new', label: 'Add new…' }],
		});
		await el.updateComplete;

		getButton(el).click();
		await el.updateComplete;

		const actions = getActions(el);
		expect(actions).toHaveLength(1);
		expect(actions[0].textContent?.trim()).toBe('Add new…');

		// Action should be before items in DOM
		const menu = getMenu(el)!;
		const firstChild = menu.children[0] as HTMLElement;
		expect(firstChild.classList.contains('kusto-dropdown-action')).toBe(true);
	});

	it('actions with position=bottom rendered after items', async () => {
		const el = createDropdown({
			items: sampleItems,
			actions: [{ id: 'other', label: 'Other...', position: 'bottom' }],
		});
		await el.updateComplete;

		getButton(el).click();
		await el.updateComplete;

		const menu = getMenu(el)!;
		const lastChild = menu.children[menu.children.length - 1] as HTMLElement;
		expect(lastChild.classList.contains('kusto-dropdown-action')).toBe(true);
		expect(lastChild.textContent?.trim()).toBe('Other...');
	});

	it('clicking item fires dropdown-select with correct detail', async () => {
		const el = createDropdown({ items: sampleItems });
		await el.updateComplete;

		let receivedDetail: any = null;
		el.addEventListener('dropdown-select', ((e: CustomEvent) => {
			receivedDetail = e.detail;
		}) as EventListener);

		getButton(el).click();
		await el.updateComplete;

		const items = getItems(el);
		items[1].click(); // Beta
		await el.updateComplete;

		expect(receivedDetail).not.toBeNull();
		expect(receivedDetail.id).toBe('b');
		expect(receivedDetail.item.label).toBe('Beta');
	});

	it('clicking action fires dropdown-action with correct detail', async () => {
		const el = createDropdown({
			items: sampleItems,
			actions: [{ id: 'new', label: 'Add new…' }],
		});
		await el.updateComplete;

		let receivedDetail: any = null;
		el.addEventListener('dropdown-action', ((e: CustomEvent) => {
			receivedDetail = e.detail;
		}) as EventListener);

		getButton(el).click();
		await el.updateComplete;

		const actions = getActions(el);
		actions[0].click();
		await el.updateComplete;

		expect(receivedDetail).not.toBeNull();
		expect(receivedDetail.id).toBe('new');
	});

	it('showDelete shows trash button; clicking it fires dropdown-item-delete (not dropdown-select)', async () => {
		const el = createDropdown({ items: sampleItems, showDelete: true });
		await el.updateComplete;

		let selectFired = false;
		let deleteDetail: any = null;
		el.addEventListener('dropdown-select', (() => { selectFired = true; }) as EventListener);
		el.addEventListener('dropdown-item-delete', ((e: CustomEvent) => {
			deleteDetail = e.detail;
		}) as EventListener);

		getButton(el).click();
		await el.updateComplete;

		const items = getItems(el);
		const trashBtn = items[0].querySelector('.kusto-dropdown-trash') as HTMLElement;
		expect(trashBtn).not.toBeNull();

		trashBtn.click();
		await el.updateComplete;

		expect(selectFired).toBe(false);
		expect(deleteDetail).not.toBeNull();
		expect(deleteDetail.id).toBe('a');
		expect(deleteDetail.item.label).toBe('Alpha');
	});

	it('Escape key closes menu', async () => {
		const el = createDropdown({ items: sampleItems });
		await el.updateComplete;

		getButton(el).click();
		await el.updateComplete;
		expect(getMenu(el)).not.toBeNull();

		// Dispatch Escape at document level (same as the component listens)
		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		await el.updateComplete;

		expect(getMenu(el)).toBeNull();
	});

	it('menu closes on item selection', async () => {
		const el = createDropdown({ items: sampleItems });
		await el.updateComplete;

		getButton(el).click();
		await el.updateComplete;
		expect(getMenu(el)).not.toBeNull();

		getItems(el)[0].click();
		await el.updateComplete;

		expect(getMenu(el)).toBeNull();
	});

	it('empty items shows empty state message', async () => {
		const el = createDropdown({ items: [], emptyText: 'Nothing here' });
		await el.updateComplete;

		getButton(el).click();
		await el.updateComplete;

		const empty = el.shadowRoot!.querySelector('.kusto-dropdown-empty');
		expect(empty).not.toBeNull();
		expect(empty!.textContent?.trim()).toBe('Nothing here');
	});

	it('selected item has is-selected class', async () => {
		const el = createDropdown({ items: sampleItems, selectedId: 'b' });
		await el.updateComplete;

		getButton(el).click();
		await el.updateComplete;

		const items = getItems(el);
		expect(items[0].classList.contains('is-selected')).toBe(false);
		expect(items[1].classList.contains('is-selected')).toBe(true);
		expect(items[2].classList.contains('is-selected')).toBe(false);
	});

	it('disabled items are not selectable', async () => {
		const disabledItems: DropdownItem[] = [
			{ id: 'a', label: 'Alpha', disabled: true },
			{ id: 'b', label: 'Beta' },
		];
		const el = createDropdown({ items: disabledItems });
		await el.updateComplete;

		let selectFired = false;
		el.addEventListener('dropdown-select', (() => { selectFired = true; }) as EventListener);

		getButton(el).click();
		await el.updateComplete;

		const items = getItems(el);
		expect(items[0].classList.contains('is-disabled')).toBe(true);

		items[0].click();
		await el.updateComplete;

		expect(selectFired).toBe(false);
	});

	it('renders item with secondary text', async () => {
		const itemsWithSecondary: DropdownItem[] = [
			{ id: 'a', label: 'Cluster A', secondary: '(prod)' },
		];
		const el = createDropdown({ items: itemsWithSecondary });
		await el.updateComplete;

		getButton(el).click();
		await el.updateComplete;

		const items = getItems(el);
		const primary = items[0].querySelector('.kusto-dropdown-primary');
		const secondary = items[0].querySelector('.kusto-dropdown-secondary');
		expect(primary?.textContent?.trim()).toBe('Cluster A');
		expect(secondary?.textContent?.trim()).toBe('(prod)');
	});

	it('close() method closes menu imperatively', async () => {
		const el = createDropdown({ items: sampleItems });
		await el.updateComplete;

		getButton(el).click();
		await el.updateComplete;
		expect(getMenu(el)).not.toBeNull();

		el.close();
		await el.updateComplete;
		expect(getMenu(el)).toBeNull();
	});

	it('dispatches dropdown-opened event when menu opens', async () => {
		const el = createDropdown({ items: sampleItems });
		await el.updateComplete;

		let opened = false;
		el.addEventListener('dropdown-opened', () => { opened = true; });

		getButton(el).click();
		await el.updateComplete;

		expect(opened).toBe(true);
	});

	it('does not open when disabled', async () => {
		const el = createDropdown({ items: sampleItems, disabled: true });
		await el.updateComplete;

		getButton(el).click();
		await el.updateComplete;

		expect(getMenu(el)).toBeNull();
	});

	it('ARIA attributes on button and menu', async () => {
		const el = createDropdown({ items: sampleItems, selectedId: 'a' });
		await el.updateComplete;

		const btn = getButton(el);
		expect(btn.getAttribute('aria-haspopup')).toBe('listbox');
		expect(btn.getAttribute('aria-expanded')).toBe('false');

		btn.click();
		await el.updateComplete;

		expect(btn.getAttribute('aria-expanded')).toBe('true');
		const menu = getMenu(el)!;
		expect(menu.getAttribute('role')).toBe('listbox');

		const items = getItems(el);
		expect(items[0].getAttribute('role')).toBe('option');
		expect(items[0].getAttribute('aria-selected')).toBe('true');
		expect(items[1].getAttribute('aria-selected')).toBe('false');
	});

	it('ArrowDown key navigates to next item', async () => {
		const el = createDropdown({ items: sampleItems });
		await el.updateComplete;

		getButton(el).click();
		await el.updateComplete;

		// Dispatch ArrowDown on the menu
		const menu = getMenu(el)!;
		menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
		await el.updateComplete;

		// Second item should be focused
		const items = getItems(el);
		expect(items[1].classList.contains('is-focused')).toBe(true);
	});

	it('ArrowUp key navigates to previous item', async () => {
		const el = createDropdown({ items: sampleItems });
		await el.updateComplete;

		getButton(el).click();
		await el.updateComplete;

		const menu = getMenu(el)!;
		// Start at first, go up → wraps to last
		menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
		await el.updateComplete;

		const items = getItems(el);
		expect(items[items.length - 1].classList.contains('is-focused')).toBe(true);
	});

	it('ArrowDown wraps from last to first', async () => {
		const el = createDropdown({ items: sampleItems });
		await el.updateComplete;

		getButton(el).click();
		await el.updateComplete;

		const menu = getMenu(el)!;
		// Navigate to end
		menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
		await el.updateComplete;
		// Then ArrowDown should wrap
		menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
		await el.updateComplete;

		const items = getItems(el);
		expect(items[0].classList.contains('is-focused')).toBe(true);
	});

	it('Home key moves focus to first item', async () => {
		const el = createDropdown({ items: sampleItems });
		await el.updateComplete;

		getButton(el).click();
		await el.updateComplete;

		const menu = getMenu(el)!;
		// Navigate away from first
		menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
		menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
		await el.updateComplete;
		// Now press Home
		menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
		await el.updateComplete;

		const items = getItems(el);
		expect(items[0].classList.contains('is-focused')).toBe(true);
	});

	it('End key moves focus to last item', async () => {
		const el = createDropdown({ items: sampleItems });
		await el.updateComplete;

		getButton(el).click();
		await el.updateComplete;

		const menu = getMenu(el)!;
		menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
		await el.updateComplete;

		const items = getItems(el);
		expect(items[items.length - 1].classList.contains('is-focused')).toBe(true);
	});

	it('Enter key selects focused item', async () => {
		const el = createDropdown({ items: sampleItems });
		await el.updateComplete;

		let receivedDetail: any = null;
		el.addEventListener('dropdown-select', ((e: CustomEvent) => {
			receivedDetail = e.detail;
		}) as EventListener);

		getButton(el).click();
		await el.updateComplete;

		const menu = getMenu(el)!;
		// First is focused by default; Move to Beta
		menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
		await el.updateComplete;
		// Press Enter
		menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		await el.updateComplete;

		expect(receivedDetail).not.toBeNull();
		expect(receivedDetail.id).toBe('b');
	});

	it('Space key selects focused item', async () => {
		const el = createDropdown({ items: sampleItems });
		await el.updateComplete;

		let receivedDetail: any = null;
		el.addEventListener('dropdown-select', ((e: CustomEvent) => {
			receivedDetail = e.detail;
		}) as EventListener);

		getButton(el).click();
		await el.updateComplete;

		const menu = getMenu(el)!;
		menu.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
		await el.updateComplete;

		expect(receivedDetail).not.toBeNull();
		expect(receivedDetail.id).toBe('a'); // First item focused by default
	});

	it('selecting via Enter closes the menu', async () => {
		const el = createDropdown({ items: sampleItems });
		await el.updateComplete;

		getButton(el).click();
		await el.updateComplete;
		expect(getMenu(el)).not.toBeNull();

		const menu = getMenu(el)!;
		menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		await el.updateComplete;

		expect(getMenu(el)).toBeNull();
	});

	it('Enter key on focused action fires dropdown-action', async () => {
		const el = createDropdown({
			items: [],
			actions: [{ id: 'new', label: 'Add new' }],
		});
		await el.updateComplete;

		let actionDetail: any = null;
		el.addEventListener('dropdown-action', ((e: CustomEvent) => {
			actionDetail = e.detail;
		}) as EventListener);

		getButton(el).click();
		await el.updateComplete;

		const menu = getMenu(el)!;
		// First and only entry is the action
		menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		await el.updateComplete;

		expect(actionDetail).not.toBeNull();
		expect(actionDetail.id).toBe('new');
	});

	it('ArrowDown on button opens menu', async () => {
		const el = createDropdown({ items: sampleItems });
		await el.updateComplete;

		const btn = getButton(el);
		expect(getMenu(el)).toBeNull();

		btn.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
		await el.updateComplete;

		expect(getMenu(el)).not.toBeNull();
	});

	it('ArrowUp on button opens menu', async () => {
		const el = createDropdown({ items: sampleItems });
		await el.updateComplete;

		const btn = getButton(el);
		btn.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
		await el.updateComplete;

		expect(getMenu(el)).not.toBeNull();
	});

	it('keyboard navigation skips disabled items', async () => {
		const disabledItems: DropdownItem[] = [
			{ id: 'a', label: 'Alpha', disabled: true },
			{ id: 'b', label: 'Beta' },
			{ id: 'c', label: 'Charlie' },
		];
		const el = createDropdown({ items: disabledItems });
		await el.updateComplete;

		getButton(el).click();
		await el.updateComplete;

		// Only non-disabled items are in the entries list
		// So first focusable is Beta (b), second is Charlie (c)
		const menu = getMenu(el)!;
		menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
		await el.updateComplete;

		let receivedDetail: any = null;
		el.addEventListener('dropdown-select', ((e: CustomEvent) => {
			receivedDetail = e.detail;
		}) as EventListener);
		menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		await el.updateComplete;

		// The second non-disabled item should be selected
		expect(receivedDetail.id).toBe('c');
	});

	it('mouseenter on item sets focus', async () => {
		const el = createDropdown({ items: sampleItems });
		await el.updateComplete;

		getButton(el).click();
		await el.updateComplete;

		const items = getItems(el);
		items[2].dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
		await el.updateComplete;

		expect(items[2].classList.contains('is-focused')).toBe(true);
	});

	it('initially focuses selected item when menu opens', async () => {
		const el = createDropdown({ items: sampleItems, selectedId: 'c' });
		await el.updateComplete;

		getButton(el).click();
		await el.updateComplete;

		const items = getItems(el);
		expect(items[2].classList.contains('is-focused')).toBe(true);
	});

	it('renders icon in button when buttonIcon is set', async () => {
		render(html`
			<kw-dropdown
				.items=${sampleItems}
				.buttonIcon=${'<svg></svg>'}
			></kw-dropdown>
		`, container);
		const el = container.querySelector('kw-dropdown')! as KwDropdown;
		await el.updateComplete;

		expect(el.hasAttribute('has-icon')).toBe(true);
	});
});
