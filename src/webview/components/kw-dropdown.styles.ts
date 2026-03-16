import { css } from 'lit';

export const styles = css`
	:host {
		display: inline-flex;
		align-items: center;
		width: 100%;
		position: relative;
		font-family: var(--vscode-font-family);
		font-size: var(--vscode-font-size);
		container-type: inline-size;
	}
	*, *::before, *::after { box-sizing: border-box; }

	/* ── Button ─────────────────────────────────────────────────── */
	.kusto-dropdown-btn {
		width: 100%;
		display: inline-flex;
		align-items: center;
		justify-content: flex-start;
		position: relative;
		background-color: var(--vscode-dropdown-background);
		color: var(--vscode-dropdown-foreground);
		border: 1px solid var(--vscode-dropdown-border);
		border-radius: 2px;
		padding: 6px 24px 6px 8px;
		min-height: 27px;
		font-size: 12px;
		cursor: pointer;
		text-align: left;
		font-family: inherit;
	}
	:host([has-icon]) .kusto-dropdown-btn {
		padding-left: 28px;
	}
	.kusto-dropdown-btn:hover {
		background-color: var(--vscode-dropdown-background);
		border-color: var(--vscode-dropdown-border);
	}
	.kusto-dropdown-btn:focus {
		outline: none;
		border-color: var(--vscode-focusBorder);
	}
	.kusto-dropdown-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.kusto-dropdown-btn-icon {
		position: absolute;
		left: 8px;
		top: 50%;
		transform: translateY(-50%);
		pointer-events: none;
		z-index: 1;
		opacity: 0.95;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 16px;
		height: 16px;
	}
	.kusto-dropdown-btn-text {
		display: inline-flex;
		align-items: baseline;
		gap: 6px;
		flex: 1 1 auto;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.kusto-dropdown-btn-caret {
		position: absolute;
		right: 3px;
		top: 50%;
		transform: translateY(-50%);
		pointer-events: none;
		width: 16px;
		height: 16px;
		display: flex;
		align-items: center;
		justify-content: center;
	}
	.kusto-dropdown-btn-caret svg {
		width: 16px;
		height: 16px;
		fill: currentColor;
		color: var(--vscode-foreground);
		opacity: 0.8;
	}

	/* ── Menu ───────────────────────────────────────────────────── */
	.kusto-dropdown-menu {
		position: fixed;
		left: 0;
		top: 0;
		width: max-content;
		min-width: 100%;
		max-width: 350px;
		max-height: 280px;
		overflow: auto;
		z-index: 100000;
		background: var(--vscode-dropdown-background);
		border: 1px solid var(--vscode-dropdown-border);
		box-shadow: 0 2px 10px var(--vscode-widget-shadow);
		box-sizing: border-box;
	}

	/* ── Items ──────────────────────────────────────────────────── */
	.kusto-dropdown-item {
		padding: 4px 8px;
		cursor: pointer;
		font-size: 12px;
		line-height: 1.4;
		user-select: none;
		white-space: nowrap;
		display: flex;
		align-items: center;
		gap: 8px;
		color: var(--vscode-dropdown-foreground);
	}
	.kusto-dropdown-item:hover,
	.kusto-dropdown-item.is-selected,
	.kusto-dropdown-item.is-focused {
		background: var(--vscode-list-hoverBackground);
		color: var(--vscode-foreground);
	}
	.kusto-dropdown-item.is-disabled {
		cursor: default;
		color: var(--vscode-descriptionForeground);
		background: transparent;
	}
	.kusto-dropdown-item:focus { outline: none; }
	.kusto-dropdown-item:focus-visible {
		outline: 1px solid var(--vscode-focusBorder);
		outline-offset: -1px;
	}
	.kusto-dropdown-item-main {
		flex: 1 1 auto;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.kusto-dropdown-item-icon {
		flex: 0 0 auto;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 16px;
		height: 16px;
	}
	.kusto-dropdown-empty {
		padding: 8px;
		font-size: 12px;
		color: var(--vscode-descriptionForeground);
	}

	/* ── Primary / Secondary text ──────────────────────────────── */
	.kusto-dropdown-primary {
		color: var(--vscode-dropdown-foreground);
		font-weight: 600;
	}
	.kusto-dropdown-secondary {
		color: var(--vscode-descriptionForeground);
	}

	/* ── Trash button ──────────────────────────────────────────── */
	.kusto-dropdown-trash {
		flex: 0 0 auto;
		width: 24px;
		height: 24px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		background: transparent;
		border: 1px solid transparent;
		border-radius: 4px;
		color: var(--vscode-descriptionForeground);
		padding: 0;
		visibility: hidden;
		pointer-events: none;
		cursor: pointer;
	}
	.kusto-dropdown-item:hover .kusto-dropdown-trash,
	.kusto-dropdown-item.is-focused .kusto-dropdown-trash {
		visibility: visible;
		pointer-events: auto;
	}
	.kusto-dropdown-trash:hover {
		background: var(--vscode-list-hoverBackground);
		border-color: var(--vscode-input-border);
		color: var(--vscode-foreground);
	}

	/* ── Action items ──────────────────────────────────────────── */
	.kusto-dropdown-action {
		padding: 4px 8px;
		cursor: pointer;
		font-size: 12px;
		line-height: 1.4;
		user-select: none;
		white-space: nowrap;
		display: flex;
		align-items: center;
		gap: 8px;
		color: var(--vscode-dropdown-foreground);
	}
	.kusto-dropdown-action:hover,
	.kusto-dropdown-action.is-focused {
		background: var(--vscode-list-hoverBackground);
		color: var(--vscode-foreground);
	}
	.kusto-dropdown-action:focus { outline: none; }
	.kusto-dropdown-action:focus-visible {
		outline: 1px solid var(--vscode-focusBorder);
		outline-offset: -1px;
	}

	/* ── compact-icon-only: hide icon at normal width ──────────── */
	:host([compact-icon-only]) .kusto-dropdown-btn-icon { display: none; }
	:host([compact-icon-only]) .kusto-dropdown-btn { padding-left: 8px; }

	/* ── Compact mode (container query on host) ────────────────── */
	@container (max-width: 40px) {
		.kusto-dropdown-btn-text { display: none; }
		.kusto-dropdown-btn-caret { display: none; }
		.kusto-dropdown-btn { padding: 4px; justify-content: center; }
		:host([has-icon]) .kusto-dropdown-btn { padding: 4px; }
		:host([has-icon]) .kusto-dropdown-btn-icon {
			left: 50%;
			transform: translate(-50%, -50%);
		}
		:host([compact-icon-only]) .kusto-dropdown-btn-icon { display: inline-flex; }
	}
`;
