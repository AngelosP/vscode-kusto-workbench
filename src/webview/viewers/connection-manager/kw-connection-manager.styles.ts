import { css } from 'lit';

export const styles = css`
		*, *::before, *::after { box-sizing: border-box; }

		:host {
			display: flex;
			flex-direction: column;
			font-family: var(--vscode-font-family);
			font-size: var(--vscode-font-size);
			color: var(--vscode-editor-foreground);
			background: var(--vscode-editor-background);
			padding: 16px;
			margin: 0;
			height: 100vh;
			box-sizing: border-box;
			overflow: hidden;
		}

		h1 { font-size: 16px; margin: 0; font-weight: 600; white-space: nowrap; }
		h2 { font-size: 14px; margin: 0; font-weight: 600; }
		.mono { font-family: var(--vscode-editor-font-family); }

		/* Spinner animation */
		@keyframes spin { to { transform: rotate(360deg); } }
		.spin, :host svg.spin { animation: spin 1s linear infinite; }

		/* Buttons */
		.btn { display: inline-flex; align-items: center; gap: 6px; padding: 6px 14px; font-size: 12px; border-radius: 2px; border: 1px solid var(--vscode-button-border, transparent); background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); cursor: pointer; font-family: inherit; }
		.btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
		.btn.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
		.btn.primary:hover { background: var(--vscode-button-hoverBackground); }
		.btn svg { width: 14px; height: 14px; fill: currentColor; }

		.btn-icon { width: 28px; height: 28px; padding: 0; border: none; background: transparent; color: var(--vscode-foreground); cursor: pointer; display: inline-flex; align-items: center; justify-content: center; border-radius: 4px; }
		.btn-icon:hover { background: var(--vscode-toolbar-hoverBackground); }
		.btn-icon:active { background: var(--vscode-toolbar-activeBackground); }
		.btn-icon svg { width: 16px; height: 16px; fill: currentColor; }
		.btn-icon.is-favorite { color: #f5c518; }
		.btn-icon.is-favorite svg { fill: #f5c518; }
		.btn-icon.is-lnt { color: var(--vscode-charts-orange, #d18616); }
		.btn-icon.is-lnt svg { fill: var(--vscode-charts-orange, #d18616); }
		.btn-icon.lnt-active { color: var(--vscode-symbolIcon-eventForeground, #d19a66); }

		.title-actions { display: flex; gap: 6px; flex-shrink: 0; }
		.page-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; flex-wrap: wrap; }
		.header-btn { display: inline-flex; align-items: center; gap: 5px; padding: 4px 10px; font-size: 12px; border-radius: 3px; border: 1px solid var(--vscode-button-border, transparent); background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); cursor: pointer; font-family: inherit; white-space: nowrap; height: 28px; box-sizing: border-box; }
		.header-btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
		.header-btn.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
		.header-btn.primary:hover { background: var(--vscode-button-hoverBackground); }
		.header-btn svg { width: 14px; height: 14px; fill: currentColor; flex-shrink: 0; }
		.add-btn { width: 28px; height: 28px; }
		.add-btn svg { width: 18px; height: 18px; }

		/* Main layout — single panel */
		.explorer-panel { flex: 1; min-height: 0; display: flex; flex-direction: column; border: 1px solid var(--vscode-editorWidget-border); border-radius: 4px; background: var(--vscode-editorWidget-background); overflow: hidden; }

		/* Filter tabs */
		.filter-bar { display: flex; gap: 0; border-bottom: 1px solid var(--vscode-editorWidget-border); flex-shrink: 0; container-type: inline-size; }
		.filter-tab { display: inline-flex; align-items: center; gap: 6px; padding: 10px 16px; font-size: 13px; border: none; border-bottom: 2px solid transparent; background: transparent; color: var(--vscode-descriptionForeground); cursor: pointer; font-family: inherit; white-space: nowrap; transition: all 0.15s; }
		.filter-tab:hover { color: var(--vscode-foreground); background: var(--vscode-list-hoverBackground); }
		.filter-tab.active { color: var(--vscode-foreground); border-bottom-color: var(--vscode-focusBorder); font-weight: 500; }
		.filter-tab svg { width: 14px; height: 14px; fill: currentColor; flex-shrink: 0; }
		.fav-tab svg { fill: #f5c518; }
		.lnt-tab svg { fill: var(--vscode-charts-orange, #d18616); }
		.filter-label { }
		.filter-count { font-size: 11px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); padding: 1px 6px; border-radius: 10px; min-width: 16px; text-align: center; }
		@container (max-width: 400px) { .filter-label { display: none; } .filter-tab { padding: 10px 10px; gap: 4px; } }

		/* Explorer content */
		.explorer-content { flex: 1; overflow-y: auto; min-height: 0; }

		/* Badges on cluster items */
		.conn-badge { width: 16px; height: 16px; flex-shrink: 0; display: inline-flex; align-items: center; }
		.conn-badge svg { width: 14px; height: 14px; fill: currentColor; }
		.lnt-badge { color: var(--vscode-charts-orange, #d18616); }
		.fav-badge { color: #f5c518; }
		.loading-inline,.empty-inline { padding: 8px 12px 8px 44px; font-size: 11px; color: var(--vscode-descriptionForeground); }
		.link-btn { background: none; border: none; color: var(--vscode-textLink-foreground); cursor: pointer; font-size: inherit; font-family: inherit; padding: 0; text-decoration: underline; }
		.splitter-collapse-btn { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 18px; height: 32px; background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-editorWidget-border); border-radius: 4px; cursor: pointer; display: flex; align-items: center; justify-content: center; color: var(--vscode-foreground); opacity: 0; transition: opacity 0.15s; z-index: 1; padding: 0; }
		.splitter:hover .splitter-collapse-btn { opacity: 1; }
		.splitter-collapse-btn svg { width: 12px; height: 12px; }
		.right-panel { flex: 1; min-width: 0; display: flex; flex-direction: column; height: 100%; border: 1px solid var(--vscode-editorWidget-border); border-radius: 4px; background: var(--vscode-editorWidget-background); overflow: hidden; }
		.panel-toggle { position: fixed; top: 80px; left: 16px; z-index: 100; width: 28px; height: 28px; background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-editorWidget-border); border-radius: 4px; cursor: pointer; display: flex; align-items: center; justify-content: center; color: var(--vscode-foreground); padding: 0; }
		.panel-toggle svg { width: 16px; height: 16px; }

		/* Explorer breadcrumb */
		.explorer-breadcrumb { display: flex; align-items: center; gap: 4px; padding: 8px 12px; font-size: 13px; border-bottom: 1px solid var(--vscode-editorWidget-border); background: var(--vscode-sideBar-background); flex-wrap: wrap; flex-shrink: 0; min-height: 38px; box-sizing: border-box; }
		.breadcrumb-item { display: flex; align-items: center; gap: 4px; color: var(--vscode-textLink-foreground); cursor: pointer; padding: 2px 4px; border-radius: 3px; transition: background 0.1s; }
		.breadcrumb-item:hover { background: var(--vscode-list-hoverBackground); text-decoration: underline; }
		.breadcrumb-item.current { color: var(--vscode-foreground); cursor: default; font-weight: 500; }
		.breadcrumb-item.current:hover { background: transparent; text-decoration: none; }
		.breadcrumb-separator { color: var(--vscode-descriptionForeground); opacity: 0.6; }
		.breadcrumb-icon { width: 14px; height: 14px; flex-shrink: 0; display: flex; align-items: center; }
		.breadcrumb-icon svg { width: 14px; height: 14px; fill: currentColor; }

		/* Explorer list */
		.explorer-list { flex: 1; overflow-y: auto; }
		.explorer-list-item { display: flex; align-items: center; gap: 8px; padding: 10px 12px; cursor: pointer; transition: background 0.1s; border-bottom: 1px solid var(--vscode-editorWidget-border); background: var(--vscode-editorWidget-background); }
		.explorer-list-item:last-child { border-bottom: none; }
		.explorer-list-item:hover { background: var(--vscode-list-hoverBackground); }
		.explorer-list-item-icon { width: 16px; height: 16px; flex-shrink: 0; display: flex; align-items: center; }
		.explorer-list-item-icon svg { width: 16px; height: 16px; fill: currentColor; }
		.explorer-list-item-icon.database { color: var(--vscode-symbolIcon-fieldForeground, #75beff); }
		.explorer-list-item-icon.database svg { fill: var(--vscode-symbolIcon-fieldForeground, #75beff); }
		.explorer-list-item-icon.table { color: var(--vscode-symbolIcon-structForeground, #00bcb4); }
		.explorer-list-item-icon.table svg { fill: var(--vscode-symbolIcon-structForeground, #00bcb4); }
		.explorer-list-item-icon.function { color: var(--vscode-symbolIcon-methodForeground, #b180d7); }
		.explorer-list-item-icon.function svg { fill: var(--vscode-symbolIcon-methodForeground, #b180d7); }
		.explorer-list-item-icon.folder { color: var(--vscode-symbolIcon-folderForeground, #dcb67a); }
		.explorer-list-item-icon.folder svg { fill: var(--vscode-symbolIcon-folderForeground, #dcb67a); }
		.explorer-list-item-name { flex-shrink: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; font-weight: 500; }
		.explorer-list-item-url { font-size: 11px; color: var(--vscode-descriptionForeground); opacity: 0.7; flex-shrink: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--vscode-editor-font-family, monospace); }
		.explorer-list-item-meta { font-size: 11px; color: var(--vscode-descriptionForeground); flex-shrink: 0; white-space: nowrap; }
		.item-sep { color: var(--vscode-descriptionForeground); opacity: 0.4; flex-shrink: 0; font-size: 12px; }
		.explorer-list-item-params { font-size: 11px; color: var(--vscode-descriptionForeground); white-space: nowrap; opacity: 0; transition: opacity 0.15s; flex-shrink: 1; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
		.explorer-list-item:hover .explorer-list-item-params { opacity: 1; }
		.explorer-list-item:hover .explorer-list-item-name { flex-shrink: 0; max-width: 60%; }
		.explorer-list-item-actions { display: flex; gap: 2px; flex-shrink: 0; }
		.explorer-list-item-actions .btn-icon { opacity: 0; transition: opacity 0.1s; }
		.explorer-list-item:hover .explorer-list-item-actions .btn-icon { opacity: 1; }
		.explorer-list-item-actions .btn-icon.is-favorite { opacity: 1; }
		.explorer-list-item-actions .btn-icon.is-lnt { opacity: 1; }
		.explorer-list-item-chevron { width: 16px; height: 16px; flex-shrink: 0; transition: transform 0.15s ease; opacity: 0.7; display: flex; align-items: center; }
		.explorer-list-item-chevron svg { width: 14px; height: 14px; fill: currentColor; }
		.explorer-list-item-chevron.expanded { transform: rotate(90deg); }
		.explorer-list-item-wrapper { border-bottom: 1px solid var(--vscode-editorWidget-border); }
		.explorer-list-item-wrapper > .explorer-list-item { border-bottom: none; }
		.explorer-list-item-wrapper.expanded > .explorer-list-item { background: var(--vscode-list-hoverBackground); }
		.explorer-item-details { padding: 8px 12px 12px 44px; background: var(--vscode-editorWidget-background); border-top: 1px solid var(--vscode-editorWidget-border); }
		.explorer-detail-section { margin-bottom: 12px; }
		.explorer-detail-section:last-child { margin-bottom: 0; }
		.explorer-detail-label { font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: var(--vscode-descriptionForeground); margin-bottom: 4px; }
		.explorer-detail-docstring { font-size: 12px; color: var(--vscode-editor-foreground); line-height: 1.4; white-space: pre-wrap; word-wrap: break-word; }
		.explorer-detail-code { font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; color: var(--vscode-symbolIcon-methodForeground, #b180d7); padding: 4px 8px; background: rgba(0, 0, 0, 0.1); border-radius: 4px; }
		.explorer-detail-body { font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; line-height: 1.4; color: var(--vscode-editor-foreground); background: rgba(0, 0, 0, 0.15); border-radius: 4px; padding: 8px 10px; margin: 0; white-space: pre-wrap; word-wrap: break-word; overflow: hidden; }
		.explorer-detail-schema { display: flex; flex-direction: column; gap: 2px; }
		.explorer-schema-row { display: flex; align-items: center; gap: 8px; padding: 3px 8px; font-size: 11px; background: rgba(0, 0, 0, 0.08); border-radius: 3px; }
		.explorer-schema-row:hover { background: rgba(0, 0, 0, 0.15); }
		.explorer-schema-col-name { font-family: var(--vscode-editor-font-family, monospace); color: var(--vscode-symbolIcon-propertyForeground, #9cdcfe); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.explorer-schema-col-type { font-family: var(--vscode-editor-font-family, monospace); color: var(--vscode-symbolIcon-typeParameterForeground, #4ec9b0); font-size: 10px; flex-shrink: 0; }

		/* Preview */
		.preview-action { display: flex; align-items: center; gap: 6px; padding: 6px 10px; margin-top: 8px; border-radius: 4px; cursor: pointer; font-size: 11px; color: var(--vscode-textLink-foreground); background: transparent; border: 1px solid var(--vscode-editorWidget-border); font-family: inherit; transition: background 0.15s; }
		.preview-action:hover { background: var(--vscode-list-hoverBackground); }
		.preview-action.loading { opacity: 0.7; pointer-events: none; }
		.preview-action svg { width: 14px; height: 14px; fill: currentColor; }
		.preview-error { margin-top: 8px; padding: 6px 10px; font-size: 11px; color: var(--vscode-errorForeground); background: rgba(255, 0, 0, 0.08); border-radius: 4px; border: 1px solid var(--vscode-inputValidation-errorBorder, rgba(255, 0, 0, 0.3)); }
		.preview-result { margin-top: 8px; }
		.preview-result-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px; }
		.preview-result-info { font-size: 10px; color: var(--vscode-descriptionForeground); }
		.preview-result-dismiss { background: none; border: none; cursor: pointer; color: var(--vscode-descriptionForeground); opacity: 0.7; padding: 2px; }
		.preview-result-dismiss:hover { opacity: 1; }
		.preview-result-dismiss svg { width: 12px; height: 12px; fill: currentColor; }
		.preview-table-container { }
		.preview-table { width: 100%; border-collapse: collapse; font-size: 11px; font-family: var(--vscode-editor-font-family); }
		.preview-table th { padding: 4px 8px; text-align: left; font-weight: 600; border-bottom: 1px solid var(--vscode-editorWidget-border); background: var(--vscode-editorGroupHeader-tabsBackground); position: sticky; top: 0; z-index: 1; }
		.preview-table td { padding: 4px 8px; border-bottom: 1px solid var(--vscode-editorWidget-border); max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

		/* Empty + loading states */
		.empty-state { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 32px 16px; opacity: 0.7; text-align: center; }
		.empty-state-icon { margin-bottom: 8px; }
		.empty-state-icon svg { width: 32px; height: 32px; }
		.empty-state-title { font-weight: 600; margin-bottom: 4px; }
		.empty-state-text { font-size: 12px; }
		.loading-state { padding: 16px; text-align: center; opacity: 0.7; }
		.loading-state svg { width: 16px; height: 16px; vertical-align: middle; margin-right: 4px; }

		/* Modal */
		.modal-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0, 0, 0, 0.5); z-index: 10000; display: flex; align-items: center; justify-content: center; }
		.modal-content { background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); border-radius: 8px; width: 440px; max-width: 90%; box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3); }
		.modal-header { display: flex; align-items: center; justify-content: space-between; padding: 16px 20px; border-bottom: 1px solid var(--vscode-panel-border); }
		.modal-body { padding: 16px 20px; }
		.modal-footer { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 20px; border-top: 1px solid var(--vscode-panel-border); }
		.form-group { margin-bottom: 12px; }
		.form-group label { display: block; font-size: 12px; margin-bottom: 4px; }
		.form-group input { width: 100%; padding: 6px 8px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 2px; font-family: inherit; font-size: 13px; }
		.form-group input:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
		.form-group input::placeholder { color: var(--vscode-input-placeholderForeground); }
		.test-result { margin-top: 8px; font-size: 12px; }
`;