import { css } from 'lit';

/**
 * Shared section shell styles — ported from kw-chart-section.styles.ts
 * and kw-markdown-section.styles.ts header/chrome rules.
 */
export const styles = css`
		*, *::before, *::after { box-sizing: border-box; }

		:host {
			display: contents;
		}

		/* ── Unsaved-changes indicator borders ───────────────────────────── */
		:host([has-changes="modified"]) .section-header {
			border-left: 3px solid var(--vscode-editorGutter-modifiedBackground, #1b81a8);
			padding-left: 6px;
		}
		:host([has-changes="new"]) .section-header {
			border-left: 3px solid var(--vscode-editorGutter-addedBackground, #2ea043);
			padding-left: 6px;
		}

		/* Diff button accent color when changes present */
		:host([has-changes="modified"]) .diff-btn {
			color: var(--vscode-editorGutter-modifiedBackground, #1b81a8);
		}
		:host([has-changes="new"]) .diff-btn {
			color: var(--vscode-editorGutter-addedBackground, #2ea043);
		}
		.diff-btn .codicon { font-size: 14px; }

		/* ── Header ──────────────────────────────────────────────────────── */

		.section-header {
			display: flex;
			gap: 8px;
			align-items: center;
			justify-content: space-between;
			margin-bottom: 8px;
		}

		.query-name-group {
			display: inline-flex;
			align-items: center;
			gap: 0;
			min-width: 0;
			flex: 1 1 auto;
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
		.section-drag-handle:focus-visible {
			outline: none;
			border-color: var(--vscode-focusBorder);
		}
		.section-drag-handle-glyph {
			font-size: 14px;
			line-height: 1;
			letter-spacing: -1px;
		}

		.query-name {
			font-size: 12px;
			color: var(--vscode-foreground);
			background: transparent;
			border: 1px solid transparent;
			border-radius: 4px;
			padding: 2px 6px;
			outline: none;
			min-width: 0;
			flex: 1 1 auto;
			font-family: inherit;
		}
		.query-name::placeholder {
			color: var(--vscode-input-placeholderForeground);
		}
		.query-name:hover {
			border-color: var(--vscode-input-border);
		}
		.query-name:focus {
			border-color: var(--vscode-focusBorder);
		}

		/* ── Action buttons ──────────────────────────────────────────────── */

		.section-actions {
			display: inline-flex;
			gap: 2px;
			align-items: center;
			flex: 0 0 auto;
		}

		.md-tabs {
			display: inline-flex;
			gap: 2px;
			align-items: center;
			border: none;
			border-radius: 0;
			overflow: visible;
			margin: 0;
			background: transparent;
		}

		.md-tabs-divider {
			width: 1px;
			height: 16px;
			background: var(--vscode-input-border, rgba(128,128,128,0.3));
			margin: 0 2px;
		}

		.unified-btn-secondary {
			background: transparent;
			color: var(--vscode-foreground);
			border: 1px solid transparent;
			border-radius: 4px;
			padding: 4px 8px;
			font-size: 12px;
			cursor: pointer;
			display: inline-flex;
			align-items: center;
			justify-content: center;
			gap: 4px;
			white-space: nowrap;
			line-height: 1.4;
		}
		.unified-btn-secondary:hover:not(:disabled) {
			background: var(--vscode-list-hoverBackground);
		}

		.unified-btn-icon-only {
			width: 28px;
			height: 28px;
			min-width: 28px;
			padding: 0;
		}
		.unified-btn-icon-only svg { display: block; }

		.md-tab {
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
			outline: none;
		}
		.md-tab svg { display: block; }
		.md-tab:hover { background: var(--vscode-list-hoverBackground); }
		.md-tab.is-active {
			background: var(--vscode-toolbar-activeBackground, var(--vscode-actionBar-toggledBackground, rgba(128, 128, 128, 0.25)));
			color: var(--vscode-foreground);
		}

		.close-btn {
			background: transparent;
			border: 1px solid transparent;
			color: var(--vscode-foreground);
			border-radius: 4px;
			cursor: pointer;
		}
		.close-btn:hover { background: var(--vscode-list-hoverBackground); }
`;
