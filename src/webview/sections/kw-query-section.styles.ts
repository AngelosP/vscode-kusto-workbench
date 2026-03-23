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
		:host(.is-collapsed) .header-share-btn {
			display: none;
		}
		:host(.is-collapsed) .header-group {
			margin-bottom: 0;
		}
		*, *::before, *::after { box-sizing: border-box; }

		/* ── Header group (shell + connection row) ──────────────── */
		.header-group {
			display: flex;
			flex-direction: column;
			gap: 0;
			margin-bottom: 8px;
		}

		/* ── Share button (slotted into shell header-buttons) ───── */
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
		.header-share-btn { margin-right: 6px; }

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

		/* ── Spinner ────────────────────────────────────────────────── */
		.query-spinner {
			display: inline-block;
			width: 14px;
			height: 14px;
			border-radius: 50%;
			border: 2px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.4));
			border-top-color: var(--vscode-progressBar-background, #0e70c0);
			animation: kw-spinner-spin 0.9s linear infinite;
		}

		@keyframes kw-spinner-spin {
			to { transform: rotate(360deg); }
		}

		/* ── Container queries (responsive) ─────────────────────────── */
		@container (max-width: 420px) {
			.select-wrapper.half-width {
				flex: 0 0 32px;
				width: 32px;
				min-width: 32px;
				max-width: 32px;
			}
			.select-wrapper.kusto-favorites-combo {
				flex: 0 0 32px;
				width: 32px;
				min-width: 32px;
				max-width: 32px;
			}
		}
		@container (max-width: 200px) {
			.refresh-btn-wrap { display: none !important; }
			.favorite-btn-wrap { display: none !important; }
			kw-schema-info { display: none !important; }
		}
`;