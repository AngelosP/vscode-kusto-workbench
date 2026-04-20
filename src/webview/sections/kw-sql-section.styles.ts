import { css } from 'lit';

export const styles = css`
	*, *::before, *::after {
		box-sizing: border-box;
	}

	:host {
		display: block;
		font-family: var(--vscode-font-family);
		font-size: var(--vscode-font-size);
		font-weight: var(--vscode-font-weight);
	}

	:host(.is-collapsed) .connection-row {
		display: none !important;
	}
	:host(.is-collapsed) .header-share-btn {
		display: none;
	}
	:host(.is-collapsed) {
		margin-bottom: 16px;
	}
	:host(.is-collapsed) .section-root {
		margin-bottom: 0;
		padding-bottom: 4px;
	}

	.section-root {
		display: flex;
		flex-direction: column;
		gap: 0;
		margin-bottom: 8px;
	}

	/* ── Share button (slotted into shell header-buttons) ───── */
	.header-share-btn {
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
		margin-right: 6px;
	}
	.header-share-btn svg { display: block; }
	.header-share-btn:hover { background: var(--vscode-list-hoverBackground); }

	/* ── Connection row ─────────────────────────────────────────────── */
	.connection-row {
		display: flex;
		gap: 8px;
		align-items: center;
		flex-wrap: nowrap;
		min-width: 0;
		container-type: inline-size;
	}

	/* ── Dropdown wrapper ───────────────────────────────────────────── */
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
	.select-wrapper.sql-favorites-combo {
		flex: 1 1 448px;
		width: auto;
		max-width: 448px;
		min-width: 40px;
	}

	/* ── Icon buttons ───────────────────────────────────────────────── */
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

	/* ── Spinner ─────────────────────────────────────────────────────── */
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

	/* ── Container queries (responsive) ─────────────────────────────── */
	@container (max-width: 420px) {
		.select-wrapper.half-width {
			flex: 0 0 32px;
			width: 32px;
			min-width: 32px;
			max-width: 32px;
		}
		.select-wrapper.sql-favorites-combo {
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

	/* ── Missing connections banner ─────────────────────────────── */

	.sql-missing-connections-banner {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		padding: 6px 8px;
		border-bottom: 1px solid var(--vscode-input-border);
		background: var(--vscode-editorWidget-background);
		color: var(--vscode-foreground);
		flex: 0 0 auto;
		font-size: 12px;
		line-height: 1.35;
	}

	.sql-missing-connections-text {
		flex: 1 1 auto;
		min-width: 0;
	}

	.sql-missing-connections-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		background: var(--vscode-button-background);
		border: 1px solid var(--vscode-button-border, transparent);
		border-radius: 4px;
		color: var(--vscode-button-foreground);
		cursor: pointer;
		padding: 4px 10px;
		font-size: 12px;
	}
	.sql-missing-connections-btn:hover {
		background: var(--vscode-button-hoverBackground);
	}

	/* ── Add Connection Modal ────────────────────────────────────── */
	.add-connection-overlay {
		position: fixed; top: 0; left: 0; right: 0; bottom: 0;
		background: rgba(0, 0, 0, 0.5); z-index: 10000;
		display: flex; align-items: center; justify-content: center;
	}
	.add-connection-dialog {
		background: var(--vscode-editor-background);
		border: 1px solid var(--vscode-panel-border);
		border-radius: 8px; width: 440px; max-width: 90%;
		box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
	}
	.add-connection-header {
		display: flex; align-items: center; justify-content: space-between;
		padding: 16px 20px;
		border-bottom: 1px solid var(--vscode-panel-border);
	}
	.add-connection-title { font-size: 14px; font-weight: 600; }
	.add-connection-close {
		width: 28px; height: 28px; padding: 0; border: none;
		background: transparent; color: var(--vscode-foreground);
		cursor: pointer; display: inline-flex; align-items: center;
		justify-content: center; border-radius: 4px;
	}
	.add-connection-close:hover { background: var(--vscode-toolbar-hoverBackground); }
	.add-connection-close svg { width: 16px; height: 16px; fill: currentColor; }
	.add-connection-body { padding: 16px 20px; }
	.add-connection-footer {
		display: flex; justify-content: flex-end; gap: 8px;
		padding: 12px 20px;
		border-top: 1px solid var(--vscode-panel-border);
	}
	.add-connection-btn {
		display: inline-flex; align-items: center; gap: 6px;
		padding: 6px 14px; font-size: 12px; border-radius: 2px;
		border: 1px solid var(--vscode-button-border, transparent);
		background: var(--vscode-button-secondaryBackground);
		color: var(--vscode-button-secondaryForeground);
		cursor: pointer; font-family: inherit;
	}
	.add-connection-btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
	.add-connection-btn.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
	.add-connection-btn.primary:hover { background: var(--vscode-button-hoverBackground); }
`;
