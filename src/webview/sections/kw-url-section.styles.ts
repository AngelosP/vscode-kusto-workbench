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
			padding-bottom: 0;
		}

		:host(.is-url-collapsed) {
			margin-bottom: 26px;
		}
		:host(.is-url-collapsed) .section-root {
			padding-bottom: 3px;
		}
		:host(.is-url-collapsed) .output-wrapper {
			display: none !important;
		}
		:host(.is-url-collapsed) .md-max-btn {
			display: none !important;
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

		.query-name-group {
			display: inline-flex;
			align-items: center;
			gap: 0;
			min-width: 0;
			flex: 0 1 auto;
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
			flex: 0 1 auto;
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

		.url-input {
			flex: 1 1 420px;
			min-width: 25px;
			background: var(--vscode-input-background);
			color: var(--vscode-input-foreground);
			border: 1px solid var(--vscode-input-border);
			border-radius: 4px;
			padding: 6px 8px;
			font-size: 12px;
			font-family: inherit;
			outline: none;
		}
		.url-input:focus {
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
		.md-tab.is-active {
			background: var(--vscode-list-hoverBackground);
			border-color: var(--vscode-input-border);
		}

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

		/* Output wrapper — contains the URL content and the resize handle */
		.output-wrapper {
			position: relative;
			width: 100%;
			min-height: 120px;
			height: 120px;
			margin: 8px 0 0;
			overflow: hidden;
			display: flex;
			flex-direction: column;
			background: transparent;
		}

		.url-output {
			border: none;
			border-radius: 0;
			background: transparent;
			padding: 0;
			font-family: var(--vscode-editor-font-family);
			font-size: 12px;
			overflow: hidden auto;
			max-height: none;
			flex: 1 1 auto;
			min-height: 0;
			display: flex;
			flex-direction: column;
			min-width: 0;
			scrollbar-width: thin;
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

		/* Image display mode dropdown */
		.img-menu-anchor { position: relative; }
		.img-menu {
			position: absolute;
			top: 100%;
			right: 0;
			z-index: 100;
			min-width: 210px;
			background: var(--vscode-menu-background, var(--vscode-editor-background));
			color: var(--vscode-menu-foreground, var(--vscode-foreground));
			border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border));
			border-radius: 0;
			padding: 4px 0;
			box-shadow: 0 4px 12px rgba(0,0,0,.35);
			font-size: 12px;
		}
		.img-menu-label {
			padding: 4px 12px 2px;
			font-size: 11px;
			color: var(--vscode-descriptionForeground);
			user-select: none;
		}
		.img-menu-item {
			display: flex;
			align-items: center;
			gap: 6px;
			padding: 4px 12px;
			cursor: pointer;
			white-space: nowrap;
		}
		.img-menu-item:hover {
			background: var(--vscode-list-hoverBackground);
		}
		.img-menu-check {
			width: 16px;
			text-align: center;
			flex: 0 0 16px;
			font-size: 12px;
		}
		.img-menu-sep {
			height: 1px;
			background: var(--vscode-menu-separatorBackground, var(--vscode-panel-border));
			margin: 4px 0;
		}

		/* Image render modes */

		/* Mode A: Original size — raw image, container scrolls */
		.url-output.img-fill {
			overflow: auto;
		}
		.url-output.img-fill img {
			max-width: none;
			width: auto;
			height: auto;
			flex: 0 0 auto;
		}

		/* Mode B: Fill section — image adapts to container */
		.url-output.img-natural img {
			width: auto;
			height: auto;
			flex: 0 0 auto;
		}
		/* Mode B + Shrink to fit (default) — image shrinks proportionally */
		.url-output.img-natural.img-shrink img {
			max-width: 100%;
			max-height: 100%;
			object-fit: contain;
		}
		/* Mode B + Show scrollbar — image stays at natural size, container scrolls */
		.url-output.img-natural.img-scroll {
			overflow: auto;
		}
		.url-output.img-natural.img-scroll img {
			max-width: none;
			max-height: none;
		}

		/* Alignment (Mode B only) */
		.url-output.img-align-left { align-items: flex-start; }
		.url-output.img-align-center { align-items: center; }
		.url-output.img-align-right { align-items: flex-end; }
`;