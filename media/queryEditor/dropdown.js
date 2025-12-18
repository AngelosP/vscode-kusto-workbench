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
					'<span class="kusto-dropdown-btn-caret" aria-hidden="true">▾</span>' +
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
						? ('<button type="button" class="kusto-dropdown-trash" title="Remove" aria-label="Remove" data-kusto-key="' + escAttr(keyEnc) + '" onclick="' + escAttr(onDeleteJs(keyEnc)) + '; event.stopPropagation();">' + trashSvg + '</button>')
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
			const menus = Array.from(document.querySelectorAll('.kusto-dropdown-menu, .kusto-favorites-menu'));
			for (const m of menus) {
				try { m.style.display = 'none'; } catch { /* ignore */ }
			}
			const buttons = Array.from(document.querySelectorAll('.kusto-dropdown-btn, .kusto-favorites-btn'));
			for (const b of buttons) {
				try { b.setAttribute('aria-expanded', 'false'); } catch { /* ignore */ }
			}
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
				items.push({
					key: encodeURIComponent(val),
					html: escAttr(label || val),
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

		const wasOpen = menu.style.display === 'block';
		try {
			if (typeof closeAllRunMenus === 'function') closeAllRunMenus();
		} catch { /* ignore */ }
		try {
			if (typeof closeAllFavoritesDropdowns === 'function') closeAllFavoritesDropdowns();
		} catch { /* ignore */ }
		try { window.__kustoDropdown.closeAllMenus(); } catch { /* ignore */ }

		if (wasOpen) {
			return;
		}
		try { window.__kustoDropdown.syncSelectBackedDropdown(id); } catch { /* ignore */ }
		menu.style.display = 'block';
		btn.setAttribute('aria-expanded', 'true');
		try { menu.focus(); } catch { /* ignore */ }
	};
})();
