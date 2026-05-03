import { css } from 'lit';

export const styles = css`
:host { display: contents; }

.search-bar {
	display: flex;
	align-items: center;
	gap: 6px;
	flex: 1;
	min-width: 0;
}

.search-control {
	position: relative;
	display: flex;
	align-items: center;
	flex: 1;
	min-height: 27px;
	background: var(--vscode-input-background);
	border: 1px solid var(--vscode-input-border);
	border-radius: 2px;
}
.search-control:focus-within {
	border-color: var(--vscode-focusBorder);
}

.search-icon {
	position: absolute;
	left: 6px;
	top: 50%;
	transform: translateY(-50%);
	pointer-events: none;
	color: var(--vscode-input-placeholderForeground);
	opacity: 0.7;
	display: inline-flex;
	align-items: center;
	flex-shrink: 0;
}

.search-input {
	flex: 1;
	padding: 5px 8px 5px 26px;
	font-size: 12px;
	font-family: inherit;
	background: transparent;
	color: var(--vscode-input-foreground);
	border: none;
	outline: none;
	min-width: 0;
}
.search-input::placeholder {
	color: var(--vscode-input-placeholderForeground);
}

.search-status {
	font-size: 11px;
	color: var(--vscode-descriptionForeground);
	white-space: nowrap;
	padding: 0 4px;
	flex-shrink: 0;
	pointer-events: none;
}

.mode-toggle {
	width: 24px;
	height: 24px;
	padding: 0;
	border: none;
	background: transparent;
	color: var(--vscode-input-foreground);
	opacity: 0.7;
	cursor: pointer;
	display: inline-flex;
	align-items: center;
	justify-content: center;
	border-radius: 2px;
	font-size: 11px;
	flex-shrink: 0;
}
.mode-toggle:hover {
	opacity: 1;
	background: var(--vscode-toolbar-hoverBackground);
}
.mode-label {
	font-family: monospace;
	font-weight: bold;
}

.nav-divider {
	width: 1px;
	height: 14px;
	background: var(--vscode-input-foreground);
	opacity: 0.25;
	flex-shrink: 0;
	margin: 0 2px;
}

.nav-btn {
	width: 24px;
	height: 24px;
	padding: 0;
	border: none;
	background: transparent;
	color: var(--vscode-input-foreground);
	opacity: 0.7;
	cursor: pointer;
	display: inline-flex;
	align-items: center;
	justify-content: center;
	border-radius: 2px;
	flex-shrink: 0;
}
.nav-btn:hover:not(:disabled) {
	opacity: 1;
	background: var(--vscode-toolbar-hoverBackground);
}
.nav-btn:disabled {
	opacity: 0.35;
	cursor: default;
}
.nav-btn svg { display: block; }

.close-btn {
	width: 22px;
	height: 22px;
	padding: 0;
	border: 1px solid transparent;
	background: transparent;
	color: var(--vscode-foreground);
	cursor: pointer;
	display: inline-flex;
	align-items: center;
	justify-content: center;
	border-radius: 4px;
	flex-shrink: 0;
}
.close-btn:hover {
	background: var(--vscode-list-hoverBackground);
}
`;
