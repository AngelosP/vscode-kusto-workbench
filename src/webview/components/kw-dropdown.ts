import { LitElement, html, nothing, type TemplateResult } from 'lit';
import { styles } from './kw-dropdown.styles.js';
import { scrollbarSheet } from '../shared/scrollbar-styles.js';
import { iconRegistryStyles } from '../shared/icon-registry.js';
import { customElement, property, state } from 'lit/decorators.js';
import { pushDismissable, removeDismissable } from './dismiss-stack.js';

// ─── Exported Types ───────────────────────────────────────────────────────────

export interface DropdownItem {
	id: string;
	label: string;
	icon?: TemplateResult;
	secondary?: string;
	disabled?: boolean;
}

export interface DropdownAction {
	id: string;
	label: string;
	position?: 'top' | 'bottom';
}

// ─── SVG Icons ────────────────────────────────────────────────────────────────

const chevronDownSvg = html`<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M7.976 10.072l4.357-4.357.62.618L8.284 11h-.618L3 6.333l.619-.618 4.357 4.357z" fill="currentColor"/></svg>`;

const trashIconSvg = html`<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M6 2.5h4" /><path d="M3.5 4.5h9" /><path d="M5 4.5l.7 9h4.6l.7-9" /><path d="M6.6 7v4.8" /><path d="M9.4 7v4.8" /></svg>`;

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * `<kw-dropdown>` — Reusable single-select dropdown menu.
 *
 * Renders a button + floating menu in shadow DOM.
 * Dispatches `dropdown-select`, `dropdown-action`, `dropdown-item-delete`.
 * Dispatches `dropdown-opened` (bubbles, composed) when menu opens — parents
 * can listen for this to close other popups.
 */
@customElement('kw-dropdown')
export class KwDropdown extends LitElement {

	// ── Properties ────────────────────────────────────────────────────────────

	@property({ type: Array }) items: DropdownItem[] = [];
	@property({ type: Array }) actions: DropdownAction[] = [];
	@property({ type: String }) selectedId = '';
	@property({ type: String }) placeholder = 'Select...';
	@property({ type: Boolean }) disabled = false;
	@property({ type: Boolean }) loading = false;
	@property({ type: String }) loadingText = 'Loading...';
	@property({ type: Boolean }) showDelete = false;
	@property({ attribute: false }) buttonIcon: TemplateResult | null = null;
	@property({ type: Boolean }) compactIconOnly = false;
	@property({ type: String }) emptyText = 'No items available';

	// ── Internal state ────────────────────────────────────────────────────────

	@state() private _open = false;
	@state() private _focusedIndex = -1;

	// Scroll position when menu was last opened (for 20px threshold dismiss)
	private _scrollAtOpen = 0;

	// ── Styles ────────────────────────────────────────────────────────────────

	static override styles = [scrollbarSheet, iconRegistryStyles, styles];

	// ── Lifecycle ─────────────────────────────────────────────────────────────

	private _onDocumentMousedown = (e: MouseEvent): void => {
		// If the click is inside our shadow root, ignore (stopPropagation on the
		// button/menu handles that). Otherwise, close.
		const path = e.composedPath();
		if (path.includes(this)) return;
		this._closeMenu();
	};

	private _onDocumentScroll = (): void => {
		if (!this._open) return;
		const scrollY = document.documentElement.scrollTop || document.body.scrollTop || 0;
		if (Math.abs(scrollY - this._scrollAtOpen) > 20) {
			this._closeMenu();
		}
	};

	private _dismissMenu = (): void => {
		this._closeMenu();
		const btn = this.shadowRoot?.querySelector('.kusto-dropdown-btn') as HTMLElement | null;
		btn?.focus();
	};

	private _onDocumentKeydown = (e: KeyboardEvent): void => {
		if (!this._open) return;
		if (e.key === 'Escape') {
			// Let the dismiss stack handle it — don't handle here
			return;
		}
	};

	override connectedCallback(): void {
		super.connectedCallback();
		// Reflect has-icon attribute for CSS
		this._syncHasIconAttr();
	}

	override disconnectedCallback(): void {
		super.disconnectedCallback();
		this._removeListeners();
	}

	private _addListeners(): void {
		document.addEventListener('mousedown', this._onDocumentMousedown);
		document.addEventListener('scroll', this._onDocumentScroll, true);
		document.addEventListener('keydown', this._onDocumentKeydown, true);
	}

	private _removeListeners(): void {
		document.removeEventListener('mousedown', this._onDocumentMousedown);
		document.removeEventListener('scroll', this._onDocumentScroll, true);
		document.removeEventListener('keydown', this._onDocumentKeydown, true);
	}

	// ── Render ─────────────────────────────────────────────────────────────────

