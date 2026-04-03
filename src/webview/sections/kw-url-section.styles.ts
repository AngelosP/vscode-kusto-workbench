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
			padding-bottom: 4px;
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

		/* ── URL input (slotted into shell header-extra) ──────────────── */

		.url-input {
			flex: 1 1 auto;
			width: 100%;
			min-width: 25px;
			background: var(--vscode-input-background);
			color: var(--vscode-input-foreground);
			border: 1px solid var(--vscode-input-border);
			border-radius: 4px;
			padding: 6px 8px;
			font-size: 12px;
			font-family: inherit;
			outline: none;
			margin-bottom: 10px;
		}
		.url-input:focus {
			border-color: var(--vscode-focusBorder);
		}

		/* ── Status / error messages ──────────────────────────────────── */

		.url-status-msg {
			font-size: 12px;
			padding: 6px 2px;
			color: var(--vscode-descriptionForeground);
			white-space: pre-wrap;
		}
		.url-error-msg {
			color: var(--vscode-errorForeground, var(--vscode-editorError-foreground, #f44));
		}

		/* ── Image menu button (slotted into shell header-buttons) ───── */

		.img-menu-anchor { position: relative; }

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
		.md-tab svg { display: block; }
		.md-tab:hover { background: var(--vscode-list-hoverBackground); }

		/* ── Output wrapper ───────────────────────────────────────────── */

		.output-wrapper {
			position: relative;
			width: 100%;
			min-height: 120px;
			height: 120px;
			margin: 8px 0 0;
			overflow: visible;
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
			flex: 0 0 1px;
			height: 1px;
			cursor: ns-resize;
			background: var(--vscode-panel-border, rgba(128,128,128,0.35));
			position: relative;
			touch-action: none;
			z-index: 1;
			margin: 0 -12px -1px -12px;
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
		.resizer:hover::before { height: 6px; transition-delay: var(--kw-sash-reveal-delay, 0.5s); }
		.resizer.is-dragging::before { height: 6px; transition-delay: 0s; }

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