// Dropdown module — legacy HTML dropdown rendering and menu management.
// ES module exports at bottom for TypeScript callers.
// window.__kustoDropdown bridge retained for inline HTML onclick handlers.
import { registerPageScrollDismissable } from './page-scroll-dismiss.js';
import { escapeHtml as _escHtml } from './utils';

const _win = window;

let removeLegacyMenuScrollDismiss: (() => void) | null = null;

function cleanupLegacyMenuScrollDismiss(): void {
	if (!removeLegacyMenuScrollDismiss) return;
	removeLegacyMenuScrollDismiss();
	removeLegacyMenuScrollDismiss = null;
}

function isInsideLegacyDropdownUi(target: EventTarget | null): boolean {
	try {
		if (!target || !(target as Element).closest) return false;
		return !!(target as Element).closest([
			'.kusto-dropdown-menu',
			'.kusto-favorites-menu',
			'.kusto-dropdown-btn',
			'.kusto-favorites-btn',
			'.kusto-dropdown-wrapper',
			'.qe-toolbar-dropdown-menu',
			'.qe-toolbar-overflow-menu',
			'.md-mode-dropdown-menu',
			'.section-mode-dropdown-menu',
			'.add-controls-dropdown-menu',
		].join(','));
	} catch {
		return false;
	}
}

function registerLegacyMenuScrollDismiss(closeMenus: () => void): void {
	cleanupLegacyMenuScrollDismiss();
	removeLegacyMenuScrollDismiss = registerPageScrollDismissable(closeMenus, {
		dismissOnWheel: true,
		shouldDismiss: ({ event, kind }) => kind !== 'wheel' || !isInsideLegacyDropdownUi(event.target),
	});
}

// Trash icon SVG inlined to avoid circular dependency with queryBoxes.ts.
const _trashIconSvg =
	'<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
	'<path d="M6 2.5h4" />' +
	'<path d="M3.5 4.5h9" />' +
	'<path d="M5 4.5l.7 9h4.6l.7-9" />' +
	'<path d="M6.6 7v4.8" />' +
	'<path d="M9.4 7v4.8" />' +
	'</svg>';

let _dd: Record<string, any>;

