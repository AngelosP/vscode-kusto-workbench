import { css } from 'lit';

export const styles = css`
		/* Ensure borders/padding don't cause height overflow + clipping in fixed-height panes. */
		*, *::before, *::after { box-sizing: border-box; }

		:host {
			display: block;
			font-family: var(--vscode-font-family);
			font-size: var(--vscode-font-size);
			color: var(--vscode-editor-foreground);
			background: var(--vscode-editor-background);
			padding: 16px;
		}

		h1 { font-size: 16px; margin: 0 0 4px 0; }
		.small { opacity: 0.8; font-size: 12px; }
		section { margin: 16px 0; padding: 12px; border: 1px solid var(--vscode-editorWidget-border); border-radius: 4px; background: var(--vscode-editorWidget-background); max-height: 500px; overflow: auto; }
		section > header { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
		.sectionBody { min-height: 0; }
		section.dbSection { overflow: hidden; display: flex; flex-direction: column; height: 500px; }
		section.dbSection > header { flex: 0 0 auto; }
		section.dbSection .sectionBody { flex: 1 1 auto; min-height: 0; overflow: hidden; }
		button { font-family: inherit; }
		.iconButton { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 0; border-radius: 4px; border: 1px solid var(--vscode-button-border, transparent); background: transparent; color: var(--vscode-foreground); cursor: pointer; }
		.iconButton:hover { background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground)); }
		.iconButton:active { background: var(--vscode-toolbar-activeBackground, var(--vscode-list-activeSelectionBackground)); }
		.iconButton .codicon { font-size: 16px; }
		.iconButton.spinning .codicon { animation: spin 0.8s linear infinite; }
		.iconButton.spinning { opacity: 0.6; cursor: wait; }
		@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
		.linkButton { background: transparent; border: 0; padding: 0; margin: 0; color: var(--vscode-textLink-foreground); cursor: pointer; }
		.linkButton:hover { text-decoration: underline; }
		table { width: 100%; border-collapse: collapse; }
		th, td { border-bottom: 1px solid var(--vscode-editorWidget-border); padding: 6px 8px; vertical-align: top; }
		th { text-align: left; font-weight: 600; }
		.tokenCol { white-space: nowrap; min-width: 92px; }
		code, pre, textarea, input { font-family: var(--vscode-editor-font-family); }
		textarea { width: 100%; min-height: 56px; }
		.rowActions { display: flex; gap: 6px; flex-wrap: wrap; }
		details pre { white-space: pre-wrap; word-break: break-all; }
		input[type="text"] { width: 100%; }
		select { width: 100%; }

		/* Auth card layout */
		.authCards { display: flex; flex-direction: column; gap: 4px; }
		.authCard { border-radius: 6px; border: 1px solid color-mix(in srgb, var(--vscode-editorWidget-border) 50%, transparent); transition: border-color 0.15s ease; overflow: hidden; }
		.authCard:hover { border-color: var(--vscode-editorWidget-border); }
		.authCardRow { display: flex; align-items: center; gap: 10px; padding: 8px 12px; }
		.authCardInfo { flex: 1; min-width: 0; display: flex; align-items: baseline; gap: 8px; }
		.authCardLabel { font-weight: 500; white-space: nowrap; }
		.authCardId { font-family: var(--vscode-editor-font-family); font-size: 11px; opacity: 0.4; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
		.authCardActions { flex-shrink: 0; display: flex; gap: 2px; align-items: center; }
		.overrideDot { width: 6px; height: 6px; border-radius: 50%; background: var(--vscode-charts-yellow, #e5c07b); flex-shrink: 0; margin-right: 2px; }
		.authOverrideRow { display: flex; align-items: center; gap: 8px; padding: 0 12px 8px 12px; animation: slideDown 0.15s ease; }
		.authOverrideRow input[type="text"] { flex: 1; min-width: 0; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 3px; padding: 3px 8px; font-size: 12px; font-family: var(--vscode-editor-font-family); }
		.authOverrideRow input[type="text"]:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
		.overrideLabel { font-size: 11px; opacity: 0.5; white-space: nowrap; }
		@keyframes slideDown { from { opacity: 0; max-height: 0; padding-bottom: 0; } to { opacity: 1; max-height: 40px; padding-bottom: 8px; } }

		.select-wrapper {
			position: relative;
			min-width: 40px;
			display: flex;
			align-items: center;
		}
		.select-wrapper select {
			background: var(--vscode-dropdown-background);
			color: var(--vscode-dropdown-foreground);
			border: 1px solid var(--vscode-dropdown-border);
			padding: 4px 24px 4px 8px;
			font-size: 12px;
			border-radius: 2px;
			width: 100%;
			cursor: pointer;
		}
		.select-wrapper select:hover { border-color: var(--vscode-focusBorder); }
		.select-wrapper select:disabled { opacity: 0.5; cursor: not-allowed; }

		.mono { font-family: var(--vscode-editor-font-family); }
		.twoPane { display: flex; height: 100%; min-height: 0; align-items: stretch; }
		.pane { border: 1px solid var(--vscode-editorWidget-border); border-radius: 4px; overflow: hidden; min-height: 0; }
		.pane.listPane { flex: 0 0 auto; width: 260px; min-width: 120px; max-width: 50%; }
		.pane.detailPane { flex: 1 1 auto; min-width: 0; }
		.list { height: 100%; overflow-y: auto; overflow-x: hidden; }
		.scrollPane:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
		.dbDetailHeader { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 10px; padding-bottom: 8px; border-bottom: 1px solid color-mix(in srgb, var(--vscode-editorWidget-border) 60%, transparent); }
		.detailUrl { font-family: var(--vscode-editor-font-family); font-size: 12px; opacity: 0.7; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }

		.dbList { display: flex; flex-direction: column; gap: 1px; }
		.dbItem { display: flex; align-items: center; gap: 10px; padding: 6px 10px; border-radius: 6px; transition: background 0.15s ease; cursor: default; }
		.dbItem:hover { background: var(--vscode-list-hoverBackground); }
		.dbIcon { flex-shrink: 0; opacity: 0.4; font-size: 16px; transition: opacity 0.15s ease; }
		.dbItem:hover .dbIcon { opacity: 0.7; }
		.dbName { font-family: var(--vscode-editor-font-family); opacity: 0.5; }
		.dbActions { flex-shrink: 0; display: flex; gap: 2px; margin-left: auto; opacity: 0; transition: opacity 0.15s ease; }
		.dbItem:hover .dbActions { opacity: 1; }

		.scrollPane { }
		.listItem { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 10px 8px 12px; border-bottom: 1px solid color-mix(in srgb, var(--vscode-editorWidget-border) 40%, transparent); border-left: 3px solid transparent; cursor: pointer; transition: background 0.15s ease, border-color 0.15s ease; }
		.listItem:last-child { border-bottom: none; }
		.listItem:hover { background: var(--vscode-list-hoverBackground); }
		.listItem.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); border-left-color: var(--vscode-focusBorder); }
		.listItemName { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.listItem .count { flex-shrink: 0; font-size: 11px; min-width: 20px; text-align: center; padding: 1px 6px; border-radius: 10px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); line-height: 16px; }

		.refresh-btn {
			background: transparent;
			border: 1px solid var(--vscode-input-border);
			color: var(--vscode-foreground);
			cursor: pointer;
			padding: 0;
			font-size: 12px;
			border-radius: 4px;
			display: flex;
			align-items: center;
			justify-content: center;
			line-height: 0;
			min-width: 28px;
			width: 28px;
			height: 28px;
		}
		.refresh-btn .codicon { font-size: 16px; }
		.refresh-btn.close-btn { border: none; }
		.refresh-btn:hover { background: var(--vscode-list-hoverBackground); }
		.refresh-btn:active { opacity: 0.7; }

		.tool-toggle-btn {
			background: var(--vscode-button-secondaryBackground);
			color: var(--vscode-button-secondaryForeground);
			border: 1px solid var(--vscode-button-border);
			border-radius: 2px;
			padding: 4px 8px;
			cursor: pointer;
			display: flex;
			align-items: center;
			justify-content: center;
			font-size: 14px;
		}
		.tool-toggle-btn:hover { background: var(--vscode-button-secondaryHoverBackground); }

		kw-kind-picker { margin-top: 16px; }
`;