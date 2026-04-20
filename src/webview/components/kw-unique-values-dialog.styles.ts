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
		border-radius: 4px; width: 80%; max-width: 1200px; max-height: 80%;
		display: flex; flex-direction: column;
		box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
	}
	.modal-header {
		padding: 12px 16px;
		border-bottom: 1px solid var(--vscode-panel-border);
		display: flex; justify-content: space-between; align-items: center;
		background: var(--vscode-editorGroupHeader-tabsBackground);
	}
	.modal-header h3 { margin: 0; font-size: 14px; font-weight: 600; }
	.modal-body {
		flex: 1; overflow: hidden; padding: 16px; overscroll-behavior: contain;
		display: flex; flex-direction: column; gap: 16px; min-height: 0;
	}
	.table-panel { flex: 0 0 auto; min-width: 0; overflow: hidden; display: flex; flex-direction: column; }
	.table-panel kw-data-table { flex: 1; min-height: 0; }
	.chart-panel { flex: 0 0 auto; display: flex; flex-direction: column; align-items: stretch; }
	.chart-controls {
		display: flex; align-items: center; gap: 8px; padding: 0 4px 4px;
		font-size: 11px; color: var(--vscode-descriptionForeground);
	}
	.slider-label { white-space: nowrap; }
	.chart-controls input[type=range] { flex: 1; max-width: 140px; height: 4px; accent-color: var(--vscode-focusBorder); }
	.chart-container { width: 100%; height: 260px; }

	.close-btn {
		background: transparent; border: none; color: var(--vscode-foreground); cursor: pointer;
		display: flex; align-items: center; justify-content: center;
		width: 28px; height: 28px; border-radius: 4px; padding: 0;
	}
	.close-btn:hover { background: var(--vscode-list-hoverBackground); }

	.uv-column-picker {
		display: flex; align-items: center; gap: 8px;
		padding: 0 4px 4px; font-size: 12px; color: var(--vscode-foreground);
	}
	.uv-column-picker label { white-space: nowrap; color: var(--vscode-descriptionForeground); }
	.uv-column-picker select {
		background: var(--vscode-dropdown-background);
		color: var(--vscode-dropdown-foreground);
		border: 1px solid var(--vscode-dropdown-border);
		border-radius: 0; padding: 4px 6px;
		font-size: 12px; font-family: inherit;
	}
`;
