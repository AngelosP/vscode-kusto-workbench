import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { html, render, nothing } from 'lit';
import '../../src/webview/components/kw-section-shell.js';
import type { KwSectionShell } from '../../src/webview/components/kw-section-shell.js';
import type { SectionType } from '../../src/webview/shared/icon-registry.js';

// ── Test helpers ──────────────────────────────────────────────────────────────

let container: HTMLDivElement;

function createShell(attrs: Partial<{
	name: string;
	expanded: boolean;
	boxId: string;
	namePlaceholder: string;
	sectionType: SectionType | '';
}> = {}, slots?: {
	headerButtons?: ReturnType<typeof html>;
	headerExtra?: ReturnType<typeof html>;
	body?: ReturnType<typeof html>;
}): KwSectionShell {
	const {
		name = '',
		expanded = true,
		boxId = 'test-box-1',
		namePlaceholder = 'Section name',
		sectionType = '',
	} = attrs;

	render(html`
		<kw-section-shell
			.name=${name}
			.expanded=${expanded}
			box-id=${boxId}
			name-placeholder=${namePlaceholder}
			section-type=${sectionType || nothing}>
			${slots?.headerButtons ?? nothing}
			${slots?.headerExtra ?? nothing}
			${slots?.body ?? html`<div class="test-body">Body content</div>`}
		</kw-section-shell>
	`, container);

	return container.querySelector('kw-section-shell')!;
}

function getNameInput(el: KwSectionShell): HTMLInputElement {
	return el.shadowRoot!.querySelector('.query-name')!;
}

function getDragHandle(el: KwSectionShell): HTMLButtonElement {
	return el.shadowRoot!.querySelector('.section-drag-handle')!;
}

function getToggleButton(el: KwSectionShell): HTMLButtonElement {
	return el.shadowRoot!.querySelector('.toggle-btn')!;
}

function getFitButton(el: KwSectionShell): HTMLButtonElement {
	return el.shadowRoot!.querySelector('.md-max-btn')!;
}

