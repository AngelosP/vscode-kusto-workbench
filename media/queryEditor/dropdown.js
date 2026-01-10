// Shared dropdown rendering/helpers for the Kusto Query Editor webview.
//
// Goals:
// - Provide a reusable dropdown control with consistent styling (matching the native select styling)
// - Support optional per-item deletion (disabled by default)
//
// Note: The webview is built from concatenated global scripts (no bundler/modules).

(function initKustoDropdown() {
	if (!window.__kustoDropdown || typeof window.__kustoDropdown !== 'object') {
		window.__kustoDropdown = {};
	}

	// SVG chevron-down icon matching VS Code's style
	const chevronDownSvg = '<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M7.976 10.072l4.357-4.357.62.618L8.284 11h-.618L3 6.333l.619-.618 4.357 4.357z" fill="currentColor"/></svg>';

	// Export for use by other modules
	window.__kustoDropdown.getChevronDownSvg = function() { return chevronDownSvg; };

	const escAttr = (value) => {
		try {
			// Prefer the existing helper if available.
			if (typeof window.escapeHtml === 'function') {
				return window.escapeHtml(String(value ?? ''));
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
	// Use this for simple lists (clusters/databases/etc.).
	window.__kustoDropdown.renderSelectHtml = function (opts) {
		const o = (opts && typeof opts === 'object') ? opts : {};
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
	// Supports optional delete buttons per item (disabled by default).
	window.__kustoDropdown.renderMenuDropdownHtml = function (opts) {
		const o = (opts && typeof opts === 'object') ? opts : {};
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

		// Keep event.stopPropagation() behavior consistent with existing favorites implementation.
		const clickAttr = onToggle
			? (' onclick="' + escAttr(onToggle) + '; event.stopPropagation();"')
			: ' onclick="event.stopPropagation();"';

		return (
			'<div class="' + wrapperClasses + '"' + wrapperIdAttr + titleAttr + wrapperStyleAttr + '>' +
				(hasIcon ? ('<span class="select-icon" aria-hidden="true">' + iconSvg + '</span>') : '') +
				hiddenSelectHtml +
				'<button type="button" class="kusto-dropdown-btn"' + buttonIdAttr + clickAttr + ' aria-haspopup="listbox" aria-expanded="false">' +
					'<span class="kusto-dropdown-btn-text"' + textIdAttr + '>' + escAttr(placeholder || 'Select...') + '</span>' +
					'<span class="kusto-dropdown-btn-caret" aria-hidden="true">' + chevronDownSvg + '</span>' +
				'</button>' +
				'<div class="kusto-dropdown-menu"' + menuIdAttr + ' role="listbox" tabindex="-1" style="display:none;"></div>' +
			'</div>'
		);
	};

	// Renders items into a dropdown menu.
	// items: [{ key: string, html: string, ariaLabel?: string, enableDelete?: boolean, disabled?: boolean, selected?: boolean }]
	// opts: { dropdownId: string, onSelectJs: (keyEnc) => string, onDeleteJs?: (keyEnc) => string }
	window.__kustoDropdown.renderMenuItemsHtml = function (items, opts) {
		const list = Array.isArray(items) ? items : [];
		const o = (opts && typeof opts === 'object') ? opts : {};
		const dropdownId = String(o.dropdownId || '').trim();
		const onSelectJs = typeof o.onSelectJs === 'function' ? o.onSelectJs : null;
		const onDeleteJs = typeof o.onDeleteJs === 'function' ? o.onDeleteJs : null;
		const emptyHtml = String(o.emptyHtml || '').trim();
		const includeOtherRowHtml = String(o.includeOtherRowHtml || '').trim();

		if (!list.length) {
			return emptyHtml || '<div class="kusto-dropdown-empty">No items.</div>';
		}

		const trashSvg = (typeof window.__kustoGetTrashIconSvg === 'function') ? window.__kustoGetTrashIconSvg() : '';
		const rows = [];

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

	const getWrapperFromSelect = (selectEl) => {
		try {
			if (!selectEl) return null;
			if (typeof selectEl.closest === 'function') {
				return selectEl.closest('.kusto-dropdown-wrapper');
			}
		} catch { /* ignore */ }
		return null;
	};

	window.__kustoDropdown.closeAllMenus = function () {
		try {
			const menus = Array.from(document.querySelectorAll('.kusto-dropdown-menu, .kusto-favorites-menu, .qe-toolbar-overflow-menu'));
			for (const m of menus) {
				try { m.style.display = 'none'; } catch { /* ignore */ }
			}
			const buttons = Array.from(document.querySelectorAll('.kusto-dropdown-btn, .kusto-favorites-btn, .qe-toolbar-dropdown-btn, .qe-toolbar-overflow-btn'));
			for (const b of buttons) {
				try { b.setAttribute('aria-expanded', 'false'); } catch { /* ignore */ }
				try { b.classList && b.classList.remove('is-active'); } catch { /* ignore */ }
			}
		} catch { /* ignore */ }
	};

	// Generic close for a specific dropdown button/menu by element id.
	window.__kustoDropdown.closeMenuDropdown = function (buttonId, menuId) {
		const bid = String(buttonId || '').trim();
		const mid = String(menuId || '').trim();
		if (!bid || !mid) return;
		try {
			const menu = document.getElementById(mid);
			if (menu) menu.style.display = 'none';
		} catch { /* ignore */ }
		try {
			const btn = document.getElementById(bid);
			if (btn) {
				btn.setAttribute('aria-expanded', 'false');
				try { btn.classList && btn.classList.remove('is-active'); } catch { /* ignore */ }
			}
		} catch { /* ignore */ }
	};

	// Generic toggle for a dropdown button/menu by element id.
	// opts: { buttonId, menuId, beforeOpen?: () => void, afterOpen?: () => void }
	window.__kustoDropdown.toggleMenuDropdown = function (opts) {
		const o = (opts && typeof opts === 'object') ? opts : {};
		const bid = String(o.buttonId || '').trim();
		const mid = String(o.menuId || '').trim();
		if (!bid || !mid) return;
		const btn = document.getElementById(bid);
		const menu = document.getElementById(mid);
		if (!btn || !menu) return;
		try {
			if (btn.disabled) return;
		} catch { /* ignore */ }

		const wasOpen = String(menu.style.display || '') === 'block';
		try { if (typeof closeAllRunMenus === 'function') closeAllRunMenus(); } catch { /* ignore */ }
		try { window.__kustoDropdown.closeAllMenus(); } catch { /* ignore */ }

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
		} catch { /* ignore */ }

		// If menu uses position:fixed, calculate and set top/left from button rect.
		try {
			const computedPos = window.getComputedStyle(menu).position;
			if (computedPos === 'fixed') {
				const rect = btn.getBoundingClientRect();
				menu.style.left = rect.left + 'px';
				menu.style.top = rect.bottom + 'px';
				menu.style.minWidth = rect.width + 'px';
			}
		} catch { /* ignore */ }

		// Close the dropdown automatically if focus leaves the dropdown wrapper
		// (e.g., user pressed Tab, or clicked somewhere else).
		try {
			if (window.__kustoDropdown && typeof window.__kustoDropdown.wireCloseOnFocusOut === 'function') {
				window.__kustoDropdown.wireCloseOnFocusOut(btn, menu);
			}
		} catch { /* ignore */ }

		try {
			if (window.__kustoDropdown && typeof window.__kustoDropdown.wireMenuInteractions === 'function') {
				window.__kustoDropdown.wireMenuInteractions(menu);
			}
		} catch { /* ignore */ }

		try {
			if (typeof o.afterOpen === 'function') {
				o.afterOpen();
			}
		} catch { /* ignore */ }

		try { menu.focus(); } catch { /* ignore */ }
	};

	// Wire focus-out behavior to close a dropdown when it loses focus.
	// Safe to call multiple times.
	window.__kustoDropdown.wireCloseOnFocusOut = function (buttonEl, menuEl) {
		const btn = buttonEl;
		const menu = menuEl;
		if (!btn || !menu) return;

		let wrapper = null;
		try {
			if (typeof btn.closest === 'function') {
				wrapper = btn.closest('.kusto-dropdown-wrapper') || btn.closest('.select-wrapper');
			}
		} catch { /* ignore */ }
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
		} catch { /* ignore */ }

		// Use focusout (bubbles) so we can detect focus moving anywhere outside the wrapper.
		wrapper.addEventListener('focusout', () => {
			try {
				// Defer until the browser has updated document.activeElement.
				setTimeout(() => {
					try {
						const active = document.activeElement;
						if (active && wrapper.contains(active)) {
							return;
						}
						// Only close if this dropdown is currently open.
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

	const getMenuItems = (menuEl) => {
		try {
			if (!menuEl) return [];
			const all = Array.from(menuEl.querySelectorAll('.kusto-dropdown-item[role="option"], .kusto-favorites-item[role="option"]'));
			return all.filter((el) => {
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

	const setActiveMenuItem = (menuEl, itemEl) => {
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
				if (idx >= 0 && menuEl.dataset) {
					menuEl.dataset.kustoActiveIndex = String(idx);
				}
			} catch { /* ignore */ }
		} catch { /* ignore */ }
	};

	const getInitialActiveItem = (menuEl) => {
		const items = getMenuItems(menuEl);
		if (!items.length) return null;
		// Prefer selected item if present.
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

	// Wires keyboard navigation (ArrowUp/ArrowDown/Enter/Escape) and hover/focus active state.
	// Safe to call multiple times; it will only attach listeners once per menu.
	window.__kustoDropdown.wireMenuInteractions = function (menuEl) {
		if (!menuEl) return;
		try {
			if (menuEl.dataset && menuEl.dataset.kustoMenuWired === '1') {
				// Still refresh initial active item if nothing is active.
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
			if (menuEl.dataset) {
				menuEl.dataset.kustoMenuWired = '1';
			}
		} catch { /* ignore */ }

		// Ensure menu itself can receive focus.
		try { menuEl.setAttribute('tabindex', '-1'); } catch { /* ignore */ }

		// Hover/focus drives active item.
		try {
			menuEl.addEventListener('mouseenter', (ev) => {
				try {
					const target = ev && ev.target ? ev.target.closest('.kusto-dropdown-item[role="option"], .kusto-favorites-item[role="option"]') : null;
					if (target) setActiveMenuItem(menuEl, target);
				} catch { /* ignore */ }
			}, true);
			menuEl.addEventListener('focusin', (ev) => {
				try {
					const target = ev && ev.target ? ev.target.closest('.kusto-dropdown-item[role="option"], .kusto-favorites-item[role="option"]') : null;
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
				if (menuEl.dataset && typeof menuEl.dataset.kustoActiveIndex === 'string') {
					idx = parseInt(menuEl.dataset.kustoActiveIndex, 10);
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
					try { window.__kustoDropdown && window.__kustoDropdown.closeAllMenus && window.__kustoDropdown.closeAllMenus(); } catch { /* ignore */ }
					break;
				}
				default:
					break;
			}
		});

		// Initialize active item.
		try {
			const initial = getInitialActiveItem(menuEl);
			if (initial) setActiveMenuItem(menuEl, initial);
		} catch { /* ignore */ }
	};

	// Syncs a menu dropdown from its hidden backing <select>.
	// selectId is the DOM id of the <select>.
	window.__kustoDropdown.syncSelectBackedDropdown = function (selectId) {
		const id = String(selectId || '').trim();
		if (!id) return;
		const select = document.getElementById(id);
		if (!select) return;

		const wrapper = getWrapperFromSelect(select);
		if (!wrapper) return;
		const menu = wrapper.querySelector('.kusto-dropdown-menu');
		const btn = wrapper.querySelector('.kusto-dropdown-btn');
		const btnText = wrapper.querySelector('.kusto-dropdown-btn-text');
		if (!menu || !btn || !btnText) return;

		// Keep disabled state in sync.
		try {
			btn.disabled = !!select.disabled;
			btn.setAttribute('aria-disabled', select.disabled ? 'true' : 'false');
		} catch { /* ignore */ }

		let placeholderText = '';
		try {
			const ph = select.querySelector('option[value=""]');
			if (ph && ph.disabled) {
				placeholderText = String(ph.textContent || '').trim();
			}
		} catch { /* ignore */ }

		let selectedLabel = '';
		try {
			const opt = select.selectedOptions && select.selectedOptions.length ? select.selectedOptions[0] : null;
			if (opt && String(opt.value || '').trim()) {
				selectedLabel = String(opt.textContent || '').trim();
			}
		} catch { /* ignore */ }

		btnText.textContent = selectedLabel || placeholderText || 'Select...';
		// Tooltip shows current selection (useful when label is truncated).
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

		// Rebuild menu items from options.
		const items = [];
		try {
			const opts = Array.from(select.options || []);
			for (const o of opts) {
				if (!o) continue;
				const val = String(o.value || '');
				const label = String(o.textContent || '').trim();
				// Skip the placeholder option.
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
			menu.innerHTML = window.__kustoDropdown.renderMenuItemsHtml(items, {
				dropdownId: id,
				onSelectJs: (keyEnc) => "window.__kustoDropdown.selectFromMenu('" + id + "', '" + keyEnc + "')"
			});
		} catch {
			// Fallback: basic rendering.
			menu.innerHTML = items
				.map((it) => '<div class="kusto-dropdown-item" role="option" tabindex="-1" data-kusto-key="' + escAttr(it.key) + '" onclick="window.__kustoDropdown.selectFromMenu(\'' + escAttr(id) + '\', \'' + escAttr(it.key) + '\');">' + it.html + '</div>')
				.join('');
		}
	};

	// Select an option (by encoded value) from the menu, updating the hidden <select>.
	window.__kustoDropdown.selectFromMenu = function (selectId, keyEnc) {
		const id = String(selectId || '').trim();
		if (!id) return;
		const select = document.getElementById(id);
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
					select.onchange();
				}
			} catch { /* ignore */ }
		}
		// The onchange handler may have mutated selection/disabled state; re-sync.
		try { window.__kustoDropdown.syncSelectBackedDropdown(id); } catch { /* ignore */ }
		try { window.__kustoDropdown.closeAllMenus(); } catch { /* ignore */ }
	};

	// Toggle the menu dropdown that is backed by a hidden <select>.
	window.__kustoDropdown.toggleSelectMenu = function (selectId) {
		const id = String(selectId || '').trim();
		if (!id) return;
		const select = document.getElementById(id);
		if (!select) return;
		const wrapper = getWrapperFromSelect(select);
		if (!wrapper) return;
		const menu = wrapper.querySelector('.kusto-dropdown-menu');
		const btn = wrapper.querySelector('.kusto-dropdown-btn');
		if (!menu || !btn) return;
		if (btn.disabled) return;

		try {
			window.__kustoDropdown.toggleMenuDropdown({
				buttonId: btn.id,
				menuId: menu.id,
				beforeOpen: () => {
					try { window.__kustoDropdown.syncSelectBackedDropdown(id); } catch { /* ignore */ }
				}
			});
		} catch {
			// Fallback: older behavior
			try { window.__kustoDropdown.syncSelectBackedDropdown(id); } catch { /* ignore */ }
			menu.style.display = 'block';
			btn.setAttribute('aria-expanded', 'true');
			try { menu.focus(); } catch { /* ignore */ }
		}
	};

	// =====================================
	// Checkbox Multi-Select Dropdown
	// =====================================

	// Renders a button+menu dropdown with checkboxes for multi-select.
	// opts: { wrapperId, buttonId, buttonTextId, menuId, placeholder, onToggle }
	window.__kustoDropdown.renderCheckboxDropdownHtml = function (opts) {
		const o = (opts && typeof opts === 'object') ? opts : {};
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

	// Renders checkbox items into a dropdown menu.
	// items: [{ key: string, label: string, checked?: boolean, disabled?: boolean }]
	// opts: { dropdownId: string, onChangeJs: string (function name to call with dropdownId) }
	window.__kustoDropdown.renderCheckboxItemsHtml = function (items, opts) {
		const list = Array.isArray(items) ? items : [];
		const o = (opts && typeof opts === 'object') ? opts : {};
		const dropdownId = String(o.dropdownId || '').trim();
		const onChangeJs = String(o.onChangeJs || '').trim();
		const emptyHtml = String(o.emptyHtml || '').trim();

		if (!list.length) {
			return emptyHtml || '<div class="kusto-dropdown-empty">No items.</div>';
		}

		const rows = [];
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

	// Get all selected values from a checkbox dropdown menu.
	window.__kustoDropdown.getCheckboxSelections = function (menuId) {
		const menu = document.getElementById(menuId);
		if (!menu) return [];
		const checkboxes = Array.from(menu.querySelectorAll('input[type="checkbox"]:checked'));
		return checkboxes.map(cb => cb.value);
	};

	// Update the button text for a checkbox dropdown to show selected items.
	window.__kustoDropdown.updateCheckboxButtonText = function (buttonTextId, selectedValues, placeholder) {
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

	// Toggle a checkbox dropdown.
	window.__kustoDropdown.toggleCheckboxMenu = function (buttonId, menuId) {
		const btn = document.getElementById(buttonId);
		const menu = document.getElementById(menuId);
		if (!btn || !menu) return;
		if (btn.disabled) return;

		const wasOpen = String(menu.style.display || '') === 'block';
		try { window.__kustoDropdown.closeAllMenus(); } catch { /* ignore */ }

		if (wasOpen) return;

		menu.style.display = 'block';
		btn.setAttribute('aria-expanded', 'true');
		try { btn.classList && btn.classList.add('is-active'); } catch { /* ignore */ }

		// If menu uses position:fixed, calculate and set top/left from button rect.
		try {
			const computedPos = window.getComputedStyle(menu).position;
			if (computedPos === 'fixed') {
				const rect = btn.getBoundingClientRect();
				menu.style.left = rect.left + 'px';
				menu.style.top = rect.bottom + 'px';
				menu.style.minWidth = rect.width + 'px';
			}
		} catch { /* ignore */ }

		// Prevent clicks inside the menu from closing it via global document click handler.
		try {
			if (!menu.dataset.kustoStopPropagationWired) {
				menu.addEventListener('click', (ev) => {
					try { ev.stopPropagation(); } catch { /* ignore */ }
				});
				menu.dataset.kustoStopPropagationWired = '1';
			}
		} catch { /* ignore */ }

		// Wire close on focus out.
		try {
			window.__kustoDropdown.wireCloseOnFocusOut(btn, menu);
		} catch { /* ignore */ }

		try { menu.focus(); } catch { /* ignore */ }
	};
})();
