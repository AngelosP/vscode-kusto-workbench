import { LitElement, html, nothing, type PropertyValues } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { styles } from './kw-popover.styles.js';
import {
	setupClickOutsideDismiss,
	setupScrollDismiss,
	pushDismissable,
	removeDismissable,
} from './popup-dismiss.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PopoverAnchorRect {
	top: number;
	left: number;
	bottom: number;
	width: number;
	/** Centre of the anchor text — used to position the arrow precisely. */
	textCenter?: number;
}

// ─── SVG ──────────────────────────────────────────────────────────────────────

const SVG_CLOSE =
	'<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" xmlns="http://www.w3.org/2000/svg"><path d="M4 4l8 8"/><path d="M12 4L4 12"/></svg>';

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * `<kw-popover>` — reusable fixed-position floating panel with arrow pointer,
 * header, and built-in dismiss behaviour (click-outside, scroll-threshold,
 * Escape).
 *
 * @fires popover-close  Dispatched when the popover is dismissed.
 * @slot             Main content area.
 * @slot footer      Optional footer area (only rendered when content is slotted).
 */
@customElement('kw-popover')
export class KwPopover extends LitElement {

	// ── Public properties ─────────────────────────────────────────────────────

	@property({ type: Boolean, reflect: true })
	open = false;

	@property({ attribute: false })
	anchorRect: PopoverAnchorRect | null = null;

	@property()
	title = '';

	@property({ type: Boolean, reflect: true, attribute: 'showarrow' })
	showArrow = true;

	@property({ type: Number, attribute: 'offset-y' })
	offsetY = 8;

	@property({ type: Number, attribute: 'arrow-left-px' })
	arrowLeftPx = 17;

	@property({ type: Number, attribute: 'min-width' })
	minWidth = 280;

	@property({ type: Number, attribute: 'max-width' })
	maxWidth = 360;

	// ── Internal state ────────────────────────────────────────────────────────

	// Cleanup handles — assigned while open, cleared on close
	private _cleanupClickOutside: (() => void) | null = null;
	private _cleanupScroll: (() => void) | null = null;
	// Stable dismiss callback for the dismiss-stack
	private _dismissCb = (): void => { this._close(); };

	// ── Styles ────────────────────────────────────────────────────────────────

	static override styles = styles;

	// ── Lifecycle ─────────────────────────────────────────────────────────────

	override updated(changed: PropertyValues): void {
		super.updated(changed);

		if (!changed.has('open')) return;
		const wasOpen = changed.get('open') as boolean | undefined;

		if (this.open && !wasOpen) {
			// Opening — install dismiss listeners after render
			this._installDismiss();
		} else if (!this.open && wasOpen) {
			// Closing — tear down dismiss listeners
			this._teardownDismiss();
		}
	}

	override disconnectedCallback(): void {
		super.disconnectedCallback();
		this._teardownDismiss();
	}

	// ── Render ─────────────────────────────────────────────────────────────────

	override render() {
		if (!this.open) return nothing;

		const pos = this._computePosition();

		return html`
			<div class="popover"
				style="top:${pos.top}px; left:${pos.left}px; min-width:${this.minWidth}px; max-width:${this.maxWidth}px;"
				@click=${(e: Event) => e.stopPropagation()}
				@mousedown=${(e: Event) => e.stopPropagation()}>
				<div class="popover-header">
					<span>${this.title}</span>
					<div class="popover-header-actions">
						<slot name="header-actions"></slot>
						<button class="popover-close" @click=${this._close} title="Close">
							<span .innerHTML=${SVG_CLOSE}></span>
						</button>
					</div>
				</div>
				<div class="popover-content">
					<slot></slot>
				</div>
				<div class="popover-footer">
					<slot name="footer"></slot>
				</div>
			</div>
		`;
	}

	// ── Private helpers ───────────────────────────────────────────────────────

	private _computePosition(): { top: number; left: number } {
		if (!this.anchorRect) return { top: 0, left: 0 };

		const top = this.anchorRect.bottom + this.offsetY;
		const left = (this.anchorRect.textCenter ?? this.anchorRect.left) - this.arrowLeftPx;
		return { top, left };
	}

	private _close(): void {
		this.dispatchEvent(new CustomEvent('popover-close', { bubbles: true, composed: true }));
	}

	private _installDismiss(): void {
		// Click-outside: use the popover div inside shadow root as the container
		const popoverEl = this.shadowRoot?.querySelector('.popover') as HTMLElement | null;
		this._cleanupClickOutside = setupClickOutsideDismiss(popoverEl, () => this._close());
		this._cleanupScroll = setupScrollDismiss(() => this._close());
		pushDismissable(this._dismissCb);
	}

	private _teardownDismiss(): void {
		this._cleanupClickOutside?.();
		this._cleanupClickOutside = null;
		this._cleanupScroll?.();
		this._cleanupScroll = null;
		removeDismissable(this._dismissCb);
	}

}

// Declare the custom element type for TypeScript
declare global {
	interface HTMLElementTagNameMap {
		'kw-popover': KwPopover;
	}
}
