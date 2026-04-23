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
