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

		.section-root {
			padding: 12px;
			padding-bottom: 0;
		}

		.section-header-row {
			display: flex;
			gap: 8px;
			align-items: center;
			justify-content: space-between;
			margin-bottom: 8px;
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

		.section-title {
			font-size: 12px;
			color: var(--vscode-foreground);
			font-weight: 600;
		}

		.section-actions {
			display: inline-flex;
			gap: 8px;
			align-items: center;
		}

		.md-tabs {
			display: inline-flex;
			gap: 2px;
			align-items: center;
			border: none;
			border-radius: 0;
			overflow: visible;
			margin: 0;
		}

		.section-btn {
			background: transparent;
			border: 1px solid var(--vscode-input-border);
			color: var(--vscode-foreground);
			cursor: pointer;
			padding: 4px 8px;
			font-size: 12px;
			border-radius: 4px;
		}
		.section-btn:hover {
			background: var(--vscode-list-hoverBackground);
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

		/* Editor wrapper — slotted content (Monaco) lives in light DOM */
		.editor-wrapper {
			position: relative;
			width: 100%;
			min-height: 120px;
			height: 325px;
			margin: 8px 0;
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
			font-family: var(--vscode-editor-font-family);
			font-size: 12px;
			white-space: pre-wrap;
			overflow: auto;
			max-height: 320px;
		}
`;