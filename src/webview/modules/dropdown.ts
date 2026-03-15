// Dropdown module — converted from legacy/dropdown.js
// Window bridge exports at bottom for remaining legacy callers.
export {};

const _win = window;

(function initKustoDropdown() {
	if (!_win.__kustoDropdown || typeof _win.__kustoDropdown !== 'object') {
		_win.__kustoDropdown = {};
	}
	const dd = _win.__kustoDropdown as Record<string, unknown>;

	// SVG chevron-down icon matching VS Code's style
	const chevronDownSvg = '<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M7.976 10.072l4.357-4.357.62.618L8.284 11h-.618L3 6.333l.619-.618 4.357 4.357z" fill="currentColor"/></svg>';

	// Export for use by other modules
	dd.getChevronDownSvg = function() { return chevronDownSvg; };

	const escAttr = (value: unknown): string => {
		try {
			// Prefer the existing helper if available.
			if (typeof (_win.escapeHtml) === 'function') {
				return (_win.escapeHtml as any)(String(value ?? ''));
			}
		} catch { /* ignore */ }
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

		const trashSvg = (typeof (_win.__kustoGetTrashIconSvg) === 'function') ? (_win.__kustoGetTrashIconSvg as any)() : '';
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
		} catch { /* ignore */ }
		return null;
	};

	dd.closeAllMenus = function () {
		try {
			const menus = Array.from(document.querySelectorAll('.kusto-dropdown-menu, .kusto-favorites-menu, .qe-toolbar-overflow-menu, .md-mode-dropdown-menu, .section-mode-dropdown-menu, .add-controls-dropdown-menu'));
			for (const m of menus) {
				try { (m as HTMLElement).style.display = 'none'; } catch { /* ignore */ }
			}
			const buttons = Array.from(document.querySelectorAll('.kusto-dropdown-btn, .kusto-favorites-btn, .qe-toolbar-dropdown-btn, .qe-toolbar-overflow-btn, .md-mode-dropdown-btn, .section-mode-dropdown-btn, .add-controls-dropdown-btn'));
			for (const b of buttons) {
				try { b.setAttribute('aria-expanded', 'false'); } catch { /* ignore */ }
				try { b.classList && b.classList.remove('is-active'); } catch { /* ignore */ }
			}
		} catch { /* ignore */ }
	};

	dd.closeMenuDropdown = function (buttonId: string, menuId: string) {
		const bid = String(buttonId || '').trim();
		const mid = String(menuId || '').trim();
		if (!bid || !mid) return;
		try {
			const menu = document.getElementById(mid);
			if (menu) (menu as HTMLElement).style.display = 'none';
		} catch { /* ignore */ }
		try {
			const btn = document.getElementById(bid);
			if (btn) {
				btn.setAttribute('aria-expanded', 'false');
				try { btn.classList && btn.classList.remove('is-active'); } catch { /* ignore */ }
			}
		} catch { /* ignore */ }
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
		} catch { /* ignore */ }

		const wasOpen = String(menu.style.display || '') === 'block';
		try { if (typeof (_win.closeAllRunMenus) === 'function') (_win.closeAllRunMenus as any)(); } catch { /* ignore */ }
		try { (dd.closeAllMenus as any)(); } catch { /* ignore */ }

		if (wasOpen) {
			return;
		}

		try {
			if (typeof o.beforeOpen === 'function') {
				o.beforeOpen();
			}
		} catch { /* ignore */ }

		try {
			menu.style.display = 'block';
			btn.setAttribute('aria-expanded', 'true');
			try { btn.classList && btn.classList.add('is-active'); } catch { /* ignore */ }
			// Capture scroll position for threshold-based dismiss (see queryBoxes-toolbar.ts scroll handler)
			try { _win.__kustoToolbarScrollAtOpen = document.documentElement.scrollTop || document.body.scrollTop || 0; } catch { /* ignore */ }
		} catch { /* ignore */ }

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
			} catch { /* ignore */ }
		};

		try {
			const computedPos = window.getComputedStyle(menu).position;
			if (computedPos === 'fixed') {
				positionFixedMenuUnderButton(btn, menu);
			}
		} catch { /* ignore */ }

		try {
			if (dd && typeof (dd.wireCloseOnFocusOut) === 'function') {
				(dd.wireCloseOnFocusOut as any)(btn, menu);
			}
		} catch { /* ignore */ }

		try {
			if (dd && typeof (dd.wireMenuInteractions) === 'function') {
				(dd.wireMenuInteractions as any)(menu);
			}
		} catch { /* ignore */ }

		try {
			if (typeof o.afterOpen === 'function') {
				o.afterOpen();
			}
		} catch { /* ignore */ }

		try { menu.focus(); } catch { /* ignore */ }
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
		} catch { /* ignore */ }
		if (!wrapper) {
			try { wrapper = menu.parentElement || null; } catch { wrapper = null; }
		}
		if (!wrapper) return;

		try {
			if ((wrapper as any).dataset && (wrapper as any).dataset.kustoCloseOnBlurWired === '1') {
				return;
			}
			if ((wrapper as any).dataset) {
				(wrapper as any).dataset.kustoCloseOnBlurWired = '1';
			}
		} catch { /* ignore */ }

		wrapper.addEventListener('focusout', () => {
			try {
				setTimeout(() => {
					try {
						const active = document.activeElement;
						if (active && wrapper!.contains(active)) {
							return;
						}
						if (String(menu.style.display || '') === 'block') {
							try { menu.style.display = 'none'; } catch { /* ignore */ }
							try { btn.setAttribute('aria-expanded', 'false'); } catch { /* ignore */ }
							try { btn.classList && btn.classList.remove('is-active'); } catch { /* ignore */ }
						}
					} catch { /* ignore */ }
				}, 0);
			} catch { /* ignore */ }
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
				try { it.classList.remove('is-active'); } catch { /* ignore */ }
			}
			try { itemEl.classList.add('is-active'); } catch { /* ignore */ }
			try { itemEl.focus(); } catch { /* ignore */ }
			try { itemEl.scrollIntoView({ block: 'nearest' }); } catch { /* ignore */ }
			try {
				const idx = items.indexOf(itemEl);
				if (idx >= 0 && (menuEl as any).dataset) {
					(menuEl as any).dataset.kustoActiveIndex = String(idx);
				}
			} catch { /* ignore */ }
		} catch { /* ignore */ }
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
				} catch { /* ignore */ }
			}
		} catch { /* ignore */ }
		return items[0];
	};

	dd.wireMenuInteractions = function (menuEl: HTMLElement) {
		if (!menuEl) return;
		try {
			if ((menuEl as any).dataset && (menuEl as any).dataset.kustoMenuWired === '1') {
				const items = getMenuItems(menuEl);
				const hasActive = items.some((it) => it.classList && it.classList.contains('is-active'));
				if (!hasActive) {
					const initial = getInitialActiveItem(menuEl);
					if (initial) setActiveMenuItem(menuEl, initial);
				}
				return;
			}
		} catch { /* ignore */ }

		try {
			if ((menuEl as any).dataset) {
				(menuEl as any).dataset.kustoMenuWired = '1';
			}
		} catch { /* ignore */ }

		try { menuEl.setAttribute('tabindex', '-1'); } catch { /* ignore */ }

		try {
			menuEl.addEventListener('mouseenter', (ev) => {
				try {
					const target = ev && ev.target ? (ev.target as HTMLElement).closest('.kusto-dropdown-item[role="option"], .kusto-favorites-item[role="option"]') as HTMLElement | null : null;
					if (target) setActiveMenuItem(menuEl, target);
				} catch { /* ignore */ }
			}, true);
			menuEl.addEventListener('focusin', (ev) => {
				try {
					const target = ev && ev.target ? (ev.target as HTMLElement).closest('.kusto-dropdown-item[role="option"], .kusto-favorites-item[role="option"]') as HTMLElement | null : null;
					if (target) setActiveMenuItem(menuEl, target);
				} catch { /* ignore */ }
			}, true);
		} catch { /* ignore */ }

		menuEl.addEventListener('keydown', (ev) => {
			const e = ev || window.event;
			const key = String(e && e.key ? e.key : '');
			if (!key) return;
			const items = getMenuItems(menuEl);
			if (!items.length) return;

			let idx = -1;
			try {
				if ((menuEl as any).dataset && typeof (menuEl as any).dataset.kustoActiveIndex === 'string') {
					idx = parseInt((menuEl as any).dataset.kustoActiveIndex, 10);
				}
			} catch { /* ignore */ }
			if (!(idx >= 0 && idx < items.length)) {
				idx = Math.max(0, items.findIndex((it) => it.classList && it.classList.contains('is-active')));
				if (idx < 0) idx = 0;
			}

			const prevent = () => {
				try { e.preventDefault(); } catch { /* ignore */ }
				try { e.stopPropagation(); } catch { /* ignore */ }
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
					try { active && active.click && active.click(); } catch { /* ignore */ }
					break;
				}
				case 'Escape': {
					prevent();
					try { dd && (dd.closeAllMenus as any) && (dd.closeAllMenus as any)(); } catch { /* ignore */ }
					break;
				}
				default:
					break;
			}
		});

		try {
			const initial = getInitialActiveItem(menuEl);
			if (initial) setActiveMenuItem(menuEl, initial);
		} catch { /* ignore */ }
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
		} catch { /* ignore */ }

		let placeholderText = '';
		try {
			const ph = select.querySelector('option[value=""]') as HTMLOptionElement | null;
			if (ph && ph.disabled) {
				placeholderText = String(ph.textContent || '').trim();
			}
		} catch { /* ignore */ }

		let selectedLabel = '';
		try {
			const opt = select.selectedOptions && select.selectedOptions.length ? select.selectedOptions[0] : null;
			if (opt) {
				const shortLabel = opt.getAttribute('data-short-label');
				selectedLabel = String(shortLabel || opt.textContent || '').trim();
			}
		} catch { /* ignore */ }

		btnText.textContent = selectedLabel || placeholderText || 'Select...';
		try {
			btn.title = selectedLabel || '';
		} catch { /* ignore */ }

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
		} catch { /* ignore */ }

		if (!items.length) {
			menu.innerHTML = '<div class="kusto-dropdown-empty">No items.</div>';
			return;
		}

		try {
			menu.innerHTML = (dd.renderMenuItemsHtml as any)(items, {
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
		} catch { /* ignore */ }
		try {
			select.dispatchEvent(new Event('change', { bubbles: true }));
		} catch {
			try {
				if (typeof select.onchange === 'function') {
					(select as any).onchange();
				}
			} catch { /* ignore */ }
		}
		try { (dd.syncSelectBackedDropdown as any)(id); } catch { /* ignore */ }
		try { (dd.closeAllMenus as any)(); } catch { /* ignore */ }
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
			(dd.toggleMenuDropdown as any)({
				buttonId: btn.id,
				menuId: menu.id,
				beforeOpen: () => {
					try { (dd.syncSelectBackedDropdown as any)(id); } catch { /* ignore */ }
				}
			});
		} catch {
			try { (dd.syncSelectBackedDropdown as any)(id); } catch { /* ignore */ }
			menu.style.display = 'block';
			btn.setAttribute('aria-expanded', 'true');
			try { menu.focus(); } catch { /* ignore */ }
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
		try { (dd.closeAllMenus as any)(); } catch { /* ignore */ }

		if (wasOpen) return;

		menu.style.display = 'block';
		btn.setAttribute('aria-expanded', 'true');
		try { btn.classList && btn.classList.add('is-active'); } catch { /* ignore */ }

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
				} catch { /* ignore */ }
			}
		} catch { /* ignore */ }

		try {
			if (!(menu as any).dataset.kustoStopPropagationWired) {
				menu.addEventListener('click', (ev) => {
					try { ev.stopPropagation(); } catch { /* ignore */ }
				});
				(menu as any).dataset.kustoStopPropagationWired = '1';
			}
		} catch { /* ignore */ }

		try {
			(dd.wireCloseOnFocusOut as any)(btn, menu);
		} catch { /* ignore */ }

		try { menu.focus(); } catch { /* ignore */ }
	};
})();
