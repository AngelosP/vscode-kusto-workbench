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
			padding-bottom: 2px;
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

		.header-tabs {
			display: inline-flex;
			gap: 2px;
			align-items: center;
			border: none;
			border-radius: 0;
			overflow: visible;
			margin: 0;
			background: transparent;
		}

		.header-tab {
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
		.header-tab svg {
			display: block;
		}
		.header-tab:hover {
			background: var(--vscode-list-hoverBackground);
		}
		.header-tab.is-active {
			background: var(--vscode-list-hoverBackground);
			border-color: var(--vscode-input-border);
		}

		.header-tab.run-btn {
			width: auto;
			padding: 0 10px;
			gap: 4px;
			font-size: 12px;
			line-height: 1;
			height: 28px;
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

		.close-btn {
			background: transparent;
			border: 1px solid transparent;
			color: var(--vscode-foreground);
			border-radius: 4px;
			cursor: pointer;
			width: 28px;
			height: 28px;
			min-width: 28px;
			padding: 0;
			display: inline-flex;
			align-items: center;
			justify-content: center;
		}
		.close-btn svg {
			display: block;
		}
		.close-btn:hover {
			background: var(--vscode-list-hoverBackground);
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