(function initKustoDropdown() {
	const dd: Record<string, any> = {};

	// SVG chevron-down icon matching VS Code's style
	const chevronDownSvg = '<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M7.976 10.072l4.357-4.357.62.618L8.284 11h-.618L3 6.333l.619-.618 4.357 4.357z" fill="currentColor"/></svg>';

	// Export for use by other modules
	dd.getChevronDownSvg = function() { return chevronDownSvg; };

	const escAttr = (value: unknown): string => {
		try {
			return _escHtml(String(value ?? ''));
		} catch (e) { console.error('[kusto]', e); }
		return String(value ?? '')
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&#39;');
	};

	// Renders a VS Code styled <select> inside the canonical wrapper.
	dd.renderSelectHtml = function (opts: any) {
		const o = (opts && typeof opts === 'object') ? opts : {} as any;
		const wrapperClass = String(o.wrapperClass || '').trim();
		const title = String(o.title || '').trim();
		const iconSvg = o.iconSvg ? String(o.iconSvg) : '';
		const selectId = String(o.selectId || '').trim();
		const onChange = String(o.onChange || '').trim();
		const placeholder = String(o.placeholder || '').trim();
		const extraSelectAttrs = String(o.extraSelectAttrs || '').trim();

		const hasIcon = !!iconSvg;
		const wrapperClasses = ['select-wrapper', wrapperClass, hasIcon ? 'has-icon' : '']
			.filter(Boolean)
			.join(' ');

		const titleAttr = title ? (' title="' + escAttr(title) + '"') : '';
		const changeAttr = onChange ? (' onchange="' + escAttr(onChange) + '"') : '';
		const idAttr = selectId ? (' id="' + escAttr(selectId) + '"') : '';
		const extraAttrs = extraSelectAttrs ? (' ' + extraSelectAttrs) : '';
		const placeholderOption = placeholder
			? ('<option value="" disabled selected hidden>' + escAttr(placeholder) + '</option>')
			: '';

		return (
			'<div class="' + wrapperClasses + '"' + titleAttr + '>' +
				(hasIcon ? ('<span class="select-icon" aria-hidden="true">' + iconSvg + '</span>') : '') +
				'<select' + idAttr + changeAttr + extraAttrs + '>' +
					placeholderOption +
				'</select>' +
			'</div>'
		);
	};

	// Renders a button+menu dropdown that *looks like* our select inputs.
	dd.renderMenuDropdownHtml = function (opts: any) {
		const o = (opts && typeof opts === 'object') ? opts : {} as any;
		const wrapperClass = String(o.wrapperClass || '').trim();
		const title = String(o.title || '').trim();
		const iconSvg = o.iconSvg ? String(o.iconSvg) : '';
		const wrapperId = String(o.wrapperId || '').trim();
		const wrapperStyle = String(o.wrapperStyle || '').trim();
		const includeHiddenSelect = !!o.includeHiddenSelect;
		const selectId = String(o.selectId || '').trim();
		const onChange = String(o.onChange || '').trim();
		const extraSelectAttrs = String(o.extraSelectAttrs || '').trim();
		const buttonId = String(o.buttonId || '').trim();
		const buttonTextId = String(o.buttonTextId || '').trim();
		const menuId = String(o.menuId || '').trim();
		const placeholder = String(o.placeholder || '').trim();
		const onToggle = String(o.onToggle || '').trim();

		const hasIcon = !!iconSvg;
		const wrapperClasses = ['select-wrapper', wrapperClass, 'kusto-dropdown-wrapper', hasIcon ? 'has-icon' : '']
			.filter(Boolean)
			.join(' ');

		const titleAttr = title ? (' title="' + escAttr(title) + '"') : '';
		const wrapperIdAttr = wrapperId ? (' id="' + escAttr(wrapperId) + '"') : '';
		const wrapperStyleAttr = wrapperStyle ? (' style="' + escAttr(wrapperStyle) + '"') : '';
		const buttonIdAttr = buttonId ? (' id="' + escAttr(buttonId) + '"') : '';
		const menuIdAttr = menuId ? (' id="' + escAttr(menuId) + '"') : '';
		const textIdAttr = buttonTextId ? (' id="' + escAttr(buttonTextId) + '"') : '';
		const changeAttr = onChange ? (' onchange="' + escAttr(onChange) + '"') : '';
		const selectIdAttr = selectId ? (' id="' + escAttr(selectId) + '"') : '';
		const extraAttrs = extraSelectAttrs ? (' ' + extraSelectAttrs) : '';
		const placeholderOption = placeholder
			? ('<option value="" disabled selected hidden>' + escAttr(placeholder) + '</option>')
			: '';
		const hiddenSelectHtml = includeHiddenSelect
			? ('<select class="kusto-dropdown-hidden-select"' + selectIdAttr + changeAttr + extraAttrs + '>' + placeholderOption + '</select>')
			: '';

		const clickAttr = onToggle
			? (' onclick="' + escAttr(onToggle) + '; event.stopPropagation();"')
			: ' onclick="event.stopPropagation();"';

		return (
			'<div class="' + wrapperClasses + '"' + wrapperIdAttr + titleAttr + wrapperStyleAttr + '>' +
				hiddenSelectHtml +
				'<button type="button" class="kusto-dropdown-btn"' + buttonIdAttr + clickAttr + ' aria-haspopup="listbox" aria-expanded="false">' +
					(hasIcon ? ('<span class="select-icon" aria-hidden="true">' + iconSvg + '</span>') : '') +
					'<span class="kusto-dropdown-btn-text"' + textIdAttr + '>' + escAttr(placeholder || 'Select...') + '</span>' +
					'<span class="kusto-dropdown-btn-caret" aria-hidden="true">' + chevronDownSvg + '</span>' +
				'</button>' +
				'<div class="kusto-dropdown-menu"' + menuIdAttr + ' role="listbox" tabindex="-1" style="display:none;"></div>' +
			'</div>'
		);
	};

	// Renders items into a dropdown menu.
	dd.renderMenuItemsHtml = function (items: any[], opts: any) {
		const list = Array.isArray(items) ? items : [];
		const o = (opts && typeof opts === 'object') ? opts : {} as any;
		const dropdownId = String(o.dropdownId || '').trim();
		const onSelectJs = typeof o.onSelectJs === 'function' ? o.onSelectJs : null;
		const onDeleteJs = typeof o.onDeleteJs === 'function' ? o.onDeleteJs : null;
		const emptyHtml = String(o.emptyHtml || '').trim();
		const includeOtherRowHtml = String(o.includeOtherRowHtml || '').trim();

		if (!list.length) {
			return emptyHtml || '<div class="kusto-dropdown-empty">No items.</div>';
		}

		const trashSvg = _trashIconSvg;
		const rows: string[] = [];

		for (let idx = 0; idx < list.length; idx++) {
			const it = list[idx];
			if (!it) continue;
			const keyEnc = String(it.key || '');
			const itemId = dropdownId ? (dropdownId + '_opt_' + idx) : ('kusto_dropdown_opt_' + idx);
			const mainHtml = String(it.html || '');
			const ariaLabel = it.ariaLabel ? String(it.ariaLabel) : '';
			const isDisabled = !!it.disabled;
			const isSelected = !!it.selected;
			const canDelete = !!(!isDisabled && it.enableDelete && onDeleteJs);

			const aria = ariaLabel ? (' aria-label="' + escAttr(ariaLabel) + '"') : '';
			const ariaSelected = ' aria-selected="' + (isSelected ? 'true' : 'false') + '"';
			const ariaDisabled = isDisabled ? ' aria-disabled="true"' : '';
			const click = (!isDisabled && onSelectJs)
				? (' onclick="' + escAttr(onSelectJs(keyEnc)) + '"')
				: '';
			const classes = ['kusto-dropdown-item', isSelected ? 'is-selected' : '', isDisabled ? 'is-disabled' : '']
				.filter(Boolean)
				.join(' ');

			rows.push(
				'<div class="' + escAttr(classes) + '" id="' + escAttr(itemId) + '" role="option" tabindex="-1"' + ariaSelected + ariaDisabled + ' data-kusto-key="' + escAttr(keyEnc) + '"' + click + aria + '>' +
					'<div class="kusto-dropdown-item-main">' + mainHtml + '</div>' +
					(canDelete
						? ('<button type="button" class="kusto-dropdown-trash" tabindex="-1" title="Remove" aria-label="Remove" data-kusto-key="' + escAttr(keyEnc) + '" onclick="' + escAttr(onDeleteJs(keyEnc)) + '; event.stopPropagation();">' + trashSvg + '</button>')
						: '') +
				'</div>'
			);
		}

		if (includeOtherRowHtml) {
			rows.push(includeOtherRowHtml);
		}

		return rows.join('');
	};

	const getWrapperFromSelect = (selectEl: HTMLElement | null): HTMLElement | null => {
		try {
			if (!selectEl) return null;
			if (typeof selectEl.closest === 'function') {
				return selectEl.closest('.kusto-dropdown-wrapper') as HTMLElement | null;
			}
		} catch (e) { console.error('[kusto]', e); }
		return null;
	};

	dd.closeAllMenus = function () {
		try {
			cleanupLegacyMenuScrollDismiss();
			const menus = Array.from(document.querySelectorAll('.kusto-dropdown-menu, .kusto-favorites-menu, .qe-toolbar-overflow-menu, .md-mode-dropdown-menu, .section-mode-dropdown-menu, .add-controls-dropdown-menu'));
			for (const m of menus) {
				try { (m as HTMLElement).style.display = 'none'; } catch (e) { console.error('[kusto]', e); }
			}
			const buttons = Array.from(document.querySelectorAll('.kusto-dropdown-btn, .kusto-favorites-btn, .qe-toolbar-dropdown-btn, .qe-toolbar-overflow-btn, .md-mode-dropdown-btn, .section-mode-dropdown-btn, .add-controls-dropdown-btn'));
			for (const b of buttons) {
				try { b.setAttribute('aria-expanded', 'false'); } catch (e) { console.error('[kusto]', e); }
				try { b.classList && b.classList.remove('is-active'); } catch (e) { console.error('[kusto]', e); }
			}
		} catch (e) { console.error('[kusto]', e); }
	};

	dd.closeMenuDropdown = function (buttonId: string, menuId: string) {
		const bid = String(buttonId || '').trim();
		const mid = String(menuId || '').trim();
		if (!bid || !mid) return;
		try {
			cleanupLegacyMenuScrollDismiss();
			const menu = document.getElementById(mid);
			if (menu) (menu as HTMLElement).style.display = 'none';
		} catch (e) { console.error('[kusto]', e); }
		try {
			const btn = document.getElementById(bid);
			if (btn) {
				btn.setAttribute('aria-expanded', 'false');
				try { btn.classList && btn.classList.remove('is-active'); } catch (e) { console.error('[kusto]', e); }
			}
		} catch (e) { console.error('[kusto]', e); }
	};

	dd.toggleMenuDropdown = function (opts: any) {
		const o = (opts && typeof opts === 'object') ? opts : {} as any;
		const bid = String(o.buttonId || '').trim();
		const mid = String(o.menuId || '').trim();
		if (!bid || !mid) return;
		const btn = document.getElementById(bid) as HTMLButtonElement | null;
		const menu = document.getElementById(mid) as HTMLElement | null;
		if (!btn || !menu) return;
		try {
			if (btn.disabled) return;
		} catch (e) { console.error('[kusto]', e); }

		const wasOpen = String(menu.style.display || '') === 'block';
		try { if (typeof (_win.closeAllRunMenus) === 'function') _win.closeAllRunMenus(); } catch (e) { console.error('[kusto]', e); }
		try { dd.closeAllMenus(); } catch (e) { console.error('[kusto]', e); }

		if (wasOpen) {
			return;
		}

		try {
			if (typeof o.beforeOpen === 'function') {
				o.beforeOpen();
			}
		} catch (e) { console.error('[kusto]', e); }

		try {
			menu.style.display = 'block';
			btn.setAttribute('aria-expanded', 'true');
			try { btn.classList && btn.classList.add('is-active'); } catch (e) { console.error('[kusto]', e); }
			registerLegacyMenuScrollDismiss(() => dd.closeAllMenus());
		} catch (e) { console.error('[kusto]', e); }

		const positionFixedMenuUnderButton = (buttonEl: HTMLElement, menuEl: HTMLElement) => {
			try {
				const rect = buttonEl.getBoundingClientRect();
				let left = rect.left;
				let top = rect.bottom;
				menuEl.style.minWidth = rect.width + 'px';
				menuEl.style.left = left + 'px';
				menuEl.style.top = top + 'px';

				const vw = Math.max(0, window.innerWidth || 0);
				const vh = Math.max(0, window.innerHeight || 0);
				const menuRect = menuEl.getBoundingClientRect();

				if (vw > 0) {
					const overRight = (menuRect.right - vw);
					if (overRight > 0) {
						left = Math.max(0, left - overRight);
					}
					if (left < 0) left = 0;
				}

				if (vh > 0) {
					const overBottom = (menuRect.bottom - vh);
					if (overBottom > 0) {
						const aboveTop = rect.top - menuRect.height;
						top = Math.max(0, aboveTop);
					}
					if (top < 0) top = 0;
				}

				menuEl.style.left = left + 'px';
				menuEl.style.top = top + 'px';
			} catch (e) { console.error('[kusto]', e); }
		};

		try {
			const computedPos = window.getComputedStyle(menu).position;
			if (computedPos === 'fixed') {
				positionFixedMenuUnderButton(btn, menu);
			}
		} catch (e) { console.error('[kusto]', e); }

		try {
			if (dd && typeof (dd.wireCloseOnFocusOut) === 'function') {
				dd.wireCloseOnFocusOut(btn, menu);
			}
		} catch (e) { console.error('[kusto]', e); }

		try {
			if (dd && typeof (dd.wireMenuInteractions) === 'function') {
				dd.wireMenuInteractions(menu);
			}
		} catch (e) { console.error('[kusto]', e); }

		try {
			if (typeof o.afterOpen === 'function') {
				o.afterOpen();
			}
		} catch (e) { console.error('[kusto]', e); }

		try { menu.focus(); } catch (e) { console.error('[kusto]', e); }
	};

	dd.wireCloseOnFocusOut = function (buttonEl: HTMLElement, menuEl: HTMLElement) {
		const btn = buttonEl;
		const menu = menuEl;
		if (!btn || !menu) return;

		let wrapper: HTMLElement | null = null;
		try {
			if (typeof btn.closest === 'function') {
				wrapper = btn.closest('.kusto-dropdown-wrapper') as HTMLElement || btn.closest('.select-wrapper') as HTMLElement;
			}
		} catch (e) { console.error('[kusto]', e); }
		if (!wrapper) {
			try { wrapper = menu.parentElement || null; } catch { wrapper = null; }
		}
		if (!wrapper) return;

		try {
			if (wrapper.dataset && wrapper.dataset.kustoCloseOnBlurWired === '1') {
				return;
			}
			if (wrapper.dataset) {
				wrapper.dataset.kustoCloseOnBlurWired = '1';
			}
		} catch (e) { console.error('[kusto]', e); }

		wrapper.addEventListener('focusout', () => {
			try {
				setTimeout(() => {
					try {
						const active = document.activeElement;
						if (active && wrapper!.contains(active)) {
							return;
						}
						if (String(menu.style.display || '') === 'block') {
							cleanupLegacyMenuScrollDismiss();
							try { menu.style.display = 'none'; } catch (e) { console.error('[kusto]', e); }
							try { btn.setAttribute('aria-expanded', 'false'); } catch (e) { console.error('[kusto]', e); }
							try { btn.classList && btn.classList.remove('is-active'); } catch (e) { console.error('[kusto]', e); }
						}
					} catch (e) { console.error('[kusto]', e); }
				}, 0);
			} catch (e) { console.error('[kusto]', e); }
		});
	};

	const getMenuItems = (menuEl: HTMLElement | null): HTMLElement[] => {
		try {
			if (!menuEl) return [];
			const all = Array.from(menuEl.querySelectorAll('.kusto-dropdown-item[role="option"], .kusto-favorites-item[role="option"]'));
			return (all as HTMLElement[]).filter((el) => {
				try {
					if (!el) return false;
					if (el.classList && el.classList.contains('is-disabled')) return false;
					const ariaDis = el.getAttribute && el.getAttribute('aria-disabled');
					return ariaDis !== 'true';
				} catch {
					return false;
				}
			});
		} catch {
			return [];
		}
	};

	const setActiveMenuItem = (menuEl: HTMLElement, itemEl: HTMLElement) => {
		if (!menuEl || !itemEl) return;
		try {
			const items = getMenuItems(menuEl);
			for (const it of items) {
				try { it.classList.remove('is-active'); } catch (e) { console.error('[kusto]', e); }
			}
			try { itemEl.classList.add('is-active'); } catch (e) { console.error('[kusto]', e); }
			try { itemEl.focus(); } catch (e) { console.error('[kusto]', e); }
			try { itemEl.scrollIntoView({ block: 'nearest' }); } catch (e) { console.error('[kusto]', e); }
			try {
				const idx = items.indexOf(itemEl);
				if (idx >= 0 && menuEl.dataset) {
					menuEl.dataset.kustoActiveIndex = String(idx);
				}
			} catch (e) { console.error('[kusto]', e); }
		} catch (e) { console.error('[kusto]', e); }
	};

	const getInitialActiveItem = (menuEl: HTMLElement): HTMLElement | null => {
		const items = getMenuItems(menuEl);
		if (!items.length) return null;
		try {
			for (const it of items) {
				try {
					if (it.getAttribute && it.getAttribute('aria-selected') === 'true') {
						return it;
					}
				} catch (e) { console.error('[kusto]', e); }
			}
		} catch (e) { console.error('[kusto]', e); }
		return items[0];
	};

	dd.wireMenuInteractions = function (menuEl: HTMLElement) {
		if (!menuEl) return;
		try {
			if (menuEl.dataset && menuEl.dataset.kustoMenuWired === '1') {
				const items = getMenuItems(menuEl);
				const hasActive = items.some((it) => it.classList && it.classList.contains('is-active'));
				if (!hasActive) {
					const initial = getInitialActiveItem(menuEl);
					if (initial) setActiveMenuItem(menuEl, initial);
				}
				return;
			}
		} catch (e) { console.error('[kusto]', e); }

		try {
			if (menuEl.dataset) {
				menuEl.dataset.kustoMenuWired = '1';
			}
		} catch (e) { console.error('[kusto]', e); }

		try { menuEl.setAttribute('tabindex', '-1'); } catch (e) { console.error('[kusto]', e); }

		try {
			menuEl.addEventListener('mouseenter', (ev) => {
				try {
					const target = ev && ev.target ? (ev.target as HTMLElement).closest('.kusto-dropdown-item[role="option"], .kusto-favorites-item[role="option"]') as HTMLElement | null : null;
					if (target) setActiveMenuItem(menuEl, target);
				} catch (e) { console.error('[kusto]', e); }
			}, true);
			menuEl.addEventListener('focusin', (ev) => {
				try {
					const target = ev && ev.target ? (ev.target as HTMLElement).closest('.kusto-dropdown-item[role="option"], .kusto-favorites-item[role="option"]') as HTMLElement | null : null;
					if (target) setActiveMenuItem(menuEl, target);
				} catch (e) { console.error('[kusto]', e); }
			}, true);
		} catch (e) { console.error('[kusto]', e); }

		menuEl.addEventListener('keydown', (ev) => {
			const e = ev || window.event;
			const key = String(e && e.key ? e.key : '');
			if (!key) return;
			const items = getMenuItems(menuEl);
			if (!items.length) return;

			let idx = -1;
			try {
				if (menuEl.dataset && typeof menuEl.dataset.kustoActiveIndex === 'string') {
					idx = parseInt(menuEl.dataset.kustoActiveIndex, 10);
				}
			} catch (e) { console.error('[kusto]', e); }
			if (!(idx >= 0 && idx < items.length)) {
				idx = Math.max(0, items.findIndex((it) => it.classList && it.classList.contains('is-active')));
				if (idx < 0) idx = 0;
			}

			const prevent = () => {
				try { e.preventDefault(); } catch (e) { console.error('[kusto]', e); }
				try { e.stopPropagation(); } catch (e) { console.error('[kusto]', e); }
			};

			switch (key) {
				case 'ArrowDown': {
					prevent();
					const next = (idx + 1) % items.length;
					setActiveMenuItem(menuEl, items[next]);
					break;
				}
				case 'ArrowUp': {
					prevent();
					const next = (idx - 1 + items.length) % items.length;
					setActiveMenuItem(menuEl, items[next]);
					break;
				}
				case 'Home': {
					prevent();
					setActiveMenuItem(menuEl, items[0]);
					break;
				}
				case 'End': {
					prevent();
					setActiveMenuItem(menuEl, items[items.length - 1]);
					break;
				}
				case 'Enter':
				case ' ': {
					prevent();
					const active = items[idx] || items[0];
					try { active && active.click && active.click(); } catch (e) { console.error('[kusto]', e); }
					break;
				}
				case 'Escape': {
					prevent();
					try { dd && dd.closeAllMenus && dd.closeAllMenus(); } catch (e) { console.error('[kusto]', e); }
					break;
				}
				default:
					break;
			}
		});

		try {
			const initial = getInitialActiveItem(menuEl);
			if (initial) setActiveMenuItem(menuEl, initial);
		} catch (e) { console.error('[kusto]', e); }
	};

	dd.syncSelectBackedDropdown = function (selectId: string) {
		const id = String(selectId || '').trim();
		if (!id) return;
		const select = document.getElementById(id) as HTMLSelectElement | null;
		if (!select) return;

		const wrapper = getWrapperFromSelect(select);
		if (!wrapper) return;
		const menu = wrapper.querySelector('.kusto-dropdown-menu') as HTMLElement | null;
		const btn = wrapper.querySelector('.kusto-dropdown-btn') as HTMLButtonElement | null;
		const btnText = wrapper.querySelector('.kusto-dropdown-btn-text') as HTMLElement | null;
		if (!menu || !btn || !btnText) return;

		try {
			btn.disabled = !!select.disabled;
			btn.setAttribute('aria-disabled', select.disabled ? 'true' : 'false');
		} catch (e) { console.error('[kusto]', e); }

		let placeholderText = '';
		try {
			const ph = select.querySelector('option[value=""]') as HTMLOptionElement | null;
			if (ph && ph.disabled) {
				placeholderText = String(ph.textContent || '').trim();
			}
		} catch (e) { console.error('[kusto]', e); }

		let selectedLabel = '';
		try {
			const opt = select.selectedOptions && select.selectedOptions.length ? select.selectedOptions[0] : null;
			if (opt) {
				const shortLabel = opt.getAttribute('data-short-label');
				selectedLabel = String(shortLabel || opt.textContent || '').trim();
			}
		} catch (e) { console.error('[kusto]', e); }

		btnText.textContent = selectedLabel || placeholderText || 'Select...';
		try {
			btn.title = selectedLabel || '';
		} catch (e) { console.error('[kusto]', e); }

		const showLabelTooltips = (() => {
			try {
				return !!(wrapper.classList && wrapper.classList.contains('kusto-dropdown-tooltip-label'));
			} catch {
				return false;
			}
		})();

		const items: any[] = [];
		try {
			const opts = Array.from(select.options || []);
			for (const o of opts) {
				if (!o) continue;
				const val = String(o.value || '');
				const label = String(o.textContent || '').trim();
				if (!val && o.disabled) {
					continue;
				}
				const safeLabel = label || val;
				const mainHtml = showLabelTooltips
					? ('<span class="kusto-dropdown-item-label" title="' + escAttr(safeLabel) + '">' + escAttr(safeLabel) + '</span>')
					: escAttr(safeLabel);
				items.push({
					key: encodeURIComponent(val),
					html: mainHtml,
					ariaLabel: label ? 'Select ' + label : 'Select',
					disabled: !!o.disabled,
					selected: !!o.selected
				});
			}
		} catch (e) { console.error('[kusto]', e); }

		if (!items.length) {
			menu.innerHTML = '<div class="kusto-dropdown-empty">No items.</div>';
			return;
		}

		try {
			menu.innerHTML = dd.renderMenuItemsHtml(items, {
				dropdownId: id,
				onSelectJs: (keyEnc: string) => "window.__kustoDropdown.selectFromMenu('" + id + "', '" + keyEnc + "')"
			});
		} catch {
			menu.innerHTML = items
				.map((it) => '<div class="kusto-dropdown-item" role="option" tabindex="-1" data-kusto-key="' + escAttr(it.key) + '" onclick="window.__kustoDropdown.selectFromMenu(\'' + escAttr(id) + '\', \'' + escAttr(it.key) + '\');">' + it.html + '</div>')
				.join('');
		}
	};

	dd.selectFromMenu = function (selectId: string, keyEnc: string) {
		const id = String(selectId || '').trim();
		if (!id) return;
		const select = document.getElementById(id) as HTMLSelectElement | null;
		if (!select || select.disabled) return;

		let nextValue = '';
		try { nextValue = decodeURIComponent(String(keyEnc || '')); } catch { nextValue = String(keyEnc || ''); }

		try {
			select.value = nextValue;
		} catch (e) { console.error('[kusto]', e); }
		try {
			select.dispatchEvent(new Event('change', { bubbles: true }));
		} catch {
			try {
				if (typeof select.onchange === 'function') {
					select.onchange(new Event('change'));
				}
			} catch (e) { console.error('[kusto]', e); }
		}
		try { dd.syncSelectBackedDropdown(id); } catch (e) { console.error('[kusto]', e); }
		try { dd.closeAllMenus(); } catch (e) { console.error('[kusto]', e); }
	};

	dd.toggleSelectMenu = function (selectId: string) {
		const id = String(selectId || '').trim();
		if (!id) return;
		const select = document.getElementById(id) as HTMLSelectElement | null;
		if (!select) return;
		const wrapper = getWrapperFromSelect(select);
		if (!wrapper) return;
		const menu = wrapper.querySelector('.kusto-dropdown-menu') as HTMLElement | null;
		const btn = wrapper.querySelector('.kusto-dropdown-btn') as HTMLButtonElement | null;
		if (!menu || !btn) return;
		if (btn.disabled) return;

		try {
			dd.toggleMenuDropdown({
				buttonId: btn.id,
				menuId: menu.id,
				beforeOpen: () => {
					try { dd.syncSelectBackedDropdown(id); } catch (e) { console.error('[kusto]', e); }
				}
			});
		} catch {
			try { dd.syncSelectBackedDropdown(id); } catch (e) { console.error('[kusto]', e); }
			menu.style.display = 'block';
			btn.setAttribute('aria-expanded', 'true');
			try { menu.focus(); } catch (e) { console.error('[kusto]', e); }
		}
	};

	// =====================================
	// Checkbox Multi-Select Dropdown
	// =====================================

	dd.renderCheckboxDropdownHtml = function (opts: any) {
		const o = (opts && typeof opts === 'object') ? opts : {} as any;
		const wrapperClass = String(o.wrapperClass || '').trim();
		const wrapperId = String(o.wrapperId || '').trim();
		const buttonId = String(o.buttonId || '').trim();
		const buttonTextId = String(o.buttonTextId || '').trim();
		const menuId = String(o.menuId || '').trim();
		const placeholder = String(o.placeholder || '').trim();
		const onToggle = String(o.onToggle || '').trim();

		const wrapperClasses = ['select-wrapper', 'kusto-dropdown-wrapper', 'kusto-checkbox-dropdown', wrapperClass]
			.filter(Boolean)
			.join(' ');

		const wrapperIdAttr = wrapperId ? (' id="' + escAttr(wrapperId) + '"') : '';
		const buttonIdAttr = buttonId ? (' id="' + escAttr(buttonId) + '"') : '';
		const menuIdAttr = menuId ? (' id="' + escAttr(menuId) + '"') : '';
		const textIdAttr = buttonTextId ? (' id="' + escAttr(buttonTextId) + '"') : '';

		const clickAttr = onToggle
			? (' onclick="' + escAttr(onToggle) + '; event.stopPropagation();"')
			: ' onclick="event.stopPropagation();"';

		return (
			'<div class="' + wrapperClasses + '"' + wrapperIdAttr + '>' +
				'<button type="button" class="kusto-dropdown-btn"' + buttonIdAttr + clickAttr + ' aria-haspopup="listbox" aria-expanded="false">' +
					'<span class="kusto-dropdown-btn-text"' + textIdAttr + '>' + escAttr(placeholder || 'Select...') + '</span>' +
					'<span class="kusto-dropdown-btn-caret" aria-hidden="true">' + chevronDownSvg + '</span>' +
				'</button>' +
				'<div class="kusto-dropdown-menu kusto-checkbox-menu"' + menuIdAttr + ' role="listbox" tabindex="-1" style="display:none;"></div>' +
			'</div>'
		);
	};

	dd.renderCheckboxItemsHtml = function (items: any[], opts: any) {
		const list = Array.isArray(items) ? items : [];
		const o = (opts && typeof opts === 'object') ? opts : {} as any;
		const dropdownId = String(o.dropdownId || '').trim();
		const onChangeJs = String(o.onChangeJs || '').trim();
		const emptyHtml = String(o.emptyHtml || '').trim();

		if (!list.length) {
			return emptyHtml || '<div class="kusto-dropdown-empty">No items.</div>';
		}

		const rows: string[] = [];
		for (let idx = 0; idx < list.length; idx++) {
			const it = list[idx];
			if (!it) continue;
			const key = String(it.key || '');
			const label = String(it.label || key);
			const isChecked = !!it.checked;
			const isDisabled = !!it.disabled;
			const itemId = dropdownId ? (dropdownId + '_chk_' + idx) : ('kusto_chk_' + idx);
			const checkboxId = itemId + '_input';

			const disabledAttr = isDisabled ? ' disabled' : '';
			const checkedAttr = isChecked ? ' checked' : '';
			const classes = ['kusto-dropdown-item', 'kusto-checkbox-item', isDisabled ? 'is-disabled' : '']
				.filter(Boolean)
				.join(' ');

			const changeHandler = onChangeJs
				? (' onchange="' + escAttr(onChangeJs) + '(\'' + escAttr(dropdownId) + '\')"')
				: '';

			rows.push(
				'<label class="' + classes + '" for="' + escAttr(checkboxId) + '">' +
					'<input type="checkbox" id="' + escAttr(checkboxId) + '" value="' + escAttr(key) + '"' + checkedAttr + disabledAttr + changeHandler + ' />' +
					'<span class="kusto-checkbox-label">' + escAttr(label) + '</span>' +
				'</label>'
			);
		}

		return rows.join('');
	};

	dd.getCheckboxSelections = function (menuId: string): string[] {
		const menu = document.getElementById(menuId);
		if (!menu) return [];
		const checkboxes = Array.from(menu.querySelectorAll('input[type="checkbox"]:checked')) as HTMLInputElement[];
		return checkboxes.map(cb => cb.value);
	};

	dd.updateCheckboxButtonText = function (buttonTextId: string, selectedValues: string[], placeholder: string) {
		const btnText = document.getElementById(buttonTextId);
		if (!btnText) return;
		const ph = String(placeholder || 'Select...').trim();
		if (!selectedValues || !selectedValues.length) {
			btnText.textContent = ph;
			btnText.title = '';
		} else if (selectedValues.length === 1) {
			btnText.textContent = selectedValues[0];
			btnText.title = selectedValues[0];
		} else {
			const text = selectedValues.length + ' selected';
			btnText.textContent = text;
			btnText.title = selectedValues.join(', ');
		}
	};

	dd.toggleCheckboxMenu = function (buttonId: string, menuId: string) {
		const btn = document.getElementById(buttonId) as HTMLButtonElement | null;
		const menu = document.getElementById(menuId) as HTMLElement | null;
		if (!btn || !menu) return;
		if (btn.disabled) return;

		const wasOpen = String(menu.style.display || '') === 'block';
		try { dd.closeAllMenus(); } catch (e) { console.error('[kusto]', e); }

		if (wasOpen) return;

		menu.style.display = 'block';
		btn.setAttribute('aria-expanded', 'true');
		try { btn.classList && btn.classList.add('is-active'); } catch (e) { console.error('[kusto]', e); }
		registerLegacyMenuScrollDismiss(() => dd.closeAllMenus());

		try {
			const computedPos = window.getComputedStyle(menu).position;
			if (computedPos === 'fixed') {
				try {
					const rect = btn.getBoundingClientRect();
					let left = rect.left;
					let top = rect.bottom;
					menu.style.minWidth = rect.width + 'px';
					menu.style.left = left + 'px';
					menu.style.top = top + 'px';

					const vw = Math.max(0, window.innerWidth || 0);
					const vh = Math.max(0, window.innerHeight || 0);
					const menuRect = menu.getBoundingClientRect();

					if (vw > 0) {
						const overRight = (menuRect.right - vw);
						if (overRight > 0) {
							left = Math.max(0, left - overRight);
						}
						if (left < 0) left = 0;
					}

					if (vh > 0) {
						const overBottom = (menuRect.bottom - vh);
						if (overBottom > 0) {
							const aboveTop = rect.top - menuRect.height;
							top = Math.max(0, aboveTop);
						}
						if (top < 0) top = 0;
					}

					menu.style.left = left + 'px';
					menu.style.top = top + 'px';
				} catch (e) { console.error('[kusto]', e); }
			}
		} catch (e) { console.error('[kusto]', e); }

		try {
			if (!menu.dataset.kustoStopPropagationWired) {
				menu.addEventListener('click', (ev) => {
					try { ev.stopPropagation(); } catch (e) { console.error('[kusto]', e); }
				});
				menu.dataset.kustoStopPropagationWired = '1';
			}
		} catch (e) { console.error('[kusto]', e); }

		try {
			dd.wireCloseOnFocusOut(btn, menu);
		} catch (e) { console.error('[kusto]', e); }

		try { menu.focus(); } catch (e) { console.error('[kusto]', e); }
	};

	// Store module-level reference for ES module exports below.
	_dd = dd as Record<string, any>;
	// Retain window bridge for external inline HTML onclick consumers
	// (queryBoxes-toolbar.ts, kw-query-section.ts). Will be removed when those callers are converted.
	_win.__kustoDropdown = dd;
})();

