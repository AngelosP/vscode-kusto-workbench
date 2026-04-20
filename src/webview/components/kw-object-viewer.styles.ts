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
		.modal-body { flex: 1; overflow: auto; padding: 16px; overscroll-behavior: contain; }

		/* Search */
		.search-area { display: flex; gap: 8px; align-items: center; flex: 1; margin: 0 16px; }
		.search-results { font-size: 11px; color: var(--vscode-descriptionForeground); white-space: nowrap; }

		/* Buttons */
		.close-btn {
			background: transparent; border: none; color: var(--vscode-foreground); cursor: pointer;
			display: flex; align-items: center; justify-content: center;
			width: 28px; height: 28px; border-radius: 4px; padding: 0;
		}
		.close-btn:hover { background: var(--vscode-list-hoverBackground); }

		.view-link {
			color: var(--vscode-textLink-foreground); text-decoration: none; font-size: 11px; cursor: pointer;
		}
		.view-link:hover { text-decoration: underline; color: var(--vscode-textLink-activeForeground, var(--vscode-textLink-foreground)); }

		.tool-btn {
			display: inline-flex; align-items: center; justify-content: center;
			width: 28px; height: 28px; min-width: 28px; padding: 0;
			border: 1px solid transparent; border-radius: 4px;
			background: transparent; color: var(--vscode-foreground);
			cursor: pointer; font-size: 14px; line-height: 0;
		}
		.tool-btn:hover { background: var(--vscode-list-hoverBackground); }
		.tool-btn.is-active { background: var(--vscode-toolbar-activeBackground, var(--vscode-actionBar-toggledBackground, rgba(128, 128, 128, 0.25))); }
		.tool-btn svg { stroke: currentColor; fill: none; display: block; }

		.show-more-btn {
			background: transparent; border: none; cursor: pointer;
			color: var(--vscode-textLink-foreground); font-size: 12px;
			padding: 6px 0; text-align: left;
		}
		.show-more-btn:hover { text-decoration: underline; color: var(--vscode-textLink-activeForeground, var(--vscode-textLink-foreground)); }

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
		.prop-key-cell { display: flex; align-items: center; gap: 4px; min-width: 0; }
		.prop-key-text { flex: 1; min-width: 0; word-break: break-word; }
		.prop-copy-btn { opacity: 0; pointer-events: none; flex-shrink: 0; }
		.props-table tr:hover .prop-copy-btn { opacity: 1; pointer-events: auto; }
		.props-table td.search-match { background: var(--vscode-list-filterMatchHighlightBackground, rgba(234, 92, 0, 0.3)); }
		mark.hl{all:unset;color:var(--vscode-list-highlightForeground);font-weight:600;border-radius:1px}

		/* Raw JSON */
		.raw-actions { display: inline-flex; gap: 4px; align-items: center; }
		.raw-body { padding: 0; }
		.raw-wrap-scroll {
			max-height: 400px; overflow: auto; overscroll-behavior: contain;
			padding: 10px 12px;
		}
		.raw-vscroll {
			max-height: 400px; overflow: auto; overscroll-behavior: contain;
			padding: 10px 0;
		}
		.raw-vline {
			position: absolute; left: 0;
			height: 20px; line-height: 20px;
			white-space: pre;
			padding: 0 12px;
			font-family: var(--vscode-editor-font-family);
			font-size: var(--vscode-editor-font-size);
		}
		.json-wrap { font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); white-space: pre-wrap; word-break: break-word; overflow-x: hidden; line-height: 1.6; }
		.json-key { color: var(--vscode-symbolIcon-propertyForeground); }
		.json-string { color: var(--vscode-symbolIcon-stringForeground); }
		.json-number { color: var(--vscode-symbolIcon-numberForeground); }
		.json-boolean { color: var(--vscode-symbolIcon-booleanForeground); }
		.json-null { color: var(--vscode-symbolIcon-nullForeground); }
		.json-highlight { background: var(--vscode-list-filterMatchHighlightBackground, rgba(234, 92, 0, 0.3)); border-radius: 2px; color: var(--vscode-list-highlightForeground); font-weight: 600; }
		.json-highlight-active { background: var(--vscode-editor-findMatchBackground); outline: 2px solid var(--vscode-list-filterMatchHighlightBorder, var(--vscode-editor-findMatchBorder)); }
`;