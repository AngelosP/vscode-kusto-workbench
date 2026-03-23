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

		/* ── Python toolbar (inside editor wrapper, above Monaco) ────── */

		.python-toolbar {
			display: flex;
			align-items: center;
			flex-wrap: nowrap;
			gap: 4px;
			padding: 0 6px;
			height: 35px;
			min-height: 35px;
			border-bottom: 1px solid var(--vscode-input-border, var(--vscode-widget-border, var(--vscode-panel-border, rgba(128,128,128,0.25))));
			background: transparent;
			color: var(--vscode-foreground);
			flex: 0 0 auto;
			border-top-left-radius: 2px;
			border-top-right-radius: 2px;
			overflow: visible;
			position: relative;
		}

		.py-toolbar-btn {
			display: inline-flex;
			align-items: center;
			justify-content: center;
			gap: 4px;
			background: transparent;
			border: 1px solid transparent;
			border-radius: 4px;
			color: var(--vscode-foreground);
			cursor: pointer;
			padding: 4px 6px;
			height: 28px;
			min-width: 28px;
		}
		.py-toolbar-btn:hover {
			background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground));
			border-color: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground));
		}
		.py-toolbar-btn .qe-icon {
			display: inline-flex;
			align-items: center;
			justify-content: center;
			width: 16px;
			height: 16px;
		}
		.py-toolbar-btn svg {
			display: block;
		}

		.py-toolbar-sep {
			width: auto;
			height: auto;
			background: transparent;
			margin: 0 2px;
			opacity: 0.9;
			color: var(--vscode-descriptionForeground);
			user-select: none;
		}
		.py-toolbar-sep::before {
			content: '|';
			display: inline-block;
			line-height: 18px;
			padding: 0 2px;
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

		.resizer {
			flex: 0 0 1px;
			height: 1px;
			cursor: ns-resize;
			background: var(--vscode-input-border, var(--vscode-widget-border, var(--vscode-panel-border, rgba(128,128,128,0.35))));
			position: relative;
			touch-action: none;
			z-index: 1;
		}
		.resizer::after {
			content: '';
			position: absolute;
			left: 0;
			right: 0;
			top: -3px;
			bottom: -3px;
		}
		.resizer::before {
			content: '';
			position: absolute;
			left: 0;
			right: 0;
			top: 50%;
			height: 0;
			transform: translateY(-50%);
			background: var(--vscode-sash-hoverBorder, #007fd4);
			transition: height 0.1s ease;
			pointer-events: none;
			z-index: 1;
		}
		.resizer:hover::before { height: 6px; }
		.resizer.is-dragging::before { height: 6px; }

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
`;