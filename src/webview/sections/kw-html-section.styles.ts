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

	:host(.is-collapsed) .editor-wrapper,
	:host(.is-collapsed) .preview-wrapper {
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
		position: relative;
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
	.header-tab:hover:not(:disabled) { background: var(--vscode-list-hoverBackground); }
	.header-tab:disabled { opacity: 0.5; cursor: not-allowed; }
	.header-tab-tooltip-wrapper[aria-disabled="true"] .header-tab { pointer-events: none; }
	.header-tab-tooltip-wrapper {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border-radius: 4px;
	}
	.header-tab-tooltip-wrapper:focus-visible {
		outline: 1px solid var(--vscode-focusBorder);
		outline-offset: 1px;
	}
	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}

	.power-bi-upgrade-notice {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		margin: 6px 0 8px;
		padding: 6px 8px;
		border: 1px solid var(--vscode-notifications-border, var(--vscode-widget-border, var(--vscode-panel-border, rgba(128,128,128,0.35))));
		border-radius: 2px;
		background: var(--vscode-notifications-background, var(--vscode-editorWidget-background, var(--vscode-editor-background)));
		color: var(--vscode-notifications-foreground, var(--vscode-foreground));
		box-shadow: 0 2px 8px var(--vscode-widget-shadow, transparent);
		box-sizing: border-box;
	}
	.power-bi-upgrade-icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 16px;
		height: 16px;
		flex: 0 0 16px;
		color: var(--vscode-notificationsInfoIcon-foreground, var(--vscode-icon-foreground, var(--vscode-foreground)));
	}
	.power-bi-upgrade-icon .codicon {
		font-size: 16px;
	}
	.power-bi-upgrade-icon:focus-visible {
		outline: 1px solid var(--vscode-focusBorder);
		outline-offset: 1px;
	}
	.power-bi-upgrade-copy {
		min-width: 0;
		flex: 1 1 auto;
	}
	.power-bi-upgrade-title {
		font-size: 12px;
		font-weight: 600;
		line-height: 1.4;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.power-bi-upgrade-actions {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		flex: 0 0 auto;
		flex-wrap: nowrap;
		white-space: nowrap;
	}
	.power-bi-upgrade-primary,
	.power-bi-upgrade-secondary,
	.power-bi-upgrade-close {
		font-family: var(--vscode-font-family);
		font-size: 12px;
		line-height: 1;
		border-radius: 2px;
		cursor: pointer;
		flex: 0 0 auto;
		white-space: nowrap;
		box-sizing: border-box;
	}
	.power-bi-upgrade-primary {
		border: 1px solid var(--vscode-button-border, transparent);
		background: var(--vscode-button-background);
		color: var(--vscode-button-foreground);
		height: 22px;
		padding: 2px 9px;
	}
	.power-bi-upgrade-primary:hover {
		background: var(--vscode-button-hoverBackground);
	}
	.power-bi-upgrade-secondary {
		border: 1px solid var(--vscode-button-border, transparent);
		background: var(--vscode-button-secondaryBackground, transparent);
		color: var(--vscode-button-secondaryForeground, var(--vscode-notifications-foreground, var(--vscode-foreground)));
		height: 22px;
		padding: 2px 9px;
	}
	.power-bi-upgrade-secondary:hover {
		background: var(--vscode-button-secondaryHoverBackground, var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground)));
	}
	.power-bi-upgrade-close {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border: 1px solid transparent;
		background: transparent;
		color: var(--vscode-icon-foreground, var(--vscode-notifications-foreground, var(--vscode-foreground)));
		width: 22px;
		height: 22px;
		padding: 0;
	}
	.power-bi-upgrade-close:hover {
		background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground));
	}
	.power-bi-upgrade-close .codicon {
		font-size: 14px;
	}
	.power-bi-upgrade-primary:focus-visible,
	.power-bi-upgrade-secondary:focus-visible,
	.power-bi-upgrade-close:focus-visible {
		outline: 1px solid var(--vscode-focusBorder);
		outline-offset: 1px;
	}
	/* ── Editor wrapper ──────────────────────────────────────────────── */

	.editor-wrapper {
		position: relative;
		width: 100%;
		min-height: 120px;
		height: 325px;
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
	}

	/* Container that holds the editor slot and the placeholder ghost text.
	   Positioned 'relative' so the absolutely-positioned placeholder sits
	   inside the editor area (below the toolbar) instead of overlapping it. */
	.editor-area {
		position: relative;
		flex: 1 1 auto;
		min-height: 0;
		display: flex;
		flex-direction: column;
	}

	/* ── Placeholder ghost text ──────────────────────────────────────── */

	.editor-placeholder {
		position: absolute;
		top: -3px;
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
		z-index: 2;
	}
`];
