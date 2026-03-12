import { css } from 'lit';

export const styles = css`
		:host {
			display: block;
			font-family: var(--vscode-font-family);
			font-size: var(--vscode-font-size);
			font-weight: var(--vscode-font-weight);
		}
		:host(.is-collapsed) .connection-row {
			display: none;
		}
		:host(.is-collapsed) .header-max-btn,
		:host(.is-collapsed) .header-share-btn {
			display: none;
		}
		*, *::before, *::after { box-sizing: border-box; }

		/* ── Header group (name row + connection row) ──────────────── */
		.header-group {
			display: flex;
			flex-direction: column;
			gap: 8px;
			margin-bottom: 8px;
		}

		/* ── Header row (name + action buttons) ────────────────────── */
		.header-row {
			display: flex;
			gap: 8px;
			align-items: center;
			flex-wrap: nowrap;
		}
		.query-name-group {
			display: flex;
			gap: 0;
			align-items: center;
			flex: 1 1 150px;
			min-width: 0;
		}
		.section-drag-handle {
			opacity: 1;
			background: transparent;
			border: 1px solid transparent;
			color: var(--vscode-descriptionForeground);
			border-radius: 4px;
			margin: 0;
			width: 12px;
			height: 24px;
			padding: 0;
			display: inline-flex;
			align-items: center;
			justify-content: center;
			cursor: grab;
			flex: 0 0 auto;
		}
		.section-drag-handle:hover {
			background: var(--vscode-list-hoverBackground);
			border-color: var(--vscode-input-border);
			color: var(--vscode-foreground);
		}
		.section-drag-handle:active { cursor: grabbing; }
		.section-drag-handle-glyph {
			font-size: 14px;
			line-height: 1;
			letter-spacing: -1px;
		}
		.query-name {
			background: transparent;
			border: 1px solid transparent;
			color: var(--vscode-foreground);
			padding: 4px 8px;
			font-size: 12px;
			flex: 1 1 150px;
			min-width: 0;
			font-family: inherit;
		}
		.query-name:hover { border-color: var(--vscode-input-border); }
		.query-name:focus { outline: none; border-color: var(--vscode-focusBorder); }
		.section-actions {
			display: inline-flex;
			gap: 8px;
			align-items: center;
		}
		.header-tabs {
			display: inline-flex;
			gap: 2px;
			align-items: center;
		}
		.header-tab {
			background: transparent;
			border: 1px solid transparent;
			color: var(--vscode-foreground);
			cursor: pointer;
			padding: 0;
			width: 28px;
			height: 28px;
			border-radius: 4px;
			display: inline-flex;
			align-items: center;
			justify-content: center;
			line-height: 0;
		}
		.header-tab svg { display: block; }
		.header-tab:hover { background: var(--vscode-list-hoverBackground); }
		.header-tab.is-active {
			background: var(--vscode-toolbar-activeBackground, rgba(128, 128, 128, 0.25));
			color: var(--vscode-foreground);
		}
		.header-share-btn { margin-right: 6px; }
		.header-max-btn { margin-right: 6px; }
		.close-btn {
			background: transparent;
			border: none;
			color: var(--vscode-foreground);
			cursor: pointer;
			padding: 0;
			border-radius: 4px;
			display: flex;
			align-items: center;
			justify-content: center;
			line-height: 0;
			min-width: 28px;
			width: 28px;
			height: 28px;
		}
		.close-btn:hover { background: var(--vscode-list-hoverBackground); }
		.close-btn svg { display: block; }

		/* ── Connection row ─────────────────────────────────────────── */
		.connection-row {
			display: flex;
			gap: 8px;
			align-items: center;
			flex-wrap: nowrap;
			min-width: 0;
			container-type: inline-size;
		}

		/* ── Dropdown wrapper ───────────────────────────────────────── */
		.select-wrapper {
			position: relative;
			flex: 1 1 200px;
			min-width: 40px;
			display: flex;
			align-items: center;
		}
		.select-wrapper.has-icon .select-icon {
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
		.select-wrapper.half-width {
			flex: 1 1 210px;
			width: auto;
			max-width: 210px;
			min-width: 150px;
		}
		.select-wrapper.kusto-favorites-combo {
			flex: 1 1 448px;
			width: auto;
			max-width: 448px;
			min-width: 40px;
		}
		/* Hide icon in favorites dropdown in normal mode */
		.select-wrapper.kusto-favorites-combo .kusto-dropdown-btn .select-icon {
			display: none;
		}
		.select-wrapper.kusto-favorites-combo .kusto-dropdown-btn {
			padding-left: 8px;
		}

		/* ── Dropdown button ────────────────────────────────────────── */
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
		.select-wrapper.has-icon .kusto-dropdown-btn {
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

		/* ── Dropdown menu ──────────────────────────────────────────── */
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
		.kusto-dropdown-item.is-active {
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
		.kusto-dropdown-empty {
			padding: 8px;
			font-size: 12px;
			color: var(--vscode-descriptionForeground);
		}

		/* Favorites item styling */
		.kusto-favorites-primary {
			color: var(--vscode-dropdown-foreground);
			font-weight: 600;
		}
		.kusto-favorites-secondary {
			color: var(--vscode-descriptionForeground);
		}
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
		.kusto-dropdown-item.is-active .kusto-dropdown-trash {
			visibility: visible;
			pointer-events: auto;
		}
		.kusto-dropdown-trash:hover {
			background: var(--vscode-list-hoverBackground);
			border-color: var(--vscode-input-border);
			color: var(--vscode-foreground);
		}

		/* ── Icon buttons ───────────────────────────────────────────── */
		.icon-btn {
			display: inline-flex;
			align-items: center;
			justify-content: center;
			background: transparent;
			border: 1px solid var(--vscode-input-border);
			border-radius: 4px;
			color: var(--vscode-foreground);
			cursor: pointer;
			padding: 0;
			width: 29px;
			height: 29px;
			min-width: 29px;
			flex: 0 0 auto;
			line-height: 0;
		}
		.icon-btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
		.icon-btn:focus { outline: none; }
		.icon-btn:focus-visible { border-color: var(--vscode-focusBorder); }
		.icon-btn:disabled { opacity: 0.5; cursor: not-allowed; }
		.icon-btn svg { display: block; }

		.icon-btn.favorite-btn {
			color: var(--vscode-descriptionForeground);
		}
		.icon-btn.favorite-btn svg {
			fill: none;
		}

		.icon-btn.favorite-active {
			color: var(--vscode-charts-yellow, #e5c07b);
		}
		.icon-btn.favorite-active svg {
			fill: currentColor;
		}

		/* ── Schema info ────────────────────────────────────────────── */
		.schema-info-wrapper {
			position: relative;
			flex: 0 0 auto;
			margin-left: auto;
		}
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

		/* ── Spinner ────────────────────────────────────────────────── */
		.query-spinner {
			display: inline-block;
			width: 14px;
			height: 14px;
			border-radius: 50%;
			border: 2px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.4));
			border-top-color: var(--vscode-progressBar-background, #0e70c0);
			animation: schema-spin 0.9s linear infinite;
		}

		/* ── Container queries (responsive) ─────────────────────────── */
		@container (max-width: 420px) {
			.select-wrapper.half-width {
				flex: 0 0 32px;
				width: 32px;
				min-width: 32px;
				max-width: 32px;
			}
			.select-wrapper.half-width .kusto-dropdown-btn-text { display: none; }
			.select-wrapper.half-width .kusto-dropdown-btn-caret { display: none; }
			.select-wrapper.half-width .kusto-dropdown-btn { padding: 4px; justify-content: center; }
			.select-wrapper.half-width.has-icon .kusto-dropdown-btn { padding: 4px; }
			.select-wrapper.half-width.has-icon .select-icon {
				left: 50%;
				transform: translate(-50%, -50%);
			}
			.select-wrapper.kusto-favorites-combo {
				flex: 0 0 32px;
				width: 32px;
				min-width: 32px;
				max-width: 32px;
			}
			.select-wrapper.kusto-favorites-combo .kusto-dropdown-btn .select-icon { display: inline-flex; }
			.select-wrapper.kusto-favorites-combo .kusto-dropdown-btn-text { display: none; }
			.select-wrapper.kusto-favorites-combo .kusto-dropdown-btn-caret { display: none; }
			.select-wrapper.kusto-favorites-combo .kusto-dropdown-btn { padding: 4px; justify-content: center; }
		}
		@container (max-width: 200px) {
			.refresh-btn-wrap { display: none !important; }
			.favorite-btn-wrap { display: none !important; }
			.schema-info-wrapper { display: none !important; }
		}
`;