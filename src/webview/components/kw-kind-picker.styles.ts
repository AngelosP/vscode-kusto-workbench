import { css } from 'lit';

export const styles = css`
	:host { display: inline-flex; }
	.type-selector { display: inline-flex; gap: 2px; padding: 6px 5px; flex-shrink: 0; background: var(--vscode-toolbar-hoverBackground, rgba(128, 128, 128, 0.1)); border-radius: 4px; }
	.type-selector-btn { display: inline-flex; align-items: center; gap: 7px; padding: 5px 12px; font-size: 12px; font-weight: 500; border: none; border-radius: 3px; background: transparent; color: var(--vscode-descriptionForeground); cursor: pointer; font-family: inherit; white-space: nowrap; transition: all 0.18s ease; letter-spacing: 0.01em; }
	.type-selector-btn:hover { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground); }
	.type-selector-btn.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); box-shadow: 0 1px 3px rgba(0,0,0,0.2); }
	.type-count { font-size: 10px; font-weight: 600; background: rgba(128, 128, 128, 0.15); padding: 1px 6px; border-radius: 8px; min-width: 16px; text-align: center; line-height: 1.4; }
	.type-selector-btn.active .type-count { background: rgba(255, 255, 255, 0.22); }
	.type-selector-btn svg { width: 14px; height: 14px; flex-shrink: 0; }
	.type-label { display: var(--kw-kind-label-display, inline); }
`;
