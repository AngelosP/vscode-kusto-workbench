import { LitElement, html, nothing, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { ToolbarOverflowController, type ToolbarOverflowHost } from '../sections/toolbar-overflow.controller.js';
import { registerPageScrollDismissable } from '../core/page-scroll-dismiss.js';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Sub-item for submenu dropdowns (e.g. the Tools menu). */
export interface MonacoToolbarSubItem {
	label: string;
	icon?: unknown;
	action: () => void;
}

/** Item descriptor for the generic Monaco toolbar. */
export interface MonacoToolbarItem {
	type: 'button' | 'separator' | 'toggle' | 'submenu';
	/** Display label (shown in overflow menu). */
	label?: string;
	/** Overflow-specific label (falls back to `label`). */
	overflowLabel?: string;
	/** Tooltip for the toolbar button. */
	title?: string;
	/** SVG icon (TemplateResult). */
	icon?: unknown;
	/** Whether the button shows an active/pressed state. */
	isActive?: boolean;
	/** Whether the button is disabled. */
	disabled?: boolean;
	/** Click handler — called for both inline button and overflow menu item. */
	action?: () => void;
	/** Optional custom inline render — replaces the default button markup. */
	renderInline?: (inOverflow: boolean) => TemplateResult;
	/** Optional custom overflow render — replaces the default menu item markup. */
	renderOverflow?: (close: () => void) => TemplateResult;
	/** Extra CSS classes to add to the button element. */
	extraClasses?: string;
	/** ID suffix appended to `boxId` for the button element. */
	idSuffix?: string;
	/** Toggle key identifier (for toggle items). */
	toggleKey?: string;
	/** Sub-items for submenu dropdown buttons. */
	subItems?: MonacoToolbarSubItem[];
	/** Whether the submenu button is in a busy/loading state. */
	busy?: boolean;
}

// ─── Shared SVG fragments for menus ───────────────────────────────────────────

const checkmarkIcon = html`<svg class="qe-overflow-checkmark" viewBox="0 0 16 16" width="14" height="14" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 1 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0z"/></svg>`;
const submenuArrowIcon = html`<svg class="qe-overflow-submenu-arrow" viewBox="0 0 8 8" width="8" height="8" xmlns="http://www.w3.org/2000/svg"><path d="M2.5 1.5L5.5 4L2.5 6.5" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const caretIcon = html`<svg width="8" height="8" viewBox="0 0 8 8" xmlns="http://www.w3.org/2000/svg"><path d="M1.5 2.5L4 5.5L6.5 2.5" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * `<kw-monaco-toolbar>` — Reusable **light DOM** toolbar for Monaco editor
 * sections with automatic overflow detection. Renders with the exact same DOM
 * structure and CSS class names as `kw-query-toolbar` so `queryEditor.css`
 * applies identically. When buttons don't fit, hidden items move into a `···`
 * overflow dropdown menu.
 *
 * **Subclassing**: Override `_getItems()` to provide custom items. The base
 * class calls `_getItems()` in `render()`, so subclass `@state()` changes
 * that affect item definitions will trigger re-renders correctly.
 *
 * **Light DOM**: Uses `createRenderRoot() → this` so toolbar elements are in the
 * host document's DOM and styled by external CSS — identical to how the Kusto
 * toolbar works. For shadow DOM hosts (HTML/Python sections), import the shared
 * toolbar CSS into the section's styles.
 */
@customElement('kw-monaco-toolbar')
export class KwMonacoToolbar extends LitElement implements ToolbarOverflowHost {

	/** Light DOM — same as kw-query-toolbar. */
	override createRenderRoot(): HTMLElement | DocumentFragment {
		return this;
	}

	/** Section box ID — used by the overflow controller to find the toolbar. */
	@property({ type: String, attribute: 'box-id' })
	boxId = '';

	/** Toolbar items to render (for external consumers that pass items via property). */
	@property({ attribute: false })
	items: MonacoToolbarItem[] = [];

	// ── Overflow state ────────────────────────────────────────────────────────

	@state() private _overflowStartIndex = -1;
	@state() private _overflowMenuOpen = false;

	/**
	 * Overflow controller shared by this class and all subclasses.
	 * **WARNING**: Subclasses must NOT instantiate their own — doing so creates
	 * duplicate ResizeObservers and causes oscillation.
	 */
	protected _overflowController = new ToolbarOverflowController(this as unknown as ToolbarOverflowHost);
	private _removePageScrollListener: (() => void) | null = null;
	private _dismissListenerTimer: ReturnType<typeof setTimeout> | null = null;

	// ── Submenu state ─────────────────────────────────────────────────────────

	/** Index (in _getItems() button order) of the currently open inline submenu, or -1. */
	@state() private _submenuOpenIndex = -1;
	/** Set of button indices whose overflow accordion submenu is expanded. */
	@state() private _expandedOverflowSubmenus: Set<number> = new Set();

	// Bound dismiss handlers (stable references for add/removeEventListener).
	private _onOutsideMousedown = this._handleOutsideMousedown.bind(this);

	// ── ToolbarOverflowHost interface ─────────────────────────────────────────

	getOverflowStartIndex(): number { return this._overflowStartIndex; }
	setOverflowStartIndex(index: number): void { this._overflowStartIndex = index; }

	// ── Items accessor (override in subclasses) ───────────────────────────────

	/**
	 * Returns the toolbar items to render. Subclasses override this to provide
	 * their own items. The default implementation returns `this.items` (the
	 * property set by external consumers).
	 */
	protected _getItems(): MonacoToolbarItem[] {
		return this.items;
	}

	// ── Lifecycle ─────────────────────────────────────────────────────────────

	override disconnectedCallback(): void {
		super.disconnectedCallback();
		this._overflowController.stop();
		this._removeMenuDismissListeners();
	}

	// ── Render ────────────────────────────────────────────────────────────────

	override render() {
		const id = this.boxId;
		const items = this._getItems();
		let btnIndex = 0;

		return html`
			<div class="query-editor-toolbar" role="toolbar" aria-label="Editor tools" id="${id}_toolbar">
				<div class="qe-toolbar-items">
					${items.map(item => {
						if (item.type === 'separator') {
							const inOverflow = this._overflowStartIndex >= 0 && btnIndex >= this._overflowStartIndex;
							return html`<span class=${classMap({ 'query-editor-toolbar-sep': true, 'qe-in-overflow': inOverflow })} aria-hidden="true"></span>`;
						}
						const idx = btnIndex++;
						const inOverflow = this._overflowStartIndex >= 0 && idx >= this._overflowStartIndex;

						if (item.type === 'submenu') return this._renderSubmenuButton(item, idx, inOverflow);
						if (item.type === 'toggle') return this._renderToggleButton(item, idx, inOverflow);

						// Custom render path — lets consumers provide their own button markup.
						if (item.renderInline) {
							return item.renderInline(inOverflow);
						}

						return this._renderActionButton(item, idx, inOverflow);
					})}
				</div>
				${this._renderOverflowButton()}
			</div>
		`;
	}

	// ── Action button ─────────────────────────────────────────────────────────

	private _renderActionButton(item: MonacoToolbarItem, _idx: number, inOverflow: boolean) {
		const classes: Record<string, boolean> = {
			'query-editor-toolbar-btn': true,
			'is-active': !!item.isActive,
			'qe-in-overflow': inOverflow,
		};
		if (item.extraClasses) classes[item.extraClasses] = true;
		return html`<button
			class=${classMap(classes)}
			type="button"
			title=${item.title ?? ''}
			aria-label=${item.label ?? ''}
			?disabled=${!!item.disabled}
			@click=${item.action}><span class="qe-icon" aria-hidden="true">${item.icon}</span></button>`;
	}

	// ── Toggle button ─────────────────────────────────────────────────────────

	private _renderToggleButton(item: MonacoToolbarItem, _idx: number, inOverflow: boolean) {
		const classes: Record<string, boolean> = {
			'query-editor-toolbar-btn': true,
			'query-editor-toolbar-toggle': true,
			'is-active': !!item.isActive,
			'qe-in-overflow': inOverflow,
		};
		if (item.extraClasses) classes[item.extraClasses] = true;
		return html`
			<button type="button"
				id=${item.idSuffix ? this.boxId + item.idSuffix : ''}
				class=${classMap(classes)}
				title=${item.title ?? ''}
				aria-label=${item.label ?? ''}
				aria-pressed=${item.isActive ? 'true' : 'false'}
				?disabled=${!!item.disabled}
				@click=${item.action}
			><span class="qe-icon" aria-hidden="true">${item.icon}</span></button>
		`;
	}

	// ── Submenu dropdown button ───────────────────────────────────────────────

	private _renderSubmenuButton(item: MonacoToolbarItem, idx: number, inOverflow: boolean) {
		const isOpen = this._submenuOpenIndex === idx;
		const wrapperClasses: Record<string, boolean> = {
			'qe-toolbar-menu-wrapper': true,
			'qe-in-overflow': inOverflow,
		};
		const btnClasses: Record<string, boolean> = {
			'query-editor-toolbar-btn': true,
			'qe-toolbar-dropdown-btn': true,
			'is-active': isOpen,
			'is-busy': !!item.busy,
		};
		if (item.extraClasses) btnClasses[item.extraClasses] = true;
		const subItems = item.subItems || [];

		return html`
			<span class=${classMap(wrapperClasses)} id="${this.boxId}_submenu_wrapper_${idx}">
				<button type="button"
					class=${classMap(btnClasses)}
					id="${this.boxId}_submenu_btn_${idx}"
					title=${item.title ?? item.label ?? ''}
					aria-label=${item.label ?? ''}
					aria-haspopup="listbox"
					aria-expanded=${isOpen ? 'true' : 'false'}
					@click=${(e: Event) => this._onSubmenuClick(e, idx)}
				>
					<span class="qe-icon qe-tools-icon" style=${item.busy ? 'display:none;' : ''}>${item.icon}</span>
					<span class="qe-toolbar-caret" style=${item.busy ? 'display:none;' : ''}>${caretIcon}</span>
					<span class="schema-spinner qe-tools-spinner" aria-hidden="true"
						style=${item.busy ? '' : 'display:none;'}></span>
				</button>
				${isOpen ? html`
					<div class="kusto-dropdown-menu qe-toolbar-dropdown-menu" id="${this.boxId}_submenu_menu_${idx}"
						role="listbox" tabindex="-1"
						style="display:block; width:max-content; min-width:0;"
						@mousedown=${(e: Event) => e.stopPropagation()}
						@click=${(e: Event) => e.stopPropagation()}>
						${subItems.map(si => html`
							<div class="kusto-dropdown-item" role="option" tabindex="-1"
								@click=${() => this._onSubmenuItemClick(si)}>
								<div class="kusto-dropdown-item-main">
									<span class="qe-icon">${si.icon}</span>
									<span class="qe-toolbar-menu-label">${si.label}</span>
								</div>
							</div>
						`)}
					</div>
				` : html`<div class="kusto-dropdown-menu qe-toolbar-dropdown-menu" id="${this.boxId}_submenu_menu_${idx}" role="listbox" tabindex="-1" style="display:none;"></div>`}
			</span>
		`;
	}

	// ── Overflow button ───────────────────────────────────────────────────────

	private _renderOverflowButton() {
		if (this._overflowStartIndex < 0) return nothing;
		return html`
			<span class="qe-toolbar-overflow-wrapper is-visible" id="${this.boxId}_toolbar_overflow_wrapper">
				<button type="button"
					class=${classMap({ 'qe-toolbar-overflow-btn': true, 'is-active': this._overflowMenuOpen })}
					id="${this.boxId}_toolbar_overflow_btn"
					title="More actions" aria-label="More actions"
					aria-haspopup="true" aria-expanded=${this._overflowMenuOpen ? 'true' : 'false'}
					@click=${this._onOverflowClick}
				><span aria-hidden="true">···</span></button>
				${this._overflowMenuOpen ? this._renderOverflowMenu() : nothing}
			</span>
		`;
	}

	// ── Overflow menu ─────────────────────────────────────────────────────────

	private _renderOverflowMenu() {
		const items = this._getItems();
		const overflowIdx = this._overflowStartIndex;
		if (overflowIdx < 0) return nothing;

		// Collect hidden items (past overflow cutoff)
		let btnIdx = 0;
		const hiddenItems: { item: MonacoToolbarItem; idx: number }[] = [];
		for (const item of items) {
			if (item.type === 'separator') continue;
			if (btnIdx >= overflowIdx) hiddenItems.push({ item, idx: btnIdx });
			btnIdx++;
		}
		if (!hiddenItems.length) return nothing;

		const hasAnyToggle = hiddenItems.some(h => h.item.type === 'toggle');
		const emptyPlaceholder = hasAnyToggle ? html`<span class="qe-overflow-checkmark-placeholder" style="width:14px;height:14px;display:inline-block;"></span>` : nothing;

		// Build overflow entries with group separators
		const entries: unknown[] = [];
		let lastGroup = '';
		let btnIdx2 = 0;
		for (const item of items) {
			if (item.type === 'separator') {
				if (lastGroup) lastGroup = 'sep';
				continue;
			}
			if (btnIdx2 < overflowIdx) { btnIdx2++; continue; }
			const currentBtnIdx = btnIdx2;
			btnIdx2++;

			if (lastGroup === 'sep' && entries.length > 0) {
				entries.push(html`<div class="qe-toolbar-overflow-sep"></div>`);
			}
			lastGroup = 'item';

			// Custom render path for overflow items.
			if (item.renderOverflow) {
				entries.push(item.renderOverflow(() => this._closeOverflow()));
				continue;
			}

			// Submenu → accordion
			if (item.type === 'submenu') {
				entries.push(this._renderOverflowSubmenuAccordion(item, currentBtnIdx, hasAnyToggle));
				continue;
			}

			// Toggle or button
			const isToggle = item.type === 'toggle';
			const isActive = isToggle && !!item.isActive;
			const isDisabled = !!item.disabled;

			entries.push(html`
				<div class=${classMap({ 'qe-toolbar-overflow-item': true, 'qe-overflow-item-active': isActive })}
					role="menuitem" tabindex="-1"
					style=${isDisabled ? 'opacity:0.5;cursor:default;' : ''}
					aria-disabled=${isDisabled ? 'true' : 'false'}
					@click=${() => { if (!isDisabled) { item.action?.(); this._closeOverflow(); } }}>
					${hasAnyToggle ? (isToggle && isActive ? checkmarkIcon : emptyPlaceholder) : nothing}
					<span class="qe-icon">${item.icon}</span>
					<span class="qe-toolbar-overflow-label">${item.overflowLabel || item.label || ''}</span>
				</div>
			`);
		}

		return html`
			<div class="qe-toolbar-overflow-menu kusto-dropdown-menu" role="menu"
				id="${this.boxId}_toolbar_overflow_menu"
				@mousedown=${(e: Event) => e.stopPropagation()}
				@click=${(e: Event) => e.stopPropagation()}>
				${entries}
			</div>
		`;
	}

	// ── Overflow submenu accordion ────────────────────────────────────────────

	private _renderOverflowSubmenuAccordion(item: MonacoToolbarItem, btnIdx: number, hasAnyToggle: boolean) {
		const isExpanded = this._expandedOverflowSubmenus.has(btnIdx);
		const emptyPlaceholder = hasAnyToggle ? html`<span class="qe-overflow-checkmark-placeholder" style="width:14px;height:14px;display:inline-block;"></span>` : nothing;
		const subItems = item.subItems || [];
		return html`
			<div class="qe-toolbar-overflow-item qe-overflow-has-submenu" role="menuitem" tabindex="-1"
				aria-expanded=${isExpanded ? 'true' : 'false'}
				@click=${(e: Event) => { e.stopPropagation(); this._toggleOverflowSubmenu(btnIdx); }}>
				${emptyPlaceholder}
				<span class="qe-icon">${item.icon}</span>
				<span class="qe-toolbar-overflow-label">${item.label || ''}</span>
				${submenuArrowIcon}
			</div>
			<div class=${classMap({ 'qe-toolbar-overflow-submenu-items': true, 'is-expanded': isExpanded })}>
				${subItems.map(si => html`
					<div class="qe-toolbar-overflow-item qe-overflow-submenu-item" role="menuitem" tabindex="-1"
						@click=${() => { si.action(); this._closeOverflow(); }}>
						<span class="qe-icon">${si.icon}</span>
						<span class="qe-toolbar-overflow-label">${si.label}</span>
					</div>
				`)}
			</div>
		`;
	}

	// ── Overflow positioning & dismiss ────────────────────────────────────────

	/** Reposition open menus after any re-render (e.g. layout shift from resize). */
	override updated(): void {
		if (this._overflowMenuOpen) {
			this._positionOverflowMenu();
		}
		if (this._submenuOpenIndex >= 0) {
			this._positionSubmenu();
		}
	}

	private _positionFixedMenu(btnEl: HTMLElement | null, menuEl: HTMLElement | null, alignRight = false): void {
		if (!btnEl || !menuEl) return;
		const btnRect = btnEl.getBoundingClientRect();
		const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
		menuEl.style.position = 'fixed';
		menuEl.style.top = btnRect.bottom + 'px';
		menuEl.style.zIndex = '10000';
		if (alignRight) {
			let left = btnRect.left;
			requestAnimationFrame(() => {
				try {
					const menuRect = menuEl.getBoundingClientRect();
					if (left + menuRect.width > viewportWidth - 8) left = btnRect.right - menuRect.width;
					if (left < 8) left = 8;
					menuEl.style.left = left + 'px';
				} catch { /* ignore */ }
			});
		} else {
			menuEl.style.left = btnRect.left + 'px';
		}
	}

	private _positionOverflowMenu(): void {
		const btn = this.querySelector('#' + CSS.escape(this.boxId + '_toolbar_overflow_btn')) as HTMLElement | null;
		const menu = this.querySelector('#' + CSS.escape(this.boxId + '_toolbar_overflow_menu')) as HTMLElement | null;
		this._positionFixedMenu(btn, menu, true);
	}

	private _positionSubmenu(): void {
		const idx = this._submenuOpenIndex;
		if (idx < 0) return;
		const btn = this.querySelector('#' + CSS.escape(this.boxId + '_submenu_btn_' + idx)) as HTMLElement | null;
		const menu = this.querySelector('#' + CSS.escape(this.boxId + '_submenu_menu_' + idx)) as HTMLElement | null;
		this._positionFixedMenu(btn, menu, false);
	}

	// ── Overflow click handling ───────────────────────────────────────────

	/**
	 * Hook called before any toolbar menu opens. Subclasses can override to
	 * close sibling menus (run-mode dropdown, favorites, etc.) that the base
	 * class doesn't know about.
	 */
	protected _onBeforeMenuOpen(): void { /* no-op in base */ }

	private _onOverflowClick(e: Event): void {
		e.stopPropagation();
		const wasOpen = this._overflowMenuOpen;
		this._onBeforeMenuOpen();
		this._closeSubmenu();
		this._overflowMenuOpen = !wasOpen;
		this._expandedOverflowSubmenus = new Set();
		if (this._overflowMenuOpen) {
			this.updateComplete.then(() => this._positionOverflowMenu());
			this._addMenuDismissListeners();
		} else {
			this._removeMenuDismissListeners();
		}
	}

	private _closeOverflow(): void {
		if (!this._overflowMenuOpen) return;
		this._overflowMenuOpen = false;
		this._expandedOverflowSubmenus = new Set();
		this._removeMenuDismissListeners();
	}

	// ── Submenu click handling ────────────────────────────────────────────────

	private _onSubmenuClick(e: Event, idx: number): void {
		e.stopPropagation();
		const wasOpen = this._submenuOpenIndex === idx;
		this._onBeforeMenuOpen();
		this._closeOverflow();
		this._submenuOpenIndex = wasOpen ? -1 : idx;
		if (this._submenuOpenIndex >= 0) {
			this.updateComplete.then(() => this._positionSubmenu());
			this._addMenuDismissListeners();
		} else {
			this._removeMenuDismissListeners();
		}
	}

	private _onSubmenuItemClick(subItem: MonacoToolbarSubItem): void {
		this._closeSubmenu();
		subItem.action();
	}

	private _closeSubmenu(): void {
		if (this._submenuOpenIndex < 0) return;
		this._submenuOpenIndex = -1;
		this._removeMenuDismissListeners();
	}

	private _toggleOverflowSubmenu(btnIdx: number): void {
		const next = new Set(this._expandedOverflowSubmenus);
		if (next.has(btnIdx)) next.delete(btnIdx);
		else next.add(btnIdx);
		this._expandedOverflowSubmenus = next;
	}

	// ── Public API ────────────────────────────────────────────────────────────

	/** Close overflow menu — callable by parent components. */
	public closeMenu(): void {
		this._closeOverflow();
	}

	/** Close all menus (overflow + inline submenus). */
	public closeAllMenus(): void {
		this._closeOverflow();
		this._closeSubmenu();
	}

	// ── Menu dismiss listeners ────────────────────────────────────────────────

	private _addMenuDismissListeners(): void {
		this._removePageScrollListener?.();
		this._removePageScrollListener = registerPageScrollDismissable(() => this.closeAllMenus(), {
			dismissOnWheel: true,
			shouldDismiss: ({ event, kind }) => kind !== 'wheel' || this._shouldDismissForMenuWheel(event),
		});
		this._dismissListenerTimer = setTimeout(() => {
			this._dismissListenerTimer = null;
			if (!this._overflowMenuOpen && this._submenuOpenIndex < 0) return;
			document.addEventListener('mousedown', this._onOutsideMousedown);
		}, 0);
	}

	private _removeMenuDismissListeners(): void {
		if (this._dismissListenerTimer) {
			clearTimeout(this._dismissListenerTimer);
			this._dismissListenerTimer = null;
		}
		document.removeEventListener('mousedown', this._onOutsideMousedown);
		if (this._removePageScrollListener) {
			this._removePageScrollListener();
			this._removePageScrollListener = null;
		}
	}

	private _shouldDismissForMenuWheel(event: Event): boolean {
		const path = event.composedPath();
		const menus = this.querySelectorAll('.qe-toolbar-overflow-menu, .qe-toolbar-dropdown-menu');
		for (const menu of Array.from(menus)) {
			if (path.includes(menu)) return false;
		}
		return true;
	}

	private _handleOutsideMousedown(e: MouseEvent): void {
		const path = e.composedPath();
		const overflowWrapper = this.querySelector('#' + CSS.escape(this.boxId + '_toolbar_overflow_wrapper'));
		if (overflowWrapper && path.includes(overflowWrapper)) return;
		if (this._submenuOpenIndex >= 0) {
			const submenuWrapper = this.querySelector('#' + CSS.escape(this.boxId + '_submenu_wrapper_' + this._submenuOpenIndex));
			if (submenuWrapper && path.includes(submenuWrapper)) return;
		}
		this.closeAllMenus();
	}
}

declare global {
	interface HTMLElementTagNameMap {
		'kw-monaco-toolbar': KwMonacoToolbar;
	}
}
