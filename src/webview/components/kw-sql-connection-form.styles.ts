import { css } from 'lit';

export const styles = css`
	*, *::before, *::after { box-sizing: border-box; }

	:host {
		display: block;
		font-family: var(--vscode-font-family);
		font-size: var(--vscode-font-size);
		color: var(--vscode-editor-foreground);
	}

	.form-group { margin-bottom: 12px; }
	.form-group label { display: block; font-size: 12px; margin-bottom: 4px; }
	.form-group input {
		width: 100%;
		padding: 6px 8px;
		background: var(--vscode-input-background);
		color: var(--vscode-input-foreground);
		border: 1px solid var(--vscode-input-border);
		border-radius: 2px;
		font-family: inherit;
		font-size: 13px;
	}
	.form-group input:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
	.form-group input::placeholder { color: var(--vscode-input-placeholderForeground); }
	.form-group select {
		width: 100%;
		padding: 6px 8px;
		background: var(--vscode-input-background);
		color: var(--vscode-input-foreground);
		border: 1px solid var(--vscode-input-border);
		border-radius: 2px;
		font-family: inherit;
		font-size: 13px;
	}
	.form-group select:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
	.form-group input[type="checkbox"] { width: auto; margin-right: 6px; vertical-align: middle; }
	.form-row { display: flex; gap: 12px; }

	/* Spinner animation */
	@keyframes spin { to { transform: rotate(360deg); } }
	.spin, :host svg.spin { animation: spin 1s linear infinite; }

	.btn {
		display: inline-flex; align-items: center; gap: 6px;
		padding: 6px 14px; font-size: 12px; border-radius: 2px;
		border: 1px solid var(--vscode-button-border, transparent);
		background: var(--vscode-button-secondaryBackground);
		color: var(--vscode-button-secondaryForeground);
		cursor: pointer; font-family: inherit;
	}
	.btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
	.btn svg { width: 14px; height: 14px; fill: currentColor; }

	.test-result {
		margin-top: 8px; font-size: 12px;
		display: flex; align-items: center; gap: 6px;
	}
	.test-result svg {
		width: 16px; height: 16px;
		min-width: 16px; min-height: 16px;
		max-width: 16px; max-height: 16px;
		flex-shrink: 0;
	}
`;
