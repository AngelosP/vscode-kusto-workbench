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
		.modal-body { flex: 1; overflow: auto; padding: 16px; }

		/* Search */
		.search-area { display: flex; gap: 8px; align-items: center; flex: 1; margin: 0 16px; }
		.search-results { font-size: 11px; color: var(--vscode-descriptionForeground); white-space: nowrap; }
		.search-control {
			position: relative; display: inline-flex; align-items: center;
			flex: 1 1 auto; min-width: 0; width: 100%; max-width: 350px;
		}
		.search-icon {
			position: absolute; left: 6px; top: 50%; transform: translateY(-50%);
			pointer-events: none; color: var(--vscode-input-placeholderForeground); opacity: 0.7;
			display: inline-flex; align-items: center; z-index: 1;
		}
		.search-input {
			flex: 1 1 auto; min-width: 0;
			padding: 4px 8px 4px 26px; padding-right: 98px;
			background: var(--vscode-input-background);
			color: var(--vscode-input-foreground);
			border: 1px solid var(--vscode-input-border);
			border-radius: 2px; font-family: inherit;
		}
		.search-input::placeholder { color: var(--vscode-input-placeholderForeground); opacity: 1; }
		.mode-toggle {
			position: absolute; right: 49px; top: 50%; transform: translateY(-50%);
			width: 20px; height: 18px; padding: 0; border: none;
			background: transparent; color: var(--vscode-input-foreground); opacity: 0.7;
			cursor: pointer; display: inline-flex; align-items: center; justify-content: center; border-radius: 2px;
		}
		.mode-toggle:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
		.nav-divider {
			position: absolute; right: 48px; top: 50%; transform: translateY(-50%);
			width: 1px; height: 14px; background: var(--vscode-input-foreground); opacity: 0.25; pointer-events: none;
		}
		.nav-btn {
			position: absolute; top: 50%; transform: translateY(-50%);
			width: 20px; height: 18px; padding: 0; border: none;
			background: transparent; color: var(--vscode-input-foreground); opacity: 0.7;
			cursor: pointer; display: inline-flex; align-items: center; justify-content: center; border-radius: 2px;
		}
		.nav-btn:hover:not(:disabled) { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
		.nav-btn:disabled { opacity: 0.35; cursor: default; }
		.nav-btn svg { display: block; }
		.nav-prev { right: 26px; }
		.nav-next { right: 4px; }

		/* Buttons */
		.close-btn {
			background: transparent; border: none; color: var(--vscode-foreground); cursor: pointer;
			display: flex; align-items: center; justify-content: center;
			width: 28px; height: 28px; border-radius: 4px; padding: 0;
		}
		.close-btn:hover { background: var(--vscode-list-hoverBackground); }

		.back-btn {
			padding: 4px 8px; min-width: 28px; height: 28px;
			background: var(--vscode-button-background); color: var(--vscode-button-foreground);
			border: 1px solid var(--vscode-button-border, transparent); border-radius: 2px; cursor: pointer;
		}
		.back-btn:hover { background: var(--vscode-button-hoverBackground); }

		.view-btn {
			margin: 0; padding: 2px 6px; font-size: 11px;
			background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);
			border: 1px solid var(--vscode-button-border, transparent); border-radius: 3px; cursor: pointer;
			display: inline-flex; align-items: center; vertical-align: baseline;
		}
		.view-btn:hover { background: var(--vscode-button-secondaryHoverBackground); }

		.tool-btn {
			background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);
			border: 1px solid var(--vscode-button-border, transparent); border-radius: 2px;
			padding: 4px 8px; cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 14px;
		}
		.tool-btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
		.tool-btn.is-active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }

		.copy-btn {
			background: transparent; border: none; color: var(--vscode-foreground); cursor: pointer;
			min-width: 22px; width: 22px; height: 22px; padding: 0; display: inline-flex; align-items: center; justify-content: center; border-radius: 4px;
		}
		.copy-btn:hover { background: var(--vscode-list-hoverBackground); }

		/* Sections */
		.section {
			border: 1px solid var(--vscode-panel-border); border-radius: 4px;
			background: var(--vscode-editor-background); margin-bottom: 12px;
		}
		.section-header {
			display: flex; align-items: center; justify-content: space-between; gap: 8px;
			padding: 10px 12px; border-bottom: 1px solid var(--vscode-panel-border);
			background: var(--vscode-editorGroupHeader-tabsBackground);
		}
		.props-section .section-header { justify-content: flex-start; }
		.props-section .section-title { flex: 1; }
		.section-title { font-size: 12px; font-weight: 600; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.props-section .section-title { white-space: normal; overflow: visible; text-overflow: clip; }

		/* Breadcrumbs */
		.crumb {
			background: transparent; border: none; padding: 0; margin: 0;
			font: inherit; color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: none;
		}
		.crumb:hover { text-decoration: underline; }
		.crumb:disabled { color: var(--vscode-foreground); cursor: default; text-decoration: none; opacity: 0.9; }
		.crumb-sep { color: var(--vscode-descriptionForeground); padding: 0 6px; user-select: none; }

		/* Properties table */
		.props-table { width: 100%; border-collapse: collapse; font-size: 12px; font-family: var(--vscode-font-family); user-select: text; }
		.props-table td { padding: 6px 10px; border-top: 1px solid var(--vscode-panel-border); vertical-align: top; word-break: break-word; user-select: text; }
		.props-table td:first-child { width: 35%; max-width: 360px; font-family: var(--vscode-editor-font-family); color: var(--vscode-descriptionForeground); }
		.props-table td:last-child { font-family: var(--vscode-editor-font-family); vertical-align: middle; }
		.prop-key-cell { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; }
		.prop-key-text { flex: 1; min-width: 0; word-break: break-word; }
		.prop-copy-btn { opacity: 0; pointer-events: none; }
		.props-table tr:hover .prop-copy-btn { opacity: 1; pointer-events: auto; }
		.props-table tr.search-match td { background: var(--vscode-editor-findMatchHighlightBackground); outline: 1px solid var(--vscode-editor-findMatchHighlightBorder); outline-offset: -1px; }

		/* Raw JSON */
		.raw-actions { display: inline-flex; gap: 4px; align-items: center; }
		.raw-body { padding: 10px 12px; }
		.json-wrap { font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); white-space: pre-wrap; word-break: break-word; overflow-x: hidden; line-height: 1.6; }
		.json-key { color: var(--vscode-symbolIcon-propertyForeground); }
		.json-string { color: var(--vscode-symbolIcon-stringForeground); }
		.json-number { color: var(--vscode-symbolIcon-numberForeground); }
		.json-boolean { color: var(--vscode-symbolIcon-booleanForeground); }
		.json-null { color: var(--vscode-symbolIcon-nullForeground); }
		.json-highlight { background: var(--vscode-editor-findMatchHighlightBackground); border-radius: 2px; }
		.json-highlight-active { background: var(--vscode-editor-findMatchBackground); outline: 1px solid var(--vscode-editor-findMatchBorder); }
`;