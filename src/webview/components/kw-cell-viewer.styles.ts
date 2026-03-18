import { css } from 'lit';

export const styles = css`
	*, *::before, *::after { box-sizing: border-box; }
	:host { display: contents; }

	.modal-backdrop {
		position: fixed; top: 0; left: 0; right: 0; bottom: 0;
		background: rgba(0, 0, 0, 0.6); z-index: 10000;
		display: flex; align-items: center; justify-content: center;
	}
	.modal-content {
		background: var(--vscode-editor-background);
		border: 1px solid var(--vscode-panel-border);
		border-radius: 4px;
		width: 90%; max-width: 1400px; height: 85%;
		display: flex; flex-direction: column;
		box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
	}
	.modal-header {
		padding: 12px 16px;
		border-bottom: 1px solid var(--vscode-panel-border);
		display: flex; justify-content: space-between; align-items: center;
		background: var(--vscode-editorGroupHeader-tabsBackground);
		gap: 12px;
	}
	.modal-header h3 {
		margin: 0; font-size: 14px; font-weight: 600;
		white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0;
	}
	.modal-body {
		flex: 1; overflow: auto; padding: 16px; min-height: 0;
	}

	/* Search */
	.search-area {
		display: flex; gap: 8px; align-items: center; flex: 1; min-width: 0;
	}
	.search-results {
		font-size: 11px; color: var(--vscode-descriptionForeground); white-space: nowrap;
	}

	/* Buttons */
	.close-btn {
		background: transparent; border: none; color: var(--vscode-foreground); cursor: pointer;
		display: flex; align-items: center; justify-content: center;
		width: 28px; height: 28px; border-radius: 4px; padding: 0; flex-shrink: 0;
	}
	.close-btn:hover { background: var(--vscode-list-hoverBackground); }

	.tool-btn {
		background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);
		border: 1px solid var(--vscode-button-border, transparent); border-radius: 2px;
		padding: 4px 8px; cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 14px;
	}
	.tool-btn:hover { background: var(--vscode-button-secondaryHoverBackground); }

	.actions { display: inline-flex; gap: 4px; align-items: center; }

	/* Cell value */
	.cell-value {
		font-family: var(--vscode-editor-font-family);
		font-size: var(--vscode-editor-font-size);
		line-height: 1.6;
		white-space: pre-wrap;
		word-break: break-word;
		user-select: text;
		color: var(--vscode-editor-foreground);
	}

	/* Search highlights */
	.cell-highlight {
		background: var(--vscode-editor-findMatchHighlightBackground);
		border-radius: 2px;
		outline: 1px solid var(--vscode-editor-findMatchHighlightBorder);
		outline-offset: -1px;
	}
	.cell-highlight-current {
		background: var(--vscode-editor-findMatchBackground);
		outline: 2px solid var(--vscode-focusBorder);
		outline-offset: -2px;
	}
`;
