import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { html, render, nothing } from 'lit';
import '../../src/webview/components/kw-popover.js';
import type { KwPopover } from '../../src/webview/components/kw-popover.js';
import type { PopoverAnchorRect } from '../../src/webview/components/kw-popover.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

let container: HTMLDivElement;

const sampleAnchor: PopoverAnchorRect = {
	top: 50, left: 100, bottom: 70, width: 40, textCenter: 120,
};

function createPopover(attrs: Partial<{
	open: boolean;
	anchorRect: PopoverAnchorRect | null;
	title: string;
	showArrow: boolean;
}> = {}, content?: string, footerContent?: string): KwPopover {
	render(html`
		<kw-popover
			.open=${attrs.open ?? false}
			.anchorRect=${attrs.anchorRect ?? sampleAnchor}
			.title=${attrs.title ?? 'Test Popover'}
			.showArrow=${attrs.showArrow ?? true}
		>
			${content ? html`<span class="test-content">${content}</span>` : nothing}
			${footerContent ? html`<div slot="footer"><span class="test-footer">${footerContent}</span></div>` : nothing}
		</kw-popover>
	`, container);

	return container.querySelector('kw-popover')!;
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
	vi.useFakeTimers();
	container = document.createElement('div');
	document.body.appendChild(container);
});

afterEach(() => {
	render(nothing, container);
	container.remove();
	vi.useRealTimers();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('kw-popover', () => {
	it('renders nothing when open=false', async () => {
		const el = createPopover({ open: false });
		await el.updateComplete;

		const popover = el.shadowRoot!.querySelector('.popover');
		expect(popover).toBeNull();
	});

	it('renders popover with title when open=true', async () => {
		const el = createPopover({ open: true, title: 'My Title' });
		await el.updateComplete;

		const popover = el.shadowRoot!.querySelector('.popover');
		expect(popover).not.toBeNull();

		const header = el.shadowRoot!.querySelector('.popover-header span');
		expect(header?.textContent).toBe('My Title');
	});

	it('close button dispatches popover-close', async () => {
		const el = createPopover({ open: true });
		await el.updateComplete;

		const handler = vi.fn();
		el.addEventListener('popover-close', handler);

		const closeBtn = el.shadowRoot!.querySelector('.popover-close') as HTMLButtonElement;
		closeBtn.click();

		expect(handler).toHaveBeenCalledOnce();
	});

	it('default slot renders content', async () => {
		const el = createPopover({ open: true }, 'Hello');
		await el.updateComplete;

		// Slotted content is in light DOM, projected into shadow
		const contentSlot = el.shadowRoot!.querySelector('.popover-content slot:not([name])') as HTMLSlotElement;
		expect(contentSlot).not.toBeNull();

		const assignedElements = contentSlot?.assignedElements({ flatten: true }) ?? [];
		expect(assignedElements.length).toBeGreaterThan(0);
		expect(assignedElements[0].textContent).toBe('Hello');
	});

	it('footer slot renders footer content', async () => {
		const el = createPopover({ open: true }, 'Body', 'Footer text');
		await el.updateComplete;

		const footerSlot = el.shadowRoot!.querySelector('.popover-footer slot[name="footer"]') as HTMLSlotElement;
		expect(footerSlot).not.toBeNull();

		const assignedElements = footerSlot?.assignedElements({ flatten: true }) ?? [];
		expect(assignedElements.length).toBeGreaterThan(0);
		expect(assignedElements[0].textContent).toBe('Footer text');
	});

	it('footer wrapper present but empty when no footer content', async () => {
		const el = createPopover({ open: true }, 'Body only');
		await el.updateComplete;

		const footerSlot = el.shadowRoot!.querySelector('.popover-footer slot[name="footer"]') as HTMLSlotElement;
		expect(footerSlot).not.toBeNull();

		const assignedElements = footerSlot?.assignedElements({ flatten: true }) ?? [];
		expect(assignedElements.length).toBe(0);
	});

	it('title property reflected in header', async () => {
		const el = createPopover({ open: true, title: 'Custom Title' });
		await el.updateComplete;

		const headerText = el.shadowRoot!.querySelector('.popover-header span')?.textContent;
		expect(headerText).toBe('Custom Title');
	});

	it('reflects showarrow attribute when showArrow=true', async () => {
		const el = createPopover({ open: true, showArrow: true });
		await el.updateComplete;
		expect(el.hasAttribute('showarrow')).toBe(true);
	});

	it('does not have showarrow attribute when showArrow=false', async () => {
		const el = createPopover({ open: true, showArrow: false });
		await el.updateComplete;
		expect(el.hasAttribute('showarrow')).toBe(false);
	});
});
