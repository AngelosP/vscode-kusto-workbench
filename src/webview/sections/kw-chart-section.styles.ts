import { css } from 'lit';

export const styles = css`
		*, *::before, *::after { box-sizing: border-box; }

		:host {
			display: block;
			border: 1px solid var(--vscode-input-border, var(--vscode-widget-border, var(--vscode-panel-border, rgba(128,128,128,0.25))));
			border-radius: 0;
			margin-bottom: 16px;
			background: var(--vscode-editor-background);
			box-shadow: 0 2px 10px var(--vscode-widget-shadow);
			padding-bottom: 0;
			--kusto-chart-label-width: 54px;
		}
		:host(.is-collapsed) {
			margin-bottom: 26px;
		}
		:host(.is-collapsed) .section-root {
			padding-bottom: 4px;
		}
		:host(.is-collapsed) .chart-wrapper {
			display: none !important;
		}
		:host(.is-collapsed) .mode-btn,
		:host(.is-collapsed) .chart-mode-buttons {
			display: none !important;
		}

		.section-root {
			padding: 12px;
		}

		/* ── Mode buttons (slotted into shell header-buttons) ── */

		.chart-mode-buttons {
			display: inline-flex;
			gap: 2px;
			align-items: center;
		}

		.unified-btn-secondary {
			background: transparent;
			color: var(--vscode-foreground);
			border: 1px solid transparent;
			border-radius: 4px;
			padding: 4px 8px;
			font-size: 12px;
			cursor: pointer;
			display: inline-flex;
			align-items: center;
			justify-content: center;
			gap: 4px;
			white-space: nowrap;
			line-height: 1.4;
		}
		.unified-btn-secondary:hover:not(:disabled) {
			background: var(--vscode-list-hoverBackground);
		}

		.unified-btn-icon-only {
			width: 28px;
			height: 28px;
			min-width: 28px;
			padding: 0;
		}
		.unified-btn-icon-only svg { display: block; }

		.md-tab {
			background: transparent;
			border: 1px solid transparent;
			color: var(--vscode-foreground);
			cursor: pointer;
			padding: 0;
			width: 28px;
			height: 28px;
			border-radius: 4px;
			display: inline-flex;
			align-items: center;
			justify-content: center;
			line-height: 0;
			outline: none;
		}
		.md-tab svg { display: block; }
		.md-tab:hover { background: var(--vscode-list-hoverBackground); }
		.md-tab.is-active {
			background: var(--vscode-toolbar-activeBackground, var(--vscode-actionBar-toggledBackground, rgba(128, 128, 128, 0.25)));
			color: var(--vscode-foreground);
		}

		.md-mode-btn {
			font-size: 12px;
			width: auto;
			padding: 4px 8px;
			border: 1px solid transparent;
		}
		.md-mode-btn.is-active {
			background: var(--vscode-toolbar-activeBackground, var(--vscode-actionBar-toggledBackground, rgba(128, 128, 128, 0.25)));
			color: var(--vscode-foreground);
		}

		/* ── Chart wrapper ───────────────────────────────────────────────── */

		.chart-wrapper {
			border: none;
			overflow: visible;
			height: auto;
			min-height: 0;
		}

		.chart-edit-mode {
			display: flex;
			flex-direction: column;
			height: 100%;
			min-height: 0;
			background: transparent;
			color: var(--vscode-foreground);
			overflow: visible;
		}

		.chart-preview-mode {
			display: flex;
			flex-direction: column;
			height: 100%;
			min-height: 0;
			background: transparent;
			color: var(--vscode-foreground);
			overflow: visible;
		}

		.chart-builder {
			display: flex;
			flex-direction: column;
			gap: 0;
			padding: 0;
			min-height: 0;
			height: auto;
			background: transparent;
			color: var(--vscode-foreground);
			overflow: visible;
		}

		/* ── Controls panel ──────────────────────────────────────────────── */

		.chart-controls {
			display: flex;
			flex-direction: column;
			gap: 0;
			overflow: visible;
			flex-shrink: 0;
			background: var(--vscode-editor-background);
			position: relative;
			left: -12px;
			width: calc(100% + 24px);
			padding: 16px 16px 0 16px;
			margin-bottom: 20px;
		}
		.chart-controls::before {
			content: '';
			position: absolute;
			inset: 0;
			pointer-events: none;
			background: rgba(0, 0, 0, 0.035);
		}
		:host-context(body.vscode-dark) .chart-controls::before,
		:host-context(body.vscode-high-contrast) .chart-controls::before {
			background: rgba(255, 255, 255, 0.04);
		}

		.chart-controls-scroll {
			overflow-x: auto;
			overflow-y: visible;
			padding-bottom: 16px;
			scrollbar-width: thin;
			scrollbar-color: var(--vscode-scrollbarSlider-background) transparent;
			/* Needs position:relative so it paints ABOVE the ::before overlay
			   (which is position:absolute). Without this, the overlay sits on top
			   of non-positioned children, tinting dropdown backgrounds. */
			position: relative;
		}
		.chart-controls-scroll::-webkit-scrollbar { height: 8px; background: transparent; }
		.chart-controls-scroll::-webkit-scrollbar-track { background: transparent; }
		.chart-controls-scroll::-webkit-scrollbar-thumb { background: var(--vscode-scrollbarSlider-background); }
		.chart-controls-scroll::-webkit-scrollbar-thumb:hover { background: var(--vscode-scrollbarSlider-hoverBackground); }

		.chart-controls-scroll-content {
			min-width: 480px;
			display: flex;
			flex-direction: column;
			gap: 14px;
		}

		/* ── Chart type picker ────────────────────────────────────────── */

		.chart-row {
			display: flex;
			align-items: center;
			gap: 10px;
			flex-wrap: nowrap;
		}

		.chart-row > label {
			flex: 0 0 var(--kusto-chart-label-width);
			min-width: var(--kusto-chart-label-width);
			font-size: 12px;
			white-space: nowrap;
		}

		.chart-type-picker {
			display: inline-flex;
			gap: 4px;
			flex-wrap: wrap;
		}

		.chart-type-btn {
			display: inline-flex;
			flex-direction: column;
			align-items: center;
			gap: 2px;
			padding: 4px 8px;
			border: 1px solid transparent;
			border-radius: 4px;
			background: transparent;
			color: var(--vscode-foreground);
			cursor: pointer;
			font-size: 10px;
			line-height: 1.2;
			min-width: 48px;
			white-space: nowrap;
		}
		.chart-type-btn svg {
			width: 24px;
			height: 24px;
		}
		.chart-type-btn:hover { background: var(--vscode-toolbar-hoverBackground); }
		.chart-type-btn.is-active {
			background: var(--vscode-toolbar-activeBackground, var(--vscode-actionBar-toggledBackground, rgba(128, 128, 128, 0.25)));
			color: var(--vscode-foreground);
			border-color: transparent;
		}

		/* ── Data source & column selects ─────────────────────────────── */

		.chart-select {
			flex: 1 1 auto;
			min-width: 140px;
			color: var(--vscode-dropdown-foreground);
			border: 1px solid var(--vscode-dropdown-border);
			border-radius: 0;
			padding: 4px 24px 4px 8px;
			font-size: 12px;
			font-family: inherit;
			outline: none;
			height: 28px;
			appearance: none;
			-webkit-appearance: none;
			cursor: pointer;
			/* Separate properties — combined shorthand with CSS var breaks on <select> in Chromium */
			background-color: var(--vscode-dropdown-background);
			background-image: url("data:image/svg+xml,%3Csvg width='16' height='16' viewBox='0 0 16 16' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath fill-rule='evenodd' clip-rule='evenodd' d='M7.976 10.072l4.357-4.357.62.618L8.284 11h-.618L3 6.333l.619-.618 4.357 4.357z' fill='%23858585'/%3E%3C/svg%3E");
			background-repeat: no-repeat;
			background-position: right 4px center;
			background-size: 16px 16px;
		}
		.chart-select:focus { border-color: var(--vscode-focusBorder); }

		/* ── Dropdown button (for Y, Tooltip multi-selects) ────────────── */

		.dropdown-btn {
			width: 100%;
			min-width: 0;
			color: var(--vscode-dropdown-foreground);
			border: 1px solid var(--vscode-dropdown-border);
			border-radius: 0;
			padding: 4px 24px 4px 8px;
			font-size: 12px;
			font-family: inherit;
			outline: none;
			height: 28px;
			cursor: pointer;
			text-align: left;
			position: relative;
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
			background-color: var(--vscode-dropdown-background);
			background-image: url("data:image/svg+xml,%3Csvg width='16' height='16' viewBox='0 0 16 16' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath fill-rule='evenodd' clip-rule='evenodd' d='M7.976 10.072l4.357-4.357.62.618L8.284 11h-.618L3 6.333l.619-.618 4.357 4.357z' fill='%23858585'/%3E%3C/svg%3E");
			background-repeat: no-repeat;
			background-position: right 4px center;
			background-size: 16px 16px;
		}
		.dropdown-btn:hover { border-color: var(--vscode-focusBorder); }

		.dropdown-wrapper {
			position: relative;
			flex: 1 1 auto;
			min-width: 0;
		}

		.dropdown-menu {
			position: fixed;
			z-index: 10000;
			min-width: 180px;
			background: var(--vscode-menu-background, var(--vscode-editor-background));
			color: var(--vscode-menu-foreground, var(--vscode-foreground));
			border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border));
			border-radius: 0;
			padding: 4px 0;
			box-shadow: 0 4px 12px rgba(0,0,0,.35);
			max-height: 200px;
			overflow-y: auto;
			scrollbar-width: thin;
		}

		.dropdown-item {
			display: flex;
			align-items: center;
			gap: 6px;
			padding: 4px 8px;
			cursor: pointer;
			font-size: 12px;
			white-space: nowrap;
		}
		.dropdown-item:hover { background: var(--vscode-list-hoverBackground); }

		.dropdown-item input[type="checkbox"] {
			width: 14px;
			height: 14px;
			margin: 0;
			cursor: pointer;
		}

		/* ── Column mapping grids ─────────────────────────────────────── */

		.chart-mapping {
			margin-top: 0;
		}

		.chart-mapping-grid {
			display: grid;
			grid-template-columns: minmax(140px, 1fr) minmax(140px, 1fr) minmax(140px, 1fr);
			column-gap: 24px;
			row-gap: 14px;
			align-items: center;
		}

		.chart-field-group {
			display: flex;
			align-items: center;
			gap: 10px;
			width: 100%;
			min-width: 0;
		}

		.chart-field-group > label {
			flex: 0 0 var(--kusto-chart-label-width);
			min-width: var(--kusto-chart-label-width);
			font-size: 12px;
			white-space: nowrap;
		}

		.chart-field-group .chart-select {
			flex: 1 1 auto;
			min-width: 0;
		}

		/* ── Legend inline ────────────────────────────────────────────── */

		.chart-legend-inline {
			display: flex;
			align-items: center;
			gap: 6px;
			width: 100%;
			min-width: 0;
		}
		.chart-legend-inline .chart-select {
			flex: 1 1 auto;
			min-width: 0;
		}
		.chart-legend-pos-btn {
			flex-shrink: 0;
			width: 30px;
			height: 30px;
			padding: 0;
			display: inline-flex;
			align-items: center;
			justify-content: center;
		}

		/* ── Labels toggle ────────────────────────────────────────────── */

		.chart-labels-toggle {
			display: inline-flex;
			align-items: center;
			gap: 10px;
			cursor: pointer;
			user-select: none;
			width: 100%;
		}
		.chart-labels-toggle-text {
			flex: 0 0 var(--kusto-chart-label-width);
			min-width: var(--kusto-chart-label-width);
			font-size: 12px;
			white-space: nowrap;
			opacity: 0.85;
			color: var(--vscode-foreground);
		}
		.chart-labels-toggle-track {
			position: relative;
			width: 36px;
			height: 20px;
			background: var(--vscode-input-background);
			border: 1px solid var(--vscode-input-border, var(--vscode-contrastBorder, transparent));
			border-radius: 10px;
			transition: background 0.15s ease, border-color 0.15s ease;
		}
		.chart-labels-toggle-thumb {
			position: absolute;
			top: 2px;
			left: 2px;
			width: 14px;
			height: 14px;
			background: var(--vscode-foreground);
			border-radius: 50%;
			transition: transform 0.15s ease, background 0.15s ease;
			opacity: 0.6;
		}
		.chart-labels-toggle.is-active .chart-labels-toggle-track {
			background: var(--vscode-button-background);
			border-color: var(--vscode-button-background);
		}
		.chart-labels-toggle.is-active .chart-labels-toggle-thumb {
			transform: translateX(16px);
			background: var(--vscode-button-foreground);
			opacity: 1;
		}
		.chart-labels-toggle:hover .chart-labels-toggle-track {
			border-color: var(--vscode-focusBorder);
		}

		.chart-grid-spacer { display: block; }

		/* ── Clickable axis labels ─────────────────────────────────── */

		.axis-label-clickable {
			cursor: pointer;
			text-decoration: none;
			transition: text-decoration 0.1s ease;
		}
		.axis-label-clickable:hover {
			text-decoration: underline;
			color: var(--vscode-textLink-foreground, var(--vscode-foreground));
		}
		.axis-label-clickable.has-settings::after {
			content: '';
			display: inline-block;
			width: 5px;
			height: 5px;
			background: var(--vscode-focusBorder, #007fd4);
			border-radius: 50%;
			margin-left: 4px;
			vertical-align: middle;
		}

		/* ── Axis settings popup content (form controls — slotted inside kw-popover) ── */

		/* Inline row: label + control on one line */
		.axis-popup-inline {
			display: flex;
			align-items: center;
			gap: 8px;
		}
		.axis-popup-inline > label {
			flex: 0 0 60px;
			min-width: 60px;
			font-size: 11px;
			font-weight: 500;
			opacity: 0.85;
			white-space: nowrap;
		}
		/* Toggle switches are <label> elements — override the 60px label sizing */
		.axis-popup-inline > label.toggle-switch {
			flex: 0 0 32px;
			min-width: 32px;
			max-width: 32px;
			opacity: 1;
			font-weight: normal;
		}
		.axis-popup-inline > input[type="text"],
		.axis-popup-inline > .axis-text-input {
			flex: 1 1 auto;
			min-width: 0;
			background: var(--vscode-input-background);
			color: var(--vscode-input-foreground);
			border: 1px solid var(--vscode-input-border, transparent);
			border-radius: 2px;
			padding: 3px 8px;
			font-size: 12px;
			font-family: var(--vscode-font-family);
			outline: none;
			height: 26px;
		}
		.axis-popup-inline > input[type="text"]:focus,
		.axis-popup-inline > .axis-text-input:focus { border-color: var(--vscode-focusBorder); }
		.axis-popup-inline > input[type="text"]::placeholder,
		.axis-popup-inline > .axis-text-input::placeholder { color: var(--vscode-input-placeholderForeground); }
		.axis-popup-inline > select {
			flex: 1 1 auto;
			min-width: 0;
			background: var(--vscode-input-background);
			color: var(--vscode-input-foreground);
			border: 1px solid var(--vscode-input-border);
			border-radius: 2px;
			padding: 3px 8px;
			font-size: 12px;
			outline: none;
			height: 26px;
			appearance: none;
			-webkit-appearance: none;
			cursor: pointer;
			background-image: url("data:image/svg+xml,%3Csvg width='16' height='16' viewBox='0 0 16 16' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath fill-rule='evenodd' clip-rule='evenodd' d='M7.976 10.072l4.357-4.357.62.618L8.284 11h-.618L3 6.333l.619-.618 4.357 4.357z' fill='%23858585'/%3E%3C/svg%3E");
			background-repeat: no-repeat;
			background-position: right 4px center;
			background-size: 14px 14px;
			padding-right: 22px;
		}
		.axis-popup-inline > select:focus { border-color: var(--vscode-focusBorder); }

		/* Legacy column-based row — kept for backwards compat, now rarely used */
		.axis-popup-row {
			display: flex;
			flex-direction: column;
			gap: 6px;
		}
		.axis-popup-row > label {
			font-size: 11px;
			font-weight: 500;
			opacity: 0.85;
		}
		.axis-popup-row > input[type="text"] {
			background: var(--vscode-input-background);
			color: var(--vscode-input-foreground);
			border: 1px solid var(--vscode-input-border, transparent);
			border-radius: 2px;
			padding: 3px 8px;
			font-size: 12px;
			font-family: var(--vscode-font-family);
			width: 100%;
			outline: none;
		}
		.axis-popup-row > input[type="text"]:focus { border-color: var(--vscode-focusBorder); }
		.axis-popup-row > input[type="text"]::placeholder { color: var(--vscode-input-placeholderForeground); }
		.axis-popup-row > select {
			background: var(--vscode-input-background);
			color: var(--vscode-input-foreground);
			border: 1px solid var(--vscode-input-border);
			border-radius: 2px;
			padding: 3px 8px;
			font-size: 12px;
			outline: none;
			width: 100%;
		}
		.axis-popup-row > select:focus { border-color: var(--vscode-focusBorder); }

		/* ── Toggle switch ────────────────────────────────────────────── */
		.toggle-switch {
			position: relative;
			display: inline-flex;
			width: 32px;
			min-width: 32px;
			max-width: 32px;
			height: 18px;
			flex: 0 0 32px;
			cursor: pointer;
		}
		.toggle-switch input {
			opacity: 0;
			width: 0;
			height: 0;
			position: absolute;
		}
		.toggle-switch-track {
			position: absolute;
			inset: 0;
			background: var(--vscode-input-background);
			border: 1px solid var(--vscode-input-border, var(--vscode-contrastBorder, transparent));
			border-radius: 9px;
			transition: background 0.15s ease, border-color 0.15s ease;
		}
		.toggle-switch-track::after {
			content: '';
			position: absolute;
			top: 2px;
			left: 2px;
			width: 12px;
			height: 12px;
			background: var(--vscode-foreground);
			border-radius: 50%;
			opacity: 0.5;
			transition: transform 0.2s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.15s ease, background 0.15s ease;
		}
		.toggle-switch input:checked + .toggle-switch-track {
			background: var(--vscode-button-background);
			border-color: var(--vscode-button-background);
		}
		.toggle-switch input:checked + .toggle-switch-track::after {
			transform: translateX(14px);
			background: var(--vscode-button-foreground);
			opacity: 1;
		}
		.toggle-switch:hover .toggle-switch-track {
			border-color: var(--vscode-focusBorder);
		}
		.toggle-switch input:focus-visible + .toggle-switch-track {
			outline: 1px solid var(--vscode-focusBorder);
			outline-offset: 1px;
		}

		/* ── Segmented control ────────────────────────────────────────── */
		.seg-control {
			display: inline-flex;
			align-items: stretch;
			background: var(--vscode-input-background);
			border: 1px solid var(--vscode-input-border, transparent);
			border-radius: 4px;
			overflow: hidden;
			flex: 1 1 auto;
			min-width: 0;
		}
		.seg-btn {
			flex: 1 1 0;
			min-width: 0;
			display: inline-flex;
			align-items: center;
			justify-content: center;
			padding: 2px 8px;
			font-size: 11px;
			font-family: inherit;
			color: var(--vscode-foreground);
			background: transparent;
			border: none;
			border-right: 1px solid var(--vscode-input-border, rgba(128,128,128,0.15));
			cursor: pointer;
			white-space: nowrap;
			transition: background 0.12s ease, color 0.12s ease;
			height: 24px;
			line-height: 1;
			outline: none;
		}
		.seg-btn:last-child { border-right: none; }
		.seg-btn:hover:not(.is-active) {
			background: var(--vscode-list-hoverBackground);
		}
		.seg-btn.is-active {
			background: var(--vscode-button-background);
			color: var(--vscode-button-foreground);
		}
		.seg-btn:focus-visible {
			outline: 1px solid var(--vscode-focusBorder);
			outline-offset: -1px;
		}
		.seg-btn svg { display: block; width: 14px; height: 14px; }
		.seg-btn--icon-only {
			padding: 2px 6px;
			flex: 0 0 auto;
		}
		/* When all buttons are icon-only, don't stretch the container */
		.seg-control--compact {
			flex: 0 0 auto;
		}

		/* ── Compact slider with editable value ───────────────────────── */
		.compact-slider-row {
			display: flex;
			align-items: center;
			gap: 8px;
		}
		.compact-slider-row > label {
			flex: 0 0 60px;
			min-width: 60px;
			font-size: 11px;
			font-weight: 500;
			opacity: 0.85;
			white-space: nowrap;
		}
		.compact-slider {
			flex: 1 1 auto;
			min-width: 0;
			height: 4px;
			-webkit-appearance: none;
			appearance: none;
			background: transparent;
			cursor: pointer;
			outline: none;
			margin: 0;
		}
		/* Track */
		.compact-slider::-webkit-slider-runnable-track {
			height: 4px;
			border-radius: 2px;
			background: linear-gradient(
				to right,
				var(--vscode-button-background) 0%,
				var(--vscode-button-background) var(--slider-pct, 50%),
				var(--vscode-input-background) var(--slider-pct, 50%),
				var(--vscode-input-background) 100%
			);
			border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.2));
		}
		/* Thumb */
		.compact-slider::-webkit-slider-thumb {
			-webkit-appearance: none;
			appearance: none;
			width: 14px;
			height: 14px;
			border-radius: 50%;
			background: var(--vscode-button-background);
			border: 2px solid var(--vscode-editor-background);
			box-shadow: 0 1px 3px rgba(0,0,0,0.25);
			margin-top: -6px;
			transition: transform 0.1s ease, box-shadow 0.1s ease;
		}
		.compact-slider:hover::-webkit-slider-thumb {
			transform: scale(1.15);
			box-shadow: 0 1px 5px rgba(0,0,0,0.35);
		}
		.compact-slider:active::-webkit-slider-thumb {
			transform: scale(1.05);
		}
		.compact-slider:focus-visible::-webkit-slider-thumb {
			outline: 2px solid var(--vscode-focusBorder);
			outline-offset: 1px;
		}
		/* Editable value input (click-to-edit number beside slider) */
		.slider-value-input {
			flex: 0 0 auto;
			width: 40px;
			background: transparent;
			color: var(--vscode-foreground);
			border: 1px solid transparent;
			border-radius: 2px;
			padding: 1px 4px;
			font-size: 11px;
			font-family: var(--vscode-editor-font-family, monospace);
			text-align: right;
			outline: none;
			cursor: text;
			-moz-appearance: textfield;
			transition: border-color 0.1s ease, background 0.1s ease;
		}
		.slider-value-input::-webkit-inner-spin-button,
		.slider-value-input::-webkit-outer-spin-button {
			-webkit-appearance: none;
			margin: 0;
		}
		.slider-value-input:hover {
			border-color: var(--vscode-input-border, rgba(128,128,128,0.5));
			background: var(--vscode-input-background);
		}
		.slider-value-input:focus {
			background: var(--vscode-input-background);
			border-color: var(--vscode-focusBorder);
			border-style: solid;
		}

		/* ── Checkbox (legacy) ────────────────────────────────────────── */
		.axis-popup-checkbox {
			display: flex;
			align-items: center;
			gap: 8px;
		}
		.axis-popup-checkbox > input[type="checkbox"] {
			width: 16px;
			height: 16px;
			cursor: pointer;
		}

		/* ── Slider row (legacy, kept for backwards compat) ───────────── */
		.axis-popup-slider-row {
			display: flex;
			flex-direction: column;
			gap: 4px;
		}
		.axis-popup-slider-header {
			display: flex;
			justify-content: space-between;
			font-size: 11px;
			opacity: 0.85;
		}
		.axis-popup-slider {
			width: 100%;
			cursor: pointer;
		}

		/* ── Min/Max fields ───────────────────────────────────────────── */
		.axis-popup-minmax {
			display: flex;
			align-items: center;
			gap: 8px;
		}
		.axis-popup-minmax > label {
			flex: 0 0 60px;
			min-width: 60px;
			font-size: 11px;
			font-weight: 500;
			opacity: 0.85;
			white-space: nowrap;
		}
		.axis-popup-minmax-input {
			flex: 1 1 0;
			min-width: 0;
			background: var(--vscode-input-background);
			color: var(--vscode-input-foreground);
			border: 1px solid var(--vscode-input-border, transparent);
			border-radius: 2px;
			padding: 3px 8px;
			font-size: 12px;
			outline: none;
			height: 26px;
		}
		.axis-popup-minmax-input:focus { border-color: var(--vscode-focusBorder); }
		.axis-popup-minmax-input::placeholder { color: var(--vscode-input-placeholderForeground); }		.axis-popup-minmax-input:disabled {
			opacity: 0.4;
			cursor: not-allowed;
		}		.axis-popup-minmax-sep {
			font-size: 11px;
			opacity: 0.4;
			flex-shrink: 0;
		}

		/* ── Reset button (icon in header) ────────────────────────────── */
		.axis-popup-reset-icon {
			background: transparent;
			border: none;
			padding: 0;
			width: 24px;
			height: 24px;
			cursor: pointer;
			color: var(--vscode-foreground);
			opacity: 0.5;
			display: inline-flex;
			align-items: center;
			justify-content: center;
			border-radius: 4px;
			transition: opacity 0.1s ease, background 0.1s ease;
		}
		.axis-popup-reset-icon:hover {
			opacity: 1;
			background: var(--vscode-toolbar-hoverBackground);
		}
		.axis-popup-reset-icon svg { display: block; }

		/* Legacy full-width reset (kept for backwards compat) */
		.axis-popup-reset {
			background: transparent;
			border: none;
			color: var(--vscode-textLink-foreground, var(--vscode-foreground));
			border-radius: 2px;
			padding: 4px 0;
			font-size: 11px;
			cursor: pointer;
			width: auto;
			float: right;
			opacity: 0.75;
			transition: opacity 0.1s ease;
		}
		.axis-popup-reset:hover {
			opacity: 1;
			text-decoration: underline;
		}

		/* ── Series colors ────────────────────────────────────────────── */
		.axis-popup-colors-header {
			font-size: 11px;
			font-weight: 500;
			opacity: 0.85;
			margin-bottom: 6px;
		}
		.axis-popup-colors-grid {
			display: flex;
			flex-wrap: wrap;
			gap: 4px;
		}
		.axis-popup-color-chip {
			display: inline-flex;
			align-items: center;
			gap: 4px;
			background: var(--vscode-input-background);
			border: 1px solid var(--vscode-input-border, transparent);
			border-radius: 3px;
			padding: 2px 6px 2px 2px;
			max-width: 120px;
		}
		.axis-popup-color-chip input[type="color"] {
			width: 18px;
			height: 18px;
			padding: 0;
			border: none;
			border-radius: 3px;
			cursor: pointer;
			background: transparent;
			flex-shrink: 0;
		}
		.axis-popup-color-chip .axis-popup-color-label {
			font-size: 11px;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}
		/* Legacy single-row color layout */
		.axis-popup-color-row {
			display: flex;
			align-items: center;
			gap: 8px;
			margin-bottom: 4px;
		}
		.axis-popup-color-row input[type="color"] {
			width: 28px;
			height: 22px;
			padding: 0;
			border: none;
			border-radius: 3px;
			cursor: pointer;
			background: transparent;
		}
		.axis-popup-color-label {
			font-size: 12px;
			flex: 1;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}

		/* ── Canvas slot ──────────────────────────────────────────────── */

		::slotted(.query-editor-wrapper) {
			border: none;
			overflow: hidden;
			height: auto;
			min-height: 0;
		}

		/* Chart resizer: bleed edge-to-edge to overlap section bottom border */
		::slotted(.chart-bottom-resizer) {
			margin: 0 -13px -13px !important;
			width: calc(100% + 26px) !important;
			z-index: 2;
		}
		:host(.is-collapsed) ::slotted(.chart-bottom-resizer) {
			display: none !important;
		}
`;