	override render(): TemplateResult {
		const selectedItem = this.items.find(it => it.id === this.selectedId);
		const buttonText = this.loading
			? this.loadingText
			: selectedItem
				? this._renderItemLabel(selectedItem)
				: this.placeholder;

		return html`
			<button type="button" class="kusto-dropdown-btn"
				aria-haspopup="listbox"
				aria-expanded="${this._open ? 'true' : 'false'}"
				?disabled=${this.disabled || this.loading}
				title="${selectedItem?.label || ''}"
				@click=${this._onButtonClick}
				@mousedown=${(e: Event) => e.stopPropagation()}
				@keydown=${this._onButtonKeydown}>
				${this.buttonIcon ? html`<span class="kusto-dropdown-btn-icon" aria-hidden="true">${this.buttonIcon}</span>` : nothing}
				<span class="kusto-dropdown-btn-text">${buttonText}</span>
				<span class="kusto-dropdown-btn-caret" aria-hidden="true">${chevronDownSvg}</span>
			</button>
			${this._open ? this._renderMenu() : nothing}
		`;
	}

	private _renderMenu(): TemplateResult {
		const topActions = this.actions.filter(a => (a.position || 'top') === 'top');
		const bottomActions = this.actions.filter(a => a.position === 'bottom');
		// Pre-compute index map once for O(1) lookups
		const indexMap = new Map<string, number>();
		const entries = this._getAllEntries();
		for (let i = 0; i < entries.length; i++) {
			indexMap.set(`${entries[i].type}:${entries[i].id}`, i);
		}
		const idx = (type: 'action' | 'item', id: string) => indexMap.get(`${type}:${id}`) ?? -1;

		return html`
			<div class="kusto-dropdown-menu" role="listbox" tabindex="-1"
				@mousedown=${(e: Event) => e.stopPropagation()}
				@keydown=${this._onMenuKeydown}>
				${topActions.map(act => {
					const globalIdx = idx('action', act.id);
					return html`
						<div class="kusto-dropdown-action ${globalIdx === this._focusedIndex ? 'is-focused' : ''}"
							role="option" tabindex="-1"
							@click=${() => this._onActionClick(act.id)}
							@mouseenter=${() => { this._focusedIndex = globalIdx; }}>
							${act.label}
						</div>
					`;
				})}
				${this.items.map(item => {
					const globalIdx = idx('item', item.id);
					const isSelected = item.id === this.selectedId;
					const isFocused = globalIdx === this._focusedIndex;
					return html`
						<div class="kusto-dropdown-item ${isSelected ? 'is-selected' : ''} ${isFocused ? 'is-focused' : ''} ${item.disabled ? 'is-disabled' : ''}"
							role="option" tabindex="-1"
							aria-selected="${isSelected ? 'true' : 'false'}"
							@click=${() => !item.disabled && this._onItemClick(item)}
							@mouseenter=${() => { if (!item.disabled) this._focusedIndex = globalIdx; }}>
							${item.icon ? html`<span class="kusto-dropdown-item-icon">${item.icon}</span>` : nothing}
							<span class="kusto-dropdown-item-main">
								${this._renderItemLabel(item)}
							</span>
							${this.showDelete ? html`
								<button type="button" class="kusto-dropdown-trash"
									title="Remove" aria-label="Remove"
									@click=${(e: Event) => { e.stopPropagation(); this._onDeleteClick(item); }}>
									${trashIconSvg}
								</button>
							` : nothing}
						</div>
					`;
				})}
				${bottomActions.map(act => {
					const globalIdx = idx('action', act.id);
					return html`
						<div class="kusto-dropdown-action ${globalIdx === this._focusedIndex ? 'is-focused' : ''}"
							role="option" tabindex="-1"
							@click=${() => this._onActionClick(act.id)}
							@mouseenter=${() => { this._focusedIndex = globalIdx; }}>
							${act.label}
						</div>
					`;
				})}
				${!this.items.length && !this.actions.length ? html`<div class="kusto-dropdown-empty">${this.emptyText}</div>` : nothing}
			</div>
		`;
	}

	private _renderItemLabel(item: DropdownItem): TemplateResult | string {
		if (item.secondary) {
			return html`<span class="kusto-dropdown-primary">${item.label}</span> <span class="kusto-dropdown-secondary">${item.secondary}</span>`;
		}
		return item.label;
	}

	// ── Entry index mapping (actions + items in render order) ──────────────────

	/** Build a flat list of all focusable entries in render order: top-actions, items, bottom-actions. */
	private _getAllEntries(): Array<{ type: 'action' | 'item'; id: string }> {
		const topActions = this.actions.filter(a => (a.position || 'top') === 'top');
		const bottomActions = this.actions.filter(a => a.position === 'bottom');
		const entries: Array<{ type: 'action' | 'item'; id: string }> = [];
		for (const act of topActions) entries.push({ type: 'action', id: act.id });
		for (const item of this.items) {
			if (!item.disabled) entries.push({ type: 'item', id: item.id });
		}
		for (const act of bottomActions) entries.push({ type: 'action', id: act.id });
		return entries;
	}

	// ── Positioning ───────────────────────────────────────────────────────────

	override updated(changedProps: Map<string, unknown>): void {
		super.updated(changedProps);
		if (this._open) {
			this._positionMenu();
		}
		this._syncHasIconAttr();
	}

