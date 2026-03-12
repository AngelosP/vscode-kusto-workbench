import { css } from 'lit';

export const styles = css`
		*, *::before, *::after {
			box-sizing: border-box;
		}

		:host {
			display: block;
			border: 1px solid var(--vscode-input-border, var(--vscode-widget-border, var(--vscode-panel-border, rgba(128,128,128,0.25))));
			border-radius: 0;
			margin-bottom: 16px;
			background: var(--vscode-editor-background);
			box-shadow: 0 2px 10px var(--vscode-widget-shadow);
		}

		:host(.is-collapsed) .editor-wrapper {
			display: none !important;
		}
		:host(.is-collapsed) .md-mode-btn,
		:host(.is-collapsed) .md-tabs-divider,
		:host(.is-collapsed) .md-max-btn,
		:host(.is-collapsed) .md-mode-dropdown {
			display: none !important;
		}
		:host(.is-collapsed) {
			padding-bottom: 2px;
		}

		:host(.is-md-preview) .editor-wrapper {
			border: none;
			background: transparent;
			margin-top: 0;
		}
		:host(.is-md-preview) .section-header-row {
			margin-bottom: 2px;
		}
		:host(.is-md-preview) {
			margin-bottom: 20px;
		}
		:host(.is-md-preview-auto) .editor-wrapper {
			height: auto;
			min-height: 0;
			overflow: visible;
		}
		:host(.is-md-preview-fixed) .editor-wrapper {
			overflow: hidden;
		}

		.section-root {
			padding: 12px;
			padding-bottom: 5px;
		}

		.section-header-row {
			display: flex;
			gap: 8px;
			align-items: center;
			justify-content: space-between;
			margin-bottom: 8px;
		}

		.query-name-group {
			display: inline-flex;
			align-items: center;
			gap: 0;
			min-width: 0;
			flex: 1 1 auto;
		}

		.section-drag-handle {
			opacity: 1;
			background: transparent;
			border: 1px solid transparent;
			color: var(--vscode-descriptionForeground);
			border-radius: 4px;
			margin: 0;
			width: 12px;
			height: 24px;
			padding: 0;
			display: inline-flex;
			align-items: center;
			justify-content: center;
			cursor: grab;
			flex: 0 0 auto;
		}
		.section-drag-handle:hover {
			background: var(--vscode-list-hoverBackground);
			border-color: var(--vscode-input-border);
			color: var(--vscode-foreground);
		}
		.section-drag-handle:active { cursor: grabbing; }
		.section-drag-handle:focus-visible {
			outline: none;
			border-color: var(--vscode-focusBorder);
		}
		.section-drag-handle-glyph {
			font-size: 14px;
			line-height: 1;
			letter-spacing: -1px;
		}

		.query-name {
			font-size: 12px;
			color: var(--vscode-foreground);
			background: transparent;
			border: 1px solid transparent;
			border-radius: 4px;
			padding: 2px 6px;
			outline: none;
			min-width: 0;
			flex: 1 1 auto;
			font-family: inherit;
		}
		.query-name::placeholder {
			color: var(--vscode-input-placeholderForeground);
		}
		.query-name:hover {
			border-color: var(--vscode-input-border);
		}
		.query-name:focus {
			border-color: var(--vscode-focusBorder);
		}

		.section-actions {
			display: inline-flex;
			gap: 2px;
			align-items: center;
			flex: 0 0 auto;
		}

		.md-tabs {
			display: inline-flex;
			gap: 2px;
			align-items: center;
			border: none;
			border-radius: 0;
			overflow: visible;
			margin: 0;
			background: transparent;
		}

		.md-tabs-divider {
			width: 1px;
			height: 16px;
			background: var(--vscode-input-border, var(--vscode-widget-border, var(--vscode-panel-border, rgba(128,128,128,0.35))));
			margin: 0 4px;
			opacity: 0.9;
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
		.unified-btn-icon-only svg {
			display: block;
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
		}
		.md-tab svg {
			display: block;
		}
		.md-tab:hover {
			background: var(--vscode-list-hoverBackground);
		}
		.md-tab.md-max-btn {
			margin-right: 6px;
		}

		.md-tab.md-mode-btn {
			width: auto;
			padding: 0 10px;
			font-size: 12px;
			line-height: 1;
			height: 28px;
			min-width: 68px;
			justify-content: center;
		}
		.md-tab.md-mode-btn.is-active {
			background: var(--vscode-list-hoverBackground);
			border-color: var(--vscode-input-border);
		}

		/* Icon/label spans inside mode buttons */
		.md-mode-icon {
			display: none;
			line-height: 0;
		}
		.md-mode-label {
			display: inline;
		}

		/* When narrow, show icon instead of text on mode buttons */
		:host(.is-md-narrow) .md-mode-icon {
			display: inline-flex;
		}
		:host(.is-md-narrow) .md-mode-label {
			display: none;
		}
		:host(.is-md-narrow) .md-tab.md-mode-btn {
			min-width: 28px;
			width: 28px;
			padding: 0;
		}

		.md-tab.is-active {
			background: var(--vscode-list-hoverBackground);
			border-color: var(--vscode-input-border);
		}

		/* Mode dropdown (shown on narrow widths) */
		.md-mode-dropdown {
			display: none;
			position: relative;
			flex: 0 0 auto;
			width: auto;
		}
		:host(.is-md-narrow:not([plain-md])) .md-mode-btn {
			display: none !important;
		}
		:host(.is-md-narrow:not([plain-md])) .md-mode-dropdown {
			display: inline-flex;
		}
		:host(.is-md-very-narrow) .md-mode-dropdown,
		:host(.is-md-very-narrow) .md-tabs-divider {
			display: none !important;
		}

		.md-mode-dropdown-btn {
			display: inline-flex;
			align-items: center;
			gap: 4px;
			background: transparent;
			border: 1px solid transparent;
			color: var(--vscode-foreground);
			cursor: pointer;
			padding: 0 8px;
			height: 28px;
			border-radius: 0;
			font-size: 12px;
			line-height: 1;
			width: auto;
			flex: 0 0 auto;
		}
		.md-mode-dropdown-btn:hover {
			background: var(--vscode-list-hoverBackground);
		}
		.md-mode-dropdown-text {
			white-space: nowrap;
		}
		.md-mode-dropdown-caret {
			display: block;
			opacity: 0.8;
			flex-shrink: 0;
		}
		.md-mode-dropdown-menu {
			position: absolute;
			top: 100%;
			left: 0;
			z-index: 1000;
			min-width: 100px;
			background: var(--vscode-dropdown-background, var(--vscode-menu-background));
			border: 1px solid var(--vscode-dropdown-border, var(--vscode-menu-border, var(--vscode-widget-border)));
			border-radius: 0;
			box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
			margin-top: 2px;
		}
		.md-mode-dropdown-item {
			padding: 6px 12px;
			cursor: pointer;
			font-size: 12px;
			color: var(--vscode-dropdown-foreground, var(--vscode-menu-foreground));
		}
		.md-mode-dropdown-item:hover {
			background: var(--vscode-list-hoverBackground);
		}
		.md-mode-dropdown-item:first-child {
			border-radius: 0;
		}
		.md-mode-dropdown-item:last-child {
			border-radius: 0;
		}

		/* Editor wrapper — slotted TOAST UI content lives in light DOM */
		.editor-wrapper {
			position: relative;
			width: 100%;
			min-height: 120px;
			height: 325px;
			margin: 0 0 0 0;
			border: 1px solid var(--vscode-input-border, var(--vscode-widget-border, var(--vscode-panel-border, rgba(128,128,128,0.25))));
			border-radius: 2px;
			background: var(--vscode-editor-background);
			overflow: visible;
			display: flex;
			flex-direction: column;
		}

		::slotted(.kusto-markdown-editor) {
			width: 100%;
			flex: 1 1 auto;
			height: auto;
			min-height: 0;
			min-width: 0;
			position: relative;
			overflow: hidden;
		}

		::slotted(.markdown-viewer) {
			width: 100%;
			flex: 1 1 auto;
			height: auto;
			min-height: 80px;
			min-width: 0;
			position: relative;
			overflow: auto;
			font-size: 13px;
			border: none;
			border-radius: 0;
			padding: 0;
			background: transparent;
		}

		/* Preview mode: strip TOAST UI viewer chrome */
		:host(.is-md-preview) ::slotted(.markdown-viewer) {
			border: none;
			padding: 0;
			min-height: 0;
		}

		.resizer {
			flex: 0 0 12px;
			height: 12px;
			cursor: ns-resize;
			border-top: none;
			background: var(--vscode-editor-background);
			position: relative;
			touch-action: none;
		}
		.resizer::after {
			content: '';
			position: absolute;
			left: 50%;
			top: 50%;
			width: 34px;
			height: 4px;
			transform: translate(-50%, -50%);
			border-radius: 2px;
			opacity: 0.55;
			background-image: repeating-linear-gradient(
				0deg,
				var(--vscode-input-placeholderForeground),
				var(--vscode-input-placeholderForeground) 1px,
				transparent 1px,
				transparent 3px
			);
		}
		.resizer:hover { background: var(--vscode-list-hoverBackground); }
		.resizer:hover::after { opacity: 0.85; }
		.resizer.is-dragging { background: var(--vscode-list-hoverBackground); }

		.close-btn {
			background: transparent;
			border: 1px solid transparent;
			color: var(--vscode-foreground);
			border-radius: 4px;
			cursor: pointer;
		}
		.close-btn:hover {
			background: var(--vscode-list-hoverBackground);
		}

		/* ── Plain .md mode (single-section, no chrome) ────────────── */

		:host([plain-md]) {
			border: none;
			box-shadow: none;
			background: transparent;
			padding: 0;
			margin: 0;
			display: flex;
			flex-direction: column;
			height: 100%;
		}

		:host([plain-md]) .section-root {
			display: flex;
			flex-direction: column;
			height: 100%;
		}

		:host([plain-md]) .section-header-row {
			flex: 0 0 auto;
			margin-bottom: 0;
		}

		/* Hide name input, drag handle, close button, maximize, resizer, dropdown, divider */
		:host([plain-md]) .query-name-group {
			display: none !important;
		}
		:host([plain-md]) .close-btn {
			display: none !important;
		}
		:host([plain-md]) .section-drag-handle {
			display: none !important;
		}
		:host([plain-md]) .md-tab.md-max-btn {
			display: none !important;
		}
		:host([plain-md]) .resizer {
			display: none !important;
		}
		:host([plain-md]) .md-tabs-divider {
			display: none !important;
		}
		:host([plain-md]) .md-mode-dropdown {
			display: none !important;
		}

		/* Show/hide toggle not needed in single-section */
		:host([plain-md]) .md-tab[aria-label="Show"],
		:host([plain-md]) .md-tab[aria-label="Hide"] {
			display: none !important;
		}

		/* Align mode buttons left edge with toolbar left border */
		:host([plain-md]) .md-tabs {
			margin-left: 0;
			padding-left: 1px;
			padding-top: 10px;
			padding-bottom: 10px;
		}

		/* In plain-md, never swap to dropdown — always show icon-only buttons */
		:host([plain-md]) .md-mode-dropdown {
			display: none !important;
		}

		/* Editor takes remaining space */
		:host([plain-md]) .editor-wrapper {
			flex: 1 1 auto;
			min-height: 0;
			height: auto;
			overflow: hidden;
			margin: 0;
			border: none;
		}
`;