// ======================================================================
// ES module exports — TypeScript callers import these directly.
// ======================================================================

export function closeAllMenus(): void { _dd.closeAllMenus(); }
export function closeMenuDropdown(buttonId: string, menuId: string): void { _dd.closeMenuDropdown(buttonId, menuId); }
export function toggleMenuDropdown(opts: any): void { _dd.toggleMenuDropdown(opts); }
export function wireCloseOnFocusOut(buttonEl: HTMLElement, menuEl: HTMLElement): void { _dd.wireCloseOnFocusOut(buttonEl, menuEl); }
export function wireMenuInteractions(menuEl: HTMLElement): void { _dd.wireMenuInteractions(menuEl); }
export function syncSelectBackedDropdown(selectId: string): void { _dd.syncSelectBackedDropdown(selectId); }
export function selectFromMenu(selectId: string, keyEnc: string): void { _dd.selectFromMenu(selectId, keyEnc); }
export function toggleSelectMenu(selectId: string): void { _dd.toggleSelectMenu(selectId); }
export function renderSelectHtml(opts: any): string { return _dd.renderSelectHtml(opts); }
export function renderMenuDropdownHtml(opts: any): string { return _dd.renderMenuDropdownHtml(opts); }
export function renderMenuItemsHtml(items: any[], opts: any): string { return _dd.renderMenuItemsHtml(items, opts); }
export function renderCheckboxDropdownHtml(opts: any): string { return _dd.renderCheckboxDropdownHtml(opts); }
export function renderCheckboxItemsHtml(items: any[], opts: any): string { return _dd.renderCheckboxItemsHtml(items, opts); }
export function getCheckboxSelections(menuId: string): string[] { return _dd.getCheckboxSelections(menuId); }
export function updateCheckboxButtonText(buttonTextId: string, selectedValues: string[], placeholder: string): void { _dd.updateCheckboxButtonText(buttonTextId, selectedValues, placeholder); }
export function toggleCheckboxMenu(buttonId: string, menuId: string): void { _dd.toggleCheckboxMenu(buttonId, menuId); }
export function getChevronDownSvg(): string { return _dd.getChevronDownSvg(); }
