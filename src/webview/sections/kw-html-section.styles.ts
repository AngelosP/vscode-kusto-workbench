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

	:host(.is-collapsed) .editor-wrapper,
	:host(.is-collapsed) .preview-wrapper,
	:host(.is-collapsed) .html-toolbar {
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

	/* ── Mode buttons (reuse chart-section pattern) ──────────────────── */

	.html-mode-buttons {
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

	/* ── Export / share button (icon-only, matches query section header-tab) ── */

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
		outline: none;
		margin-left: 2px;
	}
	.header-tab svg { display: block; }
	.header-tab:hover { background: var(--vscode-list-hoverBackground); }

	/* ── Toolbar ──────────────────────────────────────────────────────── */

	.html-toolbar {
		display: flex;
		align-items: center;
		gap: 2px;
		padding: 2px 4px;
		border: 1px solid var(--vscode-input-border, var(--vscode-widget-border, var(--vscode-panel-border, rgba(128,128,128,0.25))));
		border-bottom: 1px solid var(--vscode-editorGroup-border, #444);
		border-radius: 2px 2px 0 0;
		background: var(--vscode-editor-background, #1e1e1e);
		min-height: 28px;
		flex-shrink: 0;
	}

	.html-toolbar-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 26px;
		height: 26px;
		background: transparent;
		border: none;
		border-radius: 3px;
		color: var(--vscode-foreground, #ccc);
		cursor: pointer;
		padding: 0;
		flex-shrink: 0;
	}

	.html-toolbar-btn:hover {
		background: var(--vscode-toolbar-hoverBackground, rgba(90, 93, 94, 0.31));
	}

	.html-toolbar-btn:active {
		background: var(--vscode-toolbar-activeBackground, rgba(99, 102, 103, 0.31));
	}

	.html-toolbar-btn[disabled] {
		opacity: 0.4;
		cursor: default;
	}

	.html-toolbar-btn.is-active {
		background: var(--vscode-toolbar-activeBackground, var(--vscode-actionBar-toggledBackground, rgba(128, 128, 128, 0.25)));
	}

	.html-toolbar-sep {
		display: inline-block;
		width: 1px;
		height: 18px;
		background: var(--vscode-editorGroup-border, #444);
		margin: 0 4px;
		flex-shrink: 0;
	}

	/* ── Editor wrapper ──────────────────────────────────────────────── */

	.editor-wrapper {
		position: relative;
		width: 100%;
		min-height: 120px;
		height: 325px;
		border-left: 1px solid var(--vscode-input-border, var(--vscode-widget-border, var(--vscode-panel-border, rgba(128,128,128,0.25))));
		border-right: 1px solid var(--vscode-input-border, var(--vscode-widget-border, var(--vscode-panel-border, rgba(128,128,128,0.25))));
		border-top: none;
		border-bottom: none;
		border-radius: 0 0 2px 2px;
		background: var(--vscode-editor-background);
		overflow: hidden;
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
	}

	/* ── Placeholder ghost text ──────────────────────────────────────── */

	.editor-placeholder {
		position: absolute;
		top: 0;
		left: 64px;
		padding-top: 4px;
		color: var(--vscode-editorGhostText-foreground, var(--vscode-descriptionForeground, rgba(150, 150, 150, 0.5)));
		font-family: var(--vscode-font-family, 'Segoe UI', system-ui, sans-serif);
		font-size: 12px;
		font-style: italic;
		font-weight: 300;
		letter-spacing: 0.3px;
		pointer-events: none;
		z-index: 1;
		user-select: none;
		white-space: nowrap;
	}

	/* ── Preview wrapper ─────────────────────────────────────────────── */

	.preview-wrapper {
		display: flex;
		flex-direction: column;
		height: 400px;
		min-height: 120px;
		overflow: hidden;
		position: relative;
		background: var(--vscode-editor-background, #1e1e1e);
	}

	.preview-iframe {
		flex: 1 1 auto;
		width: 100%;
		min-height: 0;
		border: none;
		background: #fff;
	}

	.preview-empty {
		display: flex;
		align-items: center;
		justify-content: center;
		flex: 1;
		color: var(--vscode-descriptionForeground, #888);
		font-style: italic;
		font-size: 13px;
	}

	/* ── Resizer (matches query-editor-resizer / chart-bottom-resizer pattern) ── */

	.resizer {
		flex: 0 0 1px;
		height: 1px;
		cursor: ns-resize;
		background: var(--vscode-panel-border, rgba(128,128,128,0.35));
		position: relative;
		touch-action: none;
		z-index: 2;
		/* Bleed edge-to-edge to overlap section border */
		margin: 0 -1px -1px;
		width: calc(100% + 2px);
	}

	/* Extended hit area for comfortable resizing */
	.resizer::after {
		content: '';
		position: absolute;
		left: 0;
		right: 0;
		top: -3px;
		bottom: -3px;
	}

	/* Sash highlight on hover / drag */
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

	.resizer:hover::before,
	.resizer.is-dragging::before {
		height: 6px;
		transition-delay: var(--kw-sash-reveal-delay, 0.5s);
	}
`;
