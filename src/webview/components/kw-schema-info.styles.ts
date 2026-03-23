import { css } from 'lit';

export const styles = css`
	:host {
		display: block;
		position: relative;
		flex: 0 0 auto;
		margin-left: auto;
	}

	/* ── Trigger button ────────────────────────────────────────── */
	.schema-info-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		background: transparent;
		border: 1px solid transparent;
		border-radius: 4px;
		color: var(--vscode-descriptionForeground);
		cursor: pointer;
		padding: 4px;
		width: 28px;
		height: 28px;
		position: relative;
	}
	.schema-info-btn:hover {
		background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground));
		color: var(--vscode-foreground);
	}
	.schema-info-btn:focus { outline: none; }
	.schema-info-btn:focus-visible { border-color: var(--vscode-focusBorder); }
	.schema-info-btn.is-open {
		background: var(--vscode-toolbar-activeBackground, rgba(128, 128, 128, 0.25));
		color: var(--vscode-foreground);
	}
	.schema-info-btn svg { width: 18px; height: 16px; }
	.schema-info-btn.is-loading svg { display: none; }
	.schema-info-btn.is-loading::after {
		content: '';
		display: block;
		width: 14px;
		height: 14px;
		box-sizing: border-box;
		border-radius: 50%;
		border: 2px solid var(--vscode-editorWidget-border);
		border-top-color: var(--vscode-progressBar-background);
		animation: schema-spin 0.9s linear infinite;
	}
	.schema-info-btn.has-schema { color: var(--vscode-descriptionForeground); }
	.schema-info-btn.is-error { color: var(--vscode-errorForeground, #f48771); }
	.schema-info-btn.is-cached { color: var(--vscode-descriptionForeground); }

	@keyframes schema-spin {
		to { transform: rotate(360deg); }
	}

	/* ── Popover panel ─────────────────────────────────────────── */
	.schema-info-popover {
		position: fixed;
		z-index: 10000;
		min-width: 180px;
		max-width: 250px;
		background: var(--vscode-editorHoverWidget-background, #252526);
		border: 1px solid var(--vscode-editorHoverWidget-border, #454545);
		border-radius: 4px;
		box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
		padding: 0;
	}
	.schema-info-popover-content { padding: 10px 12px; }
	.schema-info-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		font-size: 12px;
		padding: 3px 0;
	}
	.schema-info-label { color: var(--vscode-descriptionForeground); flex: 0 0 auto; }
	.schema-info-value { color: var(--vscode-foreground); font-weight: 500; }
	.schema-info-status { color: var(--vscode-foreground); font-weight: 500; }
	.schema-info-status.is-error { color: var(--vscode-errorForeground, #f48771); }
	.schema-info-cached-link {
		color: var(--vscode-charts-blue, #4fc1ff);
		text-decoration: underline;
		cursor: pointer;
	}
	.schema-info-cached-link:hover { color: var(--vscode-textLink-activeForeground, #3794ff); }
	.schema-info-actions { margin-top: 8px; }
	.schema-info-refresh-btn {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		background: transparent;
		border: 1px solid var(--vscode-button-border, transparent);
		border-radius: 4px;
		color: var(--vscode-foreground);
		cursor: pointer;
		padding: 4px 8px;
		font-size: 12px;
		width: 100%;
		justify-content: center;
		font-family: inherit;
	}
	.schema-info-refresh-btn:hover {
		background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground));
	}
	.schema-info-refresh-btn:disabled { opacity: 0.5; cursor: not-allowed; }
	.schema-info-refresh-btn svg { width: 14px; height: 14px; }
`;
