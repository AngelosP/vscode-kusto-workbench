import { css } from 'lit';

export const styles = css`
	:host {
		position: absolute;
		z-index: 100;
		min-width: 220px;
		max-width: 380px;
		max-height: 340px;
		display: flex;
		flex-direction: column;
		background: var(--vscode-editorHoverWidget-background, var(--vscode-editorWidget-background, #252526));
		color: var(--vscode-editorHoverWidget-foreground, var(--vscode-foreground, #ccc));
		border: 1px solid var(--vscode-editorHoverWidget-border, var(--vscode-widget-border, rgba(128,128,128,0.35)));
		border-radius: 4px;
		box-shadow: 0 4px 16px rgba(0,0,0,0.35);
		font-size: 12px;
		line-height: 1.5;
		pointer-events: auto;
		overflow: hidden;
	}

	/* ── Header ──────────────────────────────────────────────── */
	.kpt-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 6px 14px 4px;
		border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.2));
		gap: 6px;
		flex-shrink: 0;
	}
	.kpt-title {
		font-weight: 600;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		flex: 1 1 auto;
		min-width: 0;
	}
	.kpt-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 22px;
		height: 22px;
		padding: 0;
		background: transparent;
		border: none;
		border-radius: 3px;
		color: inherit;
		cursor: pointer;
		opacity: 0.7;
	}
	.kpt-btn:hover {
		opacity: 1;
		background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.15));
	}

	/* ── Search (inline row inside table) ────────────────────── */
	.kpt-search-row td {
		padding: 4px 0 4px 0;
	}
	.kpt-search-control {
		position: relative;
		display: flex;
		align-items: center;
		background: var(--vscode-input-background);
		border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.3));
		border-radius: 2px;
	}
	.kpt-search-control:focus-within {
		border-color: var(--vscode-focusBorder, #007acc);
	}
	.kpt-search-icon {
		position: absolute;
		left: 5px;
		top: 50%;
		transform: translateY(-50%);
		pointer-events: none;
		color: var(--vscode-input-placeholderForeground);
		opacity: 0.7;
		display: inline-flex;
		align-items: center;
	}
	.kpt-search {
		flex: 1;
		padding: 3px 6px 3px 22px;
		font-size: 11px;
		font-family: var(--vscode-font-family, sans-serif);
		color: var(--vscode-input-foreground, var(--vscode-foreground));
		background: transparent;
		border: none;
		outline: none;
		min-width: 0;
	}
	.kpt-search::placeholder {
		color: var(--vscode-input-placeholderForeground);
	}

	/* ── Table wrapper ───────────────────────────────────────── */
	.kpt-table-wrap {
		overflow-y: auto;
		overflow-x: hidden;
		flex: 1 1 auto;
		min-height: 0;
		padding: 0 14px 14px;
	}

	/* ── Table ───────────────────────────────────────────────── */
	.kpt-table {
		width: 100%;
		border-collapse: collapse;
		border-spacing: 0;
	}
	.kpt-table thead th {
		padding: 3px 4px;
		font-size: 11px;
		font-weight: 500;
		opacity: 0.6;
		text-align: left;
		white-space: nowrap;
		border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.15));
		user-select: none;
		cursor: pointer;
		position: sticky;
		top: 0;
		background: var(--vscode-editorHoverWidget-background, var(--vscode-editorWidget-background, #252526));
		z-index: 1;
	}
	.kpt-table thead th:hover {
		opacity: 1;
	}
	.kpt-th-accent {
		width: 18px;
		padding: 4px 0 0 0 !important;
	}
	.kpt-search-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 18px;
		height: 18px;
		padding: 0;
		background: transparent;
		border: none;
		border-radius: 3px;
		color: inherit;
		cursor: pointer;
		opacity: 0.5;
	}
	.kpt-search-btn:hover {
		opacity: 1;
		background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.15));
	}
	.kpt-search-btn.kpt-search-active {
		opacity: 1;
		background: var(--vscode-toolbar-activeBackground, rgba(128,128,128,0.25));
	}
	.kpt-th-value {
		text-align: right !important;
	}

	/* ── Rows ────────────────────────────────────────────────── */
	.kpt-row {
		cursor: pointer;
	}
	.kpt-row:hover {
		background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.12));
	}
	.kpt-row.kpt-active {
		background: var(--vscode-list-activeSelectionBackground, rgba(0,120,212,0.3));
		color: var(--vscode-list-activeSelectionForeground, inherit);
	}
	.kpt-row td {
		padding: 2px 4px;
		white-space: nowrap;
	}

	/* ── Accent cell ─────────────────────────────────────────── */
	.kpt-accent {
		width: 18px;
		min-width: 18px;
		max-width: 18px;
		padding: 0 !important;
		position: relative;
	}
	.kpt-accent-bar {
		position: absolute;
		top: 1px;
		bottom: 1px;
		left: 4px;
		width: 3px;
		border-radius: 2px;
		transition: all 0.15s ease;
		pointer-events: none;
	}
	.kpt-row:hover .kpt-accent-bar {
		top: 50%;
		bottom: auto;
		left: 1px;
		width: 16px;
		height: 16px;
		border-radius: 3px;
		transform: translateY(-50%);
		cursor: pointer;
		pointer-events: auto;
	}
	.kpt-color-input {
		position: absolute;
		top: 0;
		left: 0;
		width: 100%;
		height: 100%;
		opacity: 0;
		cursor: pointer;
		padding: 0;
		border: none;
		pointer-events: none;
	}
	.kpt-row:hover .kpt-color-input {
		pointer-events: auto;
	}

	/* ── Name / Value cells ──────────────────────────────────── */
	.kpt-name {
		font-weight: 500;
		overflow: hidden;
		text-overflow: ellipsis;
		max-width: 180px;
	}
	.kpt-value {
		text-align: right;
		font-family: monospace;
		opacity: 0.85;
	}

	/* ── Extra payload ───────────────────────────────────────── */
	.kpt-extra {
		border-top: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.2));
		padding: 4px 14px 6px;
		flex-shrink: 0;
	}
	.kpt-extra-row {
		font-size: 11px;
		opacity: 0.8;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.kpt-extra-key {
		opacity: 0.6;
	}
`;
