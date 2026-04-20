import { css } from 'lit';

export const styles = css`
		*, *::before, *::after {
			box-sizing: border-box;
		}

		:host {
			display: block;
			border: 1px solid var(--vscode-input-border, var(--vscode-widget-border, var(--vscode-panel-border, rgba(128,128,128,0.25))));
			border-radius: 4px;
			margin-bottom: 16px;
			background: var(--vscode-editor-background);
			box-shadow: 0 2px 10px var(--vscode-widget-shadow);
		}

		:host(.is-collapsed) .editor-wrapper,
		:host(.is-collapsed) .resizer {
			display: none !important;
		}
		:host(.is-collapsed) .md-mode-btn,
		:host(.is-collapsed) .md-mode-dropdown,
		:host(.is-collapsed) .md-mode-buttons {
			display: none !important;
		}
		:host(.is-collapsed) {
			margin-bottom: 16px;
		}
		:host(.is-collapsed) .section-root {
			padding-bottom: 4px;
		}

		:host(.is-md-preview) .editor-wrapper {
			border: none;
			background: transparent;
			margin-top: 0;
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
			min-height: 60px;
		}

		.section-root {
			padding: 12px;
			padding-bottom: 0;
		}

		/* ── Mode buttons container (slotted into shell header-buttons) ── */

		.md-mode-buttons {
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
		}
		.md-tab svg {
			display: block;
		}
		.md-tab:hover {
			background: var(--vscode-list-hoverBackground);
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
		:host(.is-md-very-narrow) .md-mode-dropdown {
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

		/* ── Editor wrapper — slotted TOAST UI content lives in light DOM ── */

		.editor-wrapper {
			position: relative;
			width: 100%;
			min-height: 120px;
			height: 325px;
			margin: 0 0 12px 0;
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
			margin: 0 -12px -1px -12px;
			background: transparent;
			border-radius: 0 0 3px 3px;
		}
		.resizer::before {
			border-radius: 0 0 3px 3px;
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

		:host([plain-md]) .plain-md-header {
			flex: 0 0 auto;
			margin-bottom: 0;
		}

		/* In plain-md, always show mode buttons (no dropdown swap) */
		:host([plain-md]) .md-mode-dropdown {
			display: none !important;
		}

		:host([plain-md]) .resizer {
			display: none !important;
		}

		/* Align mode buttons left edge with toolbar left border */
		:host([plain-md]) .md-tabs {
			display: inline-flex;
			gap: 2px;
			align-items: center;
			border: none;
			border-radius: 0;
			overflow: visible;
			margin: 0;
			margin-left: 0;
			padding-left: 1px;
			padding-top: 10px;
			padding-bottom: 10px;
			background: transparent;
		}

		/* Editor takes remaining space */
		:host([plain-md]) .editor-wrapper {
			flex: 1 1 auto;
			min-height: 0;
			height: auto;
			overflow: visible;
			margin: 0;
			border: none;
		}
`;