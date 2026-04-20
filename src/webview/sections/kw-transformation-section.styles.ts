import { css } from 'lit';

export const styles = css`
		*, *::before, *::after { box-sizing: border-box; }

		:host {
			display: block;
			border: 1px solid var(--vscode-input-border, var(--vscode-widget-border, var(--vscode-panel-border, rgba(128,128,128,0.25))));
			border-radius: 4px;
			margin-bottom: 16px;
			background: var(--vscode-editor-background);
			box-shadow: 0 2px 10px var(--vscode-widget-shadow);
			padding-bottom: 0;
			--kusto-transform-label-width: 48px;
		}
		:host(.is-collapsed) {
			margin-bottom: 26px;
		}
		:host(.is-collapsed) .section-root {
			padding-bottom: 4px;
		}
		:host(.is-collapsed) .md-mode-btn,
		:host(.is-collapsed) .tf-mode-buttons {
			display: none !important;
		}

		.section-root {
			padding: 12px;
			padding-bottom: 0;
		}

		/* ── Mode buttons (slotted into shell header-buttons) ── */

		.tf-mode-buttons {
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

		/* ── Controls panel ──────────────────────────────────────────────── */

		.tf-controls {
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
			margin-bottom: 5px;
		}
		.tf-controls::before {
			content: '';
			position: absolute;
			inset: 0;
			pointer-events: none;
			background: rgba(0, 0, 0, 0.035);
		}
		:host-context(body.vscode-dark) .tf-controls::before,
		:host-context(body.vscode-high-contrast) .tf-controls::before {
			background: rgba(255, 255, 255, 0.04);
		}

		.tf-controls-scroll {
			overflow-x: auto;
			overflow-y: visible;
			padding-bottom: 16px;
			scrollbar-width: thin;
			scrollbar-color: var(--vscode-scrollbarSlider-background) transparent;
			position: relative;
		}
		.tf-controls-scroll::-webkit-scrollbar { height: 8px; background: transparent; }
		.tf-controls-scroll::-webkit-scrollbar-track { background: transparent; }
		.tf-controls-scroll::-webkit-scrollbar-thumb { background: var(--vscode-scrollbarSlider-background); }
		.tf-controls-scroll::-webkit-scrollbar-thumb:hover { background: var(--vscode-scrollbarSlider-hoverBackground); }

		.tf-controls-scroll-content {
			min-width: 480px;
			display: flex;
			flex-direction: column;
			gap: 14px;
		}

		/* ── Type picker ─────────────────────────────────────────────── */

		.tf-row {
			display: flex;
			align-items: center;
			gap: 10px;
			flex-wrap: nowrap;
		}

		.tf-row > label {
			flex: 0 0 var(--kusto-transform-label-width);
			min-width: var(--kusto-transform-label-width);
			font-size: 12px;
			white-space: nowrap;
		}

		.tf-type-picker {
			display: inline-flex;
			gap: 4px;
			flex-wrap: wrap;
		}

		.tf-type-btn {
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
		.tf-type-btn svg {
			width: 24px;
			height: 24px;
		}
		.tf-type-btn:hover { background: var(--vscode-toolbar-hoverBackground); }
		.tf-type-btn.is-active {
			background: var(--vscode-toolbar-activeBackground, var(--vscode-actionBar-toggledBackground, rgba(128, 128, 128, 0.25)));
			color: var(--vscode-foreground);
			border-color: transparent;
		}

		/* ── Select / Dropdown ─────────────────────────────────────────── */

		.tf-select {
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
			background-color: var(--vscode-dropdown-background);
			background-image: url("data:image/svg+xml,%3Csvg width='16' height='16' viewBox='0 0 16 16' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath fill-rule='evenodd' clip-rule='evenodd' d='M7.976 10.072l4.357-4.357.62.618L8.284 11h-.618L3 6.333l.619-.618 4.357 4.357z' fill='%23858585'/%3E%3C/svg%3E");
			background-repeat: no-repeat;
			background-position: right 4px center;
			background-size: 16px 16px;
		}
		.tf-select:focus { border-color: var(--vscode-focusBorder); }
		.tf-select:disabled {
			opacity: 0.6;
			cursor: default;
		}

		.dropdown-wrapper {
			position: relative;
			flex: 1 1 auto;
			min-width: 0;
		}

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
		.dropdown-item.is-selected {
			background: var(--vscode-list-activeSelectionBackground);
			color: var(--vscode-list-activeSelectionForeground);
		}

		/* ── Text inputs ──────────────────────────────────────────────── */

		.tf-input {
			background: var(--vscode-input-background);
			color: var(--vscode-input-foreground);
			border: 1px solid var(--vscode-input-border);
			border-radius: 0;
			padding: 4px 6px;
			font-family: var(--vscode-editor-font-family);
			font-size: 12px;
			outline: none;
			height: 28px;
			min-height: 28px;
		}
		.tf-input:focus { border-color: var(--vscode-focusBorder); }

		.tf-textarea {
			background: var(--vscode-input-background);
			color: var(--vscode-input-foreground);
			border: 1px solid var(--vscode-input-border);
			border-radius: 0;
			padding: 7px 6px 2px 6px;
			font-family: var(--vscode-editor-font-family);
			font-size: 12px;
			outline: none;
			resize: vertical;
			min-height: 28px;
			line-height: 1.35;
		}
		.tf-textarea:focus { border-color: var(--vscode-focusBorder); }

		/* ── Derive rows ─────────────────────────────────────────────── */

		.derive-stack {
			display: flex;
			gap: 10px;
			width: 100%;
		}
		.derive-stack > label {
			flex: 0 0 var(--kusto-transform-label-width);
			min-width: var(--kusto-transform-label-width);
			font-size: 12px;
			white-space: nowrap;
			margin-top: 4px;
		}
		.derive-body {
			flex: 1 1 auto;
			min-width: 260px;
		}
		.derive-rows {
			display: flex;
			flex-direction: column;
			gap: 8px;
			margin-top: 0;
		}
		.derive-row {
			display: grid;
			grid-template-columns: minmax(150px, 220px) auto 1fr auto;
			gap: 8px;
			align-items: center;
			border: none;
			border-radius: 0;
			padding: 0;
			background: transparent;
			box-shadow: none;
			transition: background 0.12s ease;
			position: relative;
		}
		.derive-row:hover {
			background: color-mix(in srgb, var(--vscode-editor-background) 96%, var(--vscode-list-hoverBackground) 4%);
		}
		.derive-eq {
			opacity: 0.75;
			font-size: 12px;
			padding: 0 2px;
			user-select: none;
		}
		.derive-name {
			min-width: 150px;
		}
		.derive-expr {
			min-width: 150px;
		}
		.derive-row-actions {
			align-self: center;
			display: flex;
			gap: 6px;
			align-items: center;
		}

		/* Derive drag styling */
		.derive-rows.is-dragging .derive-row {
			transition: border-color 0.08s ease, background 0.08s ease;
		}
		.derive-row.is-drop-target {
			background: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-list-hoverBackground) 8%);
		}
		.derive-row.is-drop-before::before,
		.derive-row.is-drop-after::after {
			content: "";
			position: absolute;
			left: 0;
			right: 0;
			height: 2px;
			background: var(--vscode-focusBorder);
			box-shadow: 0 0 0 1px color-mix(in srgb, var(--vscode-focusBorder) 60%, transparent);
		}
		.derive-row.is-drop-before::before { top: -2px; }
		.derive-row.is-drop-after::after { bottom: -2px; }

		/* ── Summarize ───────────────────────────────────────────────── */

		.summarize-stack {
			display: flex;
			flex-direction: column;
			gap: 14px;
			flex: 1 1 auto;
			min-width: 260px;
			width: 100%;
		}
		.summarize-row {
			display: flex;
			gap: 10px;
			width: 100%;
		}
		.summarize-row > label {
			flex: 0 0 var(--kusto-transform-label-width);
			min-width: var(--kusto-transform-label-width);
			font-size: 12px;
			white-space: nowrap;
		}
		.summarize-row-calc {
			align-items: flex-start;
		}
		.summarize-row-calc > label {
			padding-top: 0;
			margin-top: 4px;
		}
		.summarize-aggs {
			flex: 1 1 auto;
			min-width: 260px;
		}
		.summarize-row-by {
			align-items: flex-start;
		}
		.summarize-row-by > label {
			padding-top: 0;
			margin-top: 4px;
		}
		.groupby-body {
			display: flex;
			flex-direction: column;
			flex: 1 1 auto;
			min-width: 220px;
		}
		.groupby-rows {
			display: flex;
			flex-direction: column;
			gap: 8px;
		}
		.groupby-row {
			display: flex;
			align-items: center;
			gap: 8px;
			position: relative;
		}
		.groupby-select {
			flex: 1;
			min-width: 120px;
		}
		.groupby-row-actions {
			align-self: center;
			display: flex;
			gap: 6px;
			align-items: center;
			justify-content: flex-end;
		}

		/* Group-by drag styling */
		.groupby-rows.is-dragging .groupby-row {
			transition: border-color 0.08s ease, background 0.08s ease;
		}
		.groupby-row.is-drop-target {
			background: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-list-hoverBackground) 8%);
		}
		.groupby-row.is-drop-before::before,
		.groupby-row.is-drop-after::after {
			content: "";
			position: absolute;
			left: 0;
			right: 0;
			height: 2px;
			background: var(--vscode-focusBorder);
			box-shadow: 0 0 0 1px color-mix(in srgb, var(--vscode-focusBorder) 60%, transparent);
		}
		.groupby-row.is-drop-before::before { top: -1px; }
		.groupby-row.is-drop-after::after { bottom: -1px; }

		/* ── Aggregation rows ────────────────────────────────────────── */

		.agg-rows {
			display: flex;
			flex-direction: column;
			gap: 8px;
			margin-top: 0;
		}
		.agg-row {
			display: grid;
			grid-template-columns: 200px auto 140px 1fr auto;
			gap: 8px;
			align-items: center;
			border: none;
			border-radius: 0;
			padding: 0;
			background: transparent;
			box-shadow: none;
			transition: background 0.12s ease;
			position: relative;
		}
		.agg-eq {
			opacity: 0.75;
			font-size: 12px;
			padding: 0 2px;
			user-select: none;
		}
		.agg-row-actions {
			align-self: center;
			display: flex;
			gap: 6px;
			align-items: center;
			justify-content: flex-end;
		}

		/* Agg drag styling */
		.agg-rows.is-dragging .agg-row {
			transition: border-color 0.08s ease, background 0.08s ease;
		}
		.agg-row.is-drop-target {
			background: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-list-hoverBackground) 8%);
		}
		.agg-row.is-drop-before::before,
		.agg-row.is-drop-after::after {
			content: "";
			position: absolute;
			left: 0;
			right: 0;
			height: 2px;
			background: var(--vscode-focusBorder);
			box-shadow: 0 0 0 1px color-mix(in srgb, var(--vscode-focusBorder) 60%, transparent);
		}
		.agg-row.is-drop-before::before { top: -1px; }
		.agg-row.is-drop-after::after { bottom: -1px; }

		/* ── Pivot labels ────────────────────────────────────────────── */

		.pivot-label-spaced {
			margin-left: 14px;
			flex: 0 0 calc(var(--kusto-transform-label-width) + 35px);
			min-width: calc(var(--kusto-transform-label-width) + 35px);
		}

		.pivot-row .dropdown-wrapper {
			flex: 1 1 0;
			min-width: 120px;
		}

		/* ── Join ────────────────────────────────────────────────── */

		.join-keys-stack {
			display: flex;
			gap: 10px;
			width: 100%;
		}
		.join-keys-stack > label {
			flex: 0 0 var(--kusto-transform-label-width);
			min-width: var(--kusto-transform-label-width);
			font-size: 12px;
			white-space: nowrap;
			margin-top: 4px;
		}
		.join-keys-body {
			flex: 1 1 auto;
			min-width: 260px;
		}
		.join-key-rows {
			display: flex;
			flex-direction: column;
			gap: 8px;
		}
		.join-key-row {
			display: grid;
			grid-template-columns: 1fr auto 1fr auto;
			gap: 8px;
			align-items: center;
			position: relative;
		}
		.join-eq {
			opacity: 0.75;
			font-size: 12px;
			padding: 0 2px;
			user-select: none;
			font-family: var(--vscode-editor-font-family);
		}
		.join-key-row-actions {
			align-self: center;
			display: flex;
			gap: 6px;
			align-items: center;
		}

		/* Join key drag styling */
		.join-key-rows.is-dragging .join-key-row {
			transition: border-color 0.08s ease, background 0.08s ease;
		}
		.join-key-row.is-drop-target {
			background: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-list-hoverBackground) 8%);
		}
		.join-key-row.is-drop-before::before,
		.join-key-row.is-drop-after::after {
			content: "";
			position: absolute;
			left: 0;
			right: 0;
			height: 2px;
			background: var(--vscode-focusBorder);
			box-shadow: 0 0 0 1px color-mix(in srgb, var(--vscode-focusBorder) 60%, transparent);
		}
		.join-key-row.is-drop-before::before { top: -1px; }
		.join-key-row.is-drop-after::after { bottom: -1px; }

		.join-omit-row {
			align-items: center;
		}
		.join-checkbox-label {
			display: inline-flex;
			align-items: center;
			gap: 6px;
			font-size: 12px;
			cursor: pointer;
			user-select: none;
		}
		.join-checkbox-label input[type="checkbox"] {
			width: 14px;
			height: 14px;
			margin: 0;
			cursor: pointer;
			accent-color: var(--vscode-focusBorder);
		}

		/* ── Mini buttons (shared by derive/agg/groupby) ──────────── */

		.mini-btn {
			min-width: 28px;
			height: 28px;
			padding: 2px 6px;
			line-height: 1;
			border-radius: 6px;
			display: inline-flex;
			align-items: center;
			justify-content: center;
		}
		.mini-btn svg { width: 16px; height: 16px; }

		.drag-handle {
			align-self: center;
			margin-right: 0;
			width: 28px;
			height: 28px;
			min-width: 28px;
			min-height: 28px;
			opacity: 1;
			background: transparent;
			border: 1px solid transparent;
			color: var(--vscode-descriptionForeground);
			border-radius: 4px;
			padding: 0;
			display: inline-flex;
			align-items: center;
			justify-content: center;
			cursor: grab;
		}
		.drag-handle:hover {
			background: var(--vscode-list-hoverBackground);
			border-color: var(--vscode-input-border);
			color: var(--vscode-foreground);
		}
		.drag-handle:active { cursor: grabbing; }
		.drag-handle-glyph {
			font-size: 14px;
			line-height: 1;
			letter-spacing: -1px;
		}

		/* ── Results area ────────────────────────────────────────────── */

		.tf-wrapper-host {
			display: flex;
			flex-direction: column;
			min-height: 120px;
			overflow: visible;
		}
		.tf-wrapper-host.is-hidden {
			display: none;
		}

		.results-area {
			flex: 1 1 auto;
			min-height: 0;
			margin-top: 0;
			padding-bottom: 10px;
			overflow: hidden;
			display: flex;
			flex-direction: column;
		}

		.results-area kw-data-table {
			flex: 1 1 auto;
			min-height: 0;
		}

		.error-message {
			font-family: var(--vscode-font-family);
			font-size: 13px;
			color: var(--vscode-foreground);
			padding: 10px 12px 17px 4px;
			white-space: pre-wrap;
		}

		/* ── Resize handle ───────────────────────────────────────────── */

		.resizer {
			margin: 0 -12px -1px -12px;
			background: transparent;
			border-radius: 0 0 3px 3px;
		}
		.resizer::before {
			border-radius: 0 0 3px 3px;
		}
`;