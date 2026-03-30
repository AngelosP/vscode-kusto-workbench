import { css } from 'lit';

export const styles = css`
		:host { display: contents; }
		.backdrop {
			display: none; position: fixed; inset: 0;
			background: rgba(0,0,0,0.6); z-index: 10000;
			align-items: center; justify-content: center;
		}
		.backdrop.visible { display: flex; }
		.content {
			background: var(--vscode-editor-background);
			border: 1px solid var(--vscode-panel-border);
			border-radius: 4px;
			width: 92%; max-width: 1400px; max-height: 86vh;
			display: flex; flex-direction: column;
			box-shadow: 0 4px 20px rgba(0,0,0,0.3);
		}
		.header {
			padding: 10px 12px;
			border-bottom: 1px solid var(--vscode-panel-border);
			display: flex; gap: 12px; align-items: center;
			background: var(--vscode-editorGroupHeader-tabsBackground);
		}
		.header h3 { margin: 0; font-size: 13px; font-weight: 600; white-space: nowrap; }
		.close-btn {
			margin-left: auto;
			background: transparent; border: 1px solid transparent;
			color: var(--vscode-foreground); cursor: pointer;
			width: 28px; height: 28px; display: flex; align-items: center; justify-content: center;
			border-radius: 4px; padding: 0;
		}
		.close-btn:hover { background: var(--vscode-toolbar-hoverBackground); }
		.body {
			flex: 0 1 auto; overflow: auto; padding: 10px; min-height: 0;
		}
		.diff-section { margin-bottom: 14px; }
		/* kw-data-table uses height:100% internally; give it a concrete height
		   so the virtual scroller has room. Compute per-table in _tableHeight(). */
		.diff-section kw-data-table { display: block; }
		.diff-column-diff-section {
			background: var(--vscode-editorWidget-background);
			border: 1px solid var(--vscode-panel-border);
			border-radius: 4px; padding: 12px;
		}
		.diff-section-header {
			font-weight: 600; font-size: 13px; margin-bottom: 8px; color: var(--vscode-foreground);
		}
		.diff-column-list { margin: 6px 0; font-size: 12px; line-height: 1.6; }
		.diff-column-list-label { color: var(--vscode-descriptionForeground); margin-right: 6px; }
		.diff-column-only-a .diff-column-list-label { color: var(--vscode-charts-red, #f48771); }
		.diff-column-only-b .diff-column-list-label { color: var(--vscode-charts-yellow, #cca700); }
		.diff-column-name {
			background: var(--vscode-textCodeBlock-background);
			padding: 2px 6px; border-radius: 3px;
			font-family: var(--vscode-editor-font-family); font-size: 11px;
		}
		.join-controls {
			display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-bottom: 8px;
		}
		.join-label {
			display: inline-flex; gap: 6px; align-items: center;
			font-size: 12px; color: var(--vscode-foreground); user-select: none;
		}
		.join-select {
			background-color: var(--vscode-dropdown-background);
			color: var(--vscode-dropdown-foreground);
			border: 1px solid var(--vscode-dropdown-border);
			border-radius: 0; padding: 4px 6px; font-size: 12px;
		}
		.join-select:hover {
			border-color: var(--vscode-focusBorder);
		}
		.table-label {
			font-weight: 600; font-size: 12px; color: var(--vscode-foreground);
			margin-bottom: 4px;
		}
`;
