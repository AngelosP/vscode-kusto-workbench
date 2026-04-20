import { css } from 'lit';
import { monacoToolbarStyles } from '../components/kw-monaco-toolbar.styles.js';

export const styles = [monacoToolbarStyles, css`
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

		:host(.is-collapsed) .editor-wrapper {
			display: none !important;
		}
		:host(.is-collapsed) .python-output {
			display: none !important;
		}
		:host(.is-collapsed) {
			margin-bottom: 16px;
		}
		:host(.is-collapsed) .section-root {
			padding-bottom: 4px;
		}

		.section-root {
			padding: 12px;
		}

		/* ── Run button (slotted into kw-section-shell header-buttons) ──── */

		.header-tab.run-btn {
			background: transparent;
			border: 1px solid transparent;
			color: var(--vscode-foreground);
			cursor: pointer;
			border-radius: 4px;
			display: inline-flex;
			align-items: center;
			justify-content: center;
			line-height: 0;
			width: auto;
			padding: 0 10px;
			gap: 4px;
			font-size: 12px;
			line-height: 1;
			height: 28px;
		}
		.header-tab.run-btn:hover:not(:disabled) {
			background: var(--vscode-list-hoverBackground);
		}
		.header-tab.run-btn svg {
			width: 12px;
			height: 12px;
		}
		.run-label {
			display: inline;
		}
		.header-tab.run-btn:disabled {
			opacity: 0.5;
			cursor: default;
		}

		/* Editor wrapper — slotted content (Monaco) lives in light DOM */
		.editor-wrapper {
			position: relative;
			width: 100%;
			min-height: 120px;
			height: 325px;
			margin: 0 0 0 0;
			border: 1px solid var(--vscode-input-border, var(--vscode-widget-border, var(--vscode-panel-border, rgba(128,128,128,0.25))));
			border-bottom: none;
			border-radius: 2px;
			background: var(--vscode-editor-background);
			overflow: visible;
			display: flex;
			flex-direction: column;
		}

		::slotted(.query-editor) {
			width: 100%;
			flex: 1 1 auto;
			height: auto;
			min-height: 0;
			min-width: 0;
			position: relative;
			overflow: hidden;
			font-family: var(--vscode-editor-font-family);
			font-size: 13px;
		}

		.python-output {
			border: 1px solid var(--vscode-input-border);
			border-radius: 4px;
			background: var(--vscode-editor-background);
			padding: 10px;
			margin-top: 8px;
			font-family: var(--vscode-editor-font-family);
			font-size: 12px;
			white-space: pre-wrap;
			overflow: auto;
			max-height: 320px;
		}
`];