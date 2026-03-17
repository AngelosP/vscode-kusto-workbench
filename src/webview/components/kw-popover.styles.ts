import { css } from 'lit';

/**
 * Styles for `<kw-popover>`.
 * Ported verbatim from kw-chart-section.styles.ts axis-popup shell styles,
 * with class names renamed (.axis-popup → .popover, etc.).
 * Form-content styles (.axis-popup-row, .axis-popup-checkbox, etc.) intentionally
 * remain in kw-chart-section — they style slotted content inside the chart
 * section's shadow DOM.
 */
export const styles = css`
	:host {
		display: contents;
	}

	.popover {
		position: fixed;
		z-index: 10000;
		background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
		border: 1px solid var(--vscode-editorWidget-border, var(--vscode-contrastBorder, rgba(128,128,128,0.35)));
		border-radius: 0;
		box-shadow: 0 4px 16px rgba(0,0,0,0.25);
		padding: 0;
		display: flex;
		flex-direction: column;
	}

	/* Arrow pointer — shown when the host has the showarrow attribute (reflected) */
	:host([showarrow]) .popover::before {
		content: '';
		position: absolute;
		top: -6px;
		left: 12px;
		width: 10px;
		height: 10px;
		background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
		border-left: 1px solid var(--vscode-editorWidget-border, var(--vscode-contrastBorder, rgba(128,128,128,0.35)));
		border-top: 1px solid var(--vscode-editorWidget-border, var(--vscode-contrastBorder, rgba(128,128,128,0.35)));
		transform: rotate(45deg);
	}

	.popover-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 10px 12px;
		border-bottom: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.15));
		font-weight: 600;
		font-size: 12px;
	}

	.popover-close {
		background: transparent;
		border: none;
		padding: 2px;
		cursor: pointer;
		color: var(--vscode-foreground);
		opacity: 0.7;
		display: flex;
		align-items: center;
		border-radius: 0;
	}
	.popover-close:hover {
		opacity: 1;
		background: var(--vscode-toolbar-hoverBackground);
	}

	.popover-content {
		padding: 12px;
		display: flex;
		flex-direction: column;
		gap: 14px;
	}

	.popover-footer {
		padding: 0;
		border-top: none;
	}
	.popover-footer:has(::slotted(*)) {
		padding: 8px 12px;
		border-top: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.15));
	}
`;