	private _syncHasIconAttr(): void {
		if (this.buttonIcon) {
			this.setAttribute('has-icon', '');
		} else {
			this.removeAttribute('has-icon');
		}
		if (this.compactIconOnly) {
			this.setAttribute('compact-icon-only', '');
		} else {
			this.removeAttribute('compact-icon-only');
		}
	}

	private _positionMenu(): void {
		const root = this.shadowRoot;
		if (!root) return;
		const menu = root.querySelector('.kusto-dropdown-menu') as HTMLElement | null;
		const btn = root.querySelector('.kusto-dropdown-btn') as HTMLElement | null;
		if (!menu || !btn) return;
		const rect = btn.getBoundingClientRect();
		menu.style.minWidth = rect.width + 'px';
		menu.style.left = rect.left + 'px';
		menu.style.top = rect.bottom + 'px';
		// Clamp within viewport after rendering
		requestAnimationFrame(() => {
			const vw = window.innerWidth || 0;
			const vh = window.innerHeight || 0;
			const mr = menu.getBoundingClientRect();
			if (vw > 0 && mr.right > vw) {
				menu.style.left = Math.max(0, rect.left - (mr.right - vw)) + 'px';
			}
			if (vh > 0 && mr.bottom > vh) {
				const aboveTop = rect.top - mr.height;
				menu.style.top = Math.max(0, aboveTop) + 'px';
			}
		});
	}

	// ── Event handlers ────────────────────────────────────────────────────────

	private _onButtonClick(e: Event): void {
		e.stopPropagation();
		if (this._open) {
			this._closeMenu();
		} else {
			this._openMenu();
		}
	}

	private _onButtonKeydown(e: KeyboardEvent): void {
		if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			e.preventDefault();
			if (!this._open) {
				this._openMenu();
			}
		}
	}

	private _openMenu(): void {
		this._scrollAtOpen = document.documentElement.scrollTop || document.body.scrollTop || 0;
		this._open = true;
		// Set initial focus: selected item, or first entry
		const entries = this._getAllEntries();
		const selectedIdx = entries.findIndex(e => e.type === 'item' && e.id === this.selectedId);
		this._focusedIndex = selectedIdx >= 0 ? selectedIdx : (entries.length > 0 ? 0 : -1);
		this._addListeners();
		pushDismissable(this._dismissMenu);
		// Notify parent so it can close other popups
		this.dispatchEvent(new CustomEvent('dropdown-opened', {
			bubbles: true, composed: true,
		}));
	}

	private _closeMenu(): void {
		if (!this._open) return;
		this._open = false;
		this._focusedIndex = -1;
		this._removeListeners();
		removeDismissable(this._dismissMenu);
	}

	/** Public method — allows parent to imperatively close the menu. */
	public close(): void {
		this._closeMenu();
	}

	private _onMenuKeydown(e: KeyboardEvent): void {
		const entries = this._getAllEntries();
		if (!entries.length) return;

		if (e.key === 'ArrowDown') {
			e.preventDefault();
			this._focusedIndex = (this._focusedIndex + 1) % entries.length;
			this._scrollFocusedIntoView();
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			this._focusedIndex = (this._focusedIndex - 1 + entries.length) % entries.length;
			this._scrollFocusedIntoView();
		} else if (e.key === 'Home') {
			e.preventDefault();
			this._focusedIndex = 0;
			this._scrollFocusedIntoView();
		} else if (e.key === 'End') {
			e.preventDefault();
			this._focusedIndex = entries.length - 1;
			this._scrollFocusedIntoView();
		} else if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			const entry = entries[this._focusedIndex];
			if (entry) {
				if (entry.type === 'action') {
					this._onActionClick(entry.id);
				} else {
					const item = this.items.find(it => it.id === entry.id);
					if (item) this._onItemClick(item);
				}
			}
		}
	}

	private _scrollFocusedIntoView(): void {
		// After reactive re-render, scroll the focused element into view
		this.updateComplete.then(() => {
			const root = this.shadowRoot;
			if (!root) return;
			const focused = root.querySelector('.is-focused') as HTMLElement | null;
			focused?.scrollIntoView({ block: 'nearest' });
		});
	}

	private _onItemClick(item: DropdownItem): void {
		this._closeMenu();
		this.dispatchEvent(new CustomEvent('dropdown-select', {
			detail: { id: item.id, item },
			bubbles: true, composed: true,
		}));
	}

	private _onActionClick(actionId: string): void {
		this._closeMenu();
		this.dispatchEvent(new CustomEvent('dropdown-action', {
			detail: { id: actionId },
			bubbles: true, composed: true,
		}));
	}

	private _onDeleteClick(item: DropdownItem): void {
		this.dispatchEvent(new CustomEvent('dropdown-item-delete', {
			detail: { id: item.id, item },
			bubbles: true, composed: true,
		}));
	}
}

declare global {
	interface HTMLElementTagNameMap {
		'kw-dropdown': KwDropdown;
	}
}
