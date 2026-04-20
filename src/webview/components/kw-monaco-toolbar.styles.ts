import { css } from 'lit';

/**
 * Shared toolbar + overflow CSS for shadow DOM sections (HTML, Python).
 * Uses the same class names as `queryEditor.css` so the Kusto/SQL light DOM
 * toolbars and the HTML/Python shadow DOM toolbars look and behave identically.
 *
 * In light DOM contexts (SQL), `queryEditor.css` provides these rules.
 * In shadow DOM contexts, import this into the section's `static styles`.
 */
export const monacoToolbarStyles = css`
	/* ── Toolbar container ─────────────────────────────────────── */
	.query-editor-toolbar {
		display: flex;
		align-items: center;
		flex-wrap: nowrap;
		gap: 1px;
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

	/* ── Items container (overflow detection target) ────────────── */
	.qe-toolbar-items {
		display: flex;
		align-items: center;
		flex-wrap: nowrap;
		gap: 1px;
		flex: 1 1 0%;
		min-width: 0;
		overflow: hidden;
	}

	/* ── Separator ─────────────────────────────────────────────── */
	.query-editor-toolbar-sep {
		width: 1px;
		height: 20px;
		background: var(--vscode-descriptionForeground, rgba(128,128,128,0.4));
		opacity: 0.5;
		margin: 0 4px;
		user-select: none;
		flex-shrink: 0;
		border-radius: 0.5px;
	}

	/* ── Button ────────────────────────────────────────────────── */
	.query-editor-toolbar-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 4px;
		background: transparent;
		border: 1px solid transparent;
		border-radius: 4px;
		color: var(--vscode-foreground);
		cursor: pointer;
		padding: 4px 4px;
		height: 28px;
		min-width: 28px;
		flex-shrink: 0;
	}
	.query-editor-toolbar-btn:hover {
		background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground));
		border-color: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground));
	}
	.query-editor-toolbar-btn:active:not(:disabled) { opacity: 0.75; }
	.query-editor-toolbar-btn:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
	.query-editor-toolbar-btn:focus:not(:focus-visible) { outline: none; }
	.query-editor-toolbar-btn:disabled { opacity: 0.5; cursor: not-allowed; }
	.query-editor-toolbar-btn:disabled:hover { background: transparent; border-color: transparent; }
	.query-editor-toolbar-btn svg { display: block; }
	.query-editor-toolbar-btn .qe-icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 16px;
		height: 16px;
	}
	.query-editor-toolbar-btn.is-active {
		background: var(--vscode-toolbar-activeBackground, var(--vscode-actionBar-toggledBackground, rgba(128, 128, 128, 0.25)));
		border-color: transparent;
	}

	/* ── Image icons (e.g. copilot logo) ───────────────────────── */
	.query-editor-toolbar-btn img, .qe-toolbar-overflow-item img {
		width: 16px; height: 16px; display: block;
	}

	/* ── Overflow hide ─────────────────────────────────────────── */
	.query-editor-toolbar-btn.qe-in-overflow,
	.query-editor-toolbar-sep.qe-in-overflow {
		display: none !important;
	}

	/* ── Overflow button ───────────────────────────────────────── */
	.qe-toolbar-overflow-wrapper {
		position: relative;
		display: none;
		flex: 0 0 auto;
	}
	.qe-toolbar-overflow-wrapper.is-visible {
		display: inline-flex;
	}
	.qe-toolbar-overflow-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		background: transparent;
		border: 1px solid transparent;
		border-radius: 4px;
		color: var(--vscode-foreground);
		cursor: pointer;
		padding: 4px 6px;
		height: 28px;
		min-width: 28px;
		font-weight: bold;
		font-size: 14px;
		letter-spacing: 1px;
	}
	.qe-toolbar-overflow-btn:hover {
		background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground));
		border-color: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground));
	}
	.qe-toolbar-overflow-btn.is-active {
		background: var(--vscode-toolbar-activeBackground, var(--vscode-actionBar-toggledBackground, rgba(128, 128, 128, 0.25)));
	}

	/* ── Overflow menu ─────────────────────────────────────────── */
	.qe-toolbar-overflow-menu {
		position: fixed;
		z-index: 10000;
		min-width: 180px;
		background: var(--vscode-dropdown-background, var(--vscode-editorWidget-background));
		border: 1px solid var(--vscode-dropdown-border, var(--vscode-widget-border, rgba(128, 128, 128, 0.35)));
		border-radius: 4px;
		box-shadow: 0 2px 8px rgba(0, 0, 0, 0.16);
		padding: 4px 0;
	}
	.qe-toolbar-overflow-item {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px 12px;
		cursor: pointer;
		color: var(--vscode-foreground);
		font-size: 13px;
		white-space: nowrap;
	}
	.qe-toolbar-overflow-item:hover {
		background: var(--vscode-list-hoverBackground);
	}
	.qe-toolbar-overflow-item .qe-icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 16px;
		height: 16px;
		flex: 0 0 auto;
	}
	.qe-toolbar-overflow-item .qe-toolbar-overflow-label {
		flex: 1 1 auto;
	}
	.qe-toolbar-overflow-sep {
		height: 1px;
		background: var(--vscode-widget-border, rgba(128, 128, 128, 0.35));
		margin: 4px 8px;
	}

	/* ── Toggle checkmark / active state in overflow ────────── */
	.qe-overflow-checkmark {
		flex-shrink: 0;
		color: var(--vscode-foreground);
		margin-right: 4px;
	}
	.qe-overflow-checkmark-placeholder {
		flex-shrink: 0;
		margin-right: 4px;
	}
	.qe-toolbar-overflow-item.qe-overflow-item-active {
		font-weight: 500;
	}

	/* ── Overflow submenu (accordion) ──────────────────────── */
	.qe-toolbar-overflow-item.qe-overflow-has-submenu {
		position: relative;
	}
	.qe-toolbar-overflow-item.qe-overflow-has-submenu .qe-overflow-submenu-arrow {
		flex-shrink: 0;
		margin-left: auto;
		opacity: 0.7;
		transition: transform 0.15s ease;
	}
	.qe-toolbar-overflow-item.qe-overflow-has-submenu[aria-expanded="true"] .qe-overflow-submenu-arrow {
		transform: rotate(90deg);
	}
	.qe-toolbar-overflow-submenu-items {
		display: none;
		padding-left: 12px;
		background: var(--vscode-menu-background, var(--vscode-dropdown-background));
	}
	.qe-toolbar-overflow-submenu-items.is-expanded {
		display: block;
	}
	.qe-toolbar-overflow-submenu-items .qe-overflow-submenu-item {
		padding: 6px 12px;
	}
	.qe-toolbar-overflow-submenu-items .qe-overflow-submenu-item:hover {
		background: var(--vscode-list-hoverBackground);
	}

	/* ── Submenu wrapper (inline dropdown) ─────────────────── */
	.qe-toolbar-menu-wrapper {
		position: relative;
		display: inline-flex;
		align-items: center;
		flex-shrink: 0;
	}
	.qe-toolbar-menu-wrapper.qe-in-overflow {
		display: none !important;
	}
	.query-editor-toolbar-btn.qe-toolbar-dropdown-btn {
		gap: 2px;
		padding-left: 4px;
		padding-right: 2px;
	}
	.query-editor-toolbar-btn.qe-toolbar-dropdown-btn .qe-toolbar-caret {
		color: var(--vscode-descriptionForeground);
		line-height: 1;
		margin-left: 2px;
		pointer-events: none;
		display: inline-flex;
		align-items: center;
	}
	.query-editor-toolbar-btn.qe-toolbar-dropdown-btn .qe-toolbar-caret svg {
		width: 8px;
		height: 8px;
	}

	/* ── Submenu dropdown menu ─────────────────────────────── */
	.qe-toolbar-dropdown-menu {
		position: fixed;
		z-index: 10000;
	}
	.qe-toolbar-dropdown-menu .kusto-dropdown-item {
		display: flex;
		align-items: center;
		padding: 6px 12px;
		cursor: pointer;
		color: var(--vscode-foreground);
		font-size: 13px;
		white-space: nowrap;
	}
	.qe-toolbar-dropdown-menu .kusto-dropdown-item:hover {
		background: var(--vscode-list-hoverBackground);
	}
	.qe-toolbar-dropdown-menu .kusto-dropdown-item-main {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.qe-toolbar-dropdown-menu .qe-toolbar-menu-label {
		display: inline-flex;
		align-items: center;
		line-height: 16px;
		margin-left: 5px;
	}

	/* ── Busy spinner ──────────────────────────────────────── */
	.schema-spinner.qe-tools-spinner {
		width: 16px;
		height: 16px;
		border: 2px solid var(--vscode-foreground);
		border-top-color: transparent;
		border-radius: 50%;
		animation: qe-spin 0.8s linear infinite;
	}
	@keyframes qe-spin {
		to { transform: rotate(360deg); }
	}

	/* ── Copilot logo (image + SVG fallback) ───────────────── */
	.query-editor-toolbar-btn img.copilot-logo {
		width: 16px; height: 16px; display: block;
	}
	.query-editor-toolbar-btn .copilot-logo-svg {
		width: 16px; height: 16px; display: block; stroke-width: 1.8px;
	}
	.qe-toolbar-overflow-item img.copilot-logo {
		width: 16px; height: 16px; display: block;
	}
	.qe-toolbar-overflow-item .copilot-logo-svg {
		width: 16px; height: 16px; display: block; stroke-width: 1.8px;
	}

	/* Dark / high-contrast: invert the copilot logo image.
	   Uses :host-context() because this CSS runs inside shadow DOM
	   (HTML/Python sections) where body.vscode-dark is not directly visible. */
	:host-context(body.vscode-dark) .query-editor-toolbar-btn img.copilot-logo,
	:host-context(body.vscode-high-contrast) .query-editor-toolbar-btn img.copilot-logo,
	:host-context(body.vscode-high-contrast-light) .query-editor-toolbar-btn img.copilot-logo,
	:host-context(body.vscode-dark) .qe-toolbar-overflow-item img.copilot-logo,
	:host-context(body.vscode-high-contrast) .qe-toolbar-overflow-item img.copilot-logo,
	:host-context(body.vscode-high-contrast-light) .qe-toolbar-overflow-item img.copilot-logo {
		filter: invert(1);
	}
`;