function getCloseButton(el: KwSectionShell): HTMLButtonElement {
	return el.shadowRoot!.querySelector('.close-btn')!;
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

describe('kw-section-shell', () => {
	it('renders drag handle, name input, toggle, and close buttons', async () => {
		const el = createShell();
		await el.updateComplete;

		expect(getDragHandle(el)).toBeTruthy();
		expect(getNameInput(el)).toBeTruthy();
		expect(getToggleButton(el)).toBeTruthy();
		expect(getCloseButton(el)).toBeTruthy();
		expect(getFitButton(el)).toBeTruthy();
	});

	it('name input shows the name property value', async () => {
		const el = createShell({ name: 'My Section' });
		await el.updateComplete;

		expect(getNameInput(el).value).toBe('My Section');
	});

	it('name input shows custom placeholder', async () => {
		const el = createShell({ namePlaceholder: 'Custom placeholder' });
		await el.updateComplete;

		expect(getNameInput(el).placeholder).toBe('Custom placeholder');
	});

	it('name input dispatches name-change with typed text', async () => {
		const el = createShell();
		await el.updateComplete;

		const events: string[] = [];
		el.addEventListener('name-change', (e) => {
			events.push((e as CustomEvent).detail.name);
		});

		const input = getNameInput(el);
		input.value = 'New Name';
		input.dispatchEvent(new Event('input', { bubbles: true }));

		expect(events).toEqual(['New Name']);
	});

	it('close button dispatches section-remove with boxId', async () => {
		const el = createShell({ boxId: 'python_123' });
		await el.updateComplete;

		const events: string[] = [];
		el.addEventListener('section-remove', (e) => {
			events.push((e as CustomEvent).detail.boxId);
		});

		getCloseButton(el).click();
		expect(events).toEqual(['python_123']);
	});

	it('toggle button dispatches toggle-visibility', async () => {
		const el = createShell();
		await el.updateComplete;

		let fired = false;
		el.addEventListener('toggle-visibility', () => { fired = true; });

		getToggleButton(el).click();
		expect(fired).toBe(true);
	});

	it('fit button dispatches fit-to-contents', async () => {
		const el = createShell();
		await el.updateComplete;

		let fired = false;
		el.addEventListener('fit-to-contents', () => { fired = true; });

		getFitButton(el).click();
		expect(fired).toBe(true);
	});

	it('default slot content hidden when expanded=false', async () => {
		const el = createShell({ expanded: false }, {
			body: html`<div class="test-body">Body content</div>`
		});
		await el.updateComplete;

		const defaultSlot = el.shadowRoot!.querySelector('slot:not([name])');
		expect(defaultSlot).toBeNull();
	});

	it('default slot content visible when expanded=true', async () => {
		const el = createShell({ expanded: true }, {
			body: html`<div class="test-body">Body content</div>`
		});
		await el.updateComplete;

		const defaultSlot = el.shadowRoot!.querySelector('slot:not([name])');
		expect(defaultSlot).toBeTruthy();
	});

	it('header-buttons slot renders custom content', async () => {
		const el = createShell({}, {
			headerButtons: html`<button slot="header-buttons" class="custom-btn">Custom</button>`
		});
		await el.updateComplete;

		const slot = el.shadowRoot!.querySelector('slot[name="header-buttons"]') as HTMLSlotElement;
		expect(slot).toBeTruthy();
		const assigned = slot.assignedElements();
		expect(assigned.length).toBe(1);
		expect((assigned[0] as HTMLElement).textContent).toBe('Custom');
	});

	it('divider hidden when no header-buttons slotted', async () => {
		const el = createShell();
		await el.updateComplete;

		const divider = el.shadowRoot!.querySelector('.md-tabs-divider');
		expect(divider).toBeNull();
	});

	it('divider visible when header-buttons slotted', async () => {
		const el = createShell({}, {
			headerButtons: html`<button slot="header-buttons">Btn</button>`
		});
		await el.updateComplete;

		// happy-dom may not fire slotchange — simulate it by checking the slot
		const slot = el.shadowRoot!.querySelector('slot[name="header-buttons"]') as HTMLSlotElement;
		expect(slot).toBeTruthy();
		// Manually trigger what slotchange would do
		slot.dispatchEvent(new Event('slotchange'));
		await el.updateComplete;

		const divider = el.shadowRoot!.querySelector('.md-tabs-divider');
		expect(divider).toBeTruthy();
	});

	it('header-extra slot renders below header row', async () => {
		const el = createShell({}, {
			headerExtra: html`<div slot="header-extra" class="extra-content">Extra</div>`
		});
		await el.updateComplete;

		const slot = el.shadowRoot!.querySelector('slot[name="header-extra"]') as HTMLSlotElement;
		expect(slot).toBeTruthy();
		const assigned = slot.assignedElements();
		expect(assigned.length).toBe(1);
		expect((assigned[0] as HTMLElement).textContent).toBe('Extra');
	});

	it('toggle button has is-active class when expanded', async () => {
		const el = createShell({ expanded: true });
		await el.updateComplete;

		expect(getToggleButton(el).classList.contains('is-active')).toBe(true);
	});

	it('toggle button does not have is-active class when collapsed', async () => {
		const el = createShell({ expanded: false });
		await el.updateComplete;

		expect(getToggleButton(el).classList.contains('is-active')).toBe(false);
	});

	it('toggle button title changes based on expanded state', async () => {
		const el = createShell({ expanded: true });
		await el.updateComplete;
		expect(getToggleButton(el).title).toContain('Hide');

		el.expanded = false;
		await el.updateComplete;
		expect(getToggleButton(el).title).toContain('Show');
	});

	it('drag handle has draggable attribute', async () => {
		const el = createShell();
		await el.updateComplete;

		expect(getDragHandle(el).getAttribute('draggable')).toBe('true');
	});

	it('renders section type icon when section-type is set', async () => {
		const el = createShell({ sectionType: 'query' });
		await el.updateComplete;

		const icon = el.shadowRoot!.querySelector('.section-type-icon');
		expect(icon).toBeTruthy();
		expect(icon!.querySelector('svg')).toBeTruthy();
	});

	it('does not render section type icon when section-type is empty', async () => {
		const el = createShell({ sectionType: '' });
		await el.updateComplete;

		const icon = el.shadowRoot!.querySelector('.section-type-icon');
		expect(icon).toBeNull();
	});

	it('does not render section type icon when section-type is omitted', async () => {
		const el = createShell();
		await el.updateComplete;

		const icon = el.shadowRoot!.querySelector('.section-type-icon');
		expect(icon).toBeNull();
	});

	it('renders different icons for different section types', async () => {
		const el = createShell({ sectionType: 'chart' });
		await el.updateComplete;
		const chartSvg = el.shadowRoot!.querySelector('.section-type-icon svg')!.outerHTML;

		el.sectionType = 'python';
		await el.updateComplete;
		const pythonSvg = el.shadowRoot!.querySelector('.section-type-icon svg')!.outerHTML;

		expect(chartSvg).not.toBe(pythonSvg);
	});
});
