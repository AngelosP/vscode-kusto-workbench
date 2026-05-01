import { css } from 'lit';

export const tutorialViewerStyles = css`
	:host {
		display: block;
		height: 100vh;
		color: var(--vscode-foreground);
		background: var(--vscode-editor-background);
		font-family: var(--vscode-font-family);
		font-size: var(--vscode-font-size);
		overflow: hidden;
	}

	* {
		box-sizing: border-box;
	}

	.viewer-shell {
		height: 100vh;
		padding: 12px;
		display: grid;
		place-items: center;
		background: var(--vscode-editor-background);
	}

	.viewer-frame {
		width: min(1160px, 100%);
		height: min(860px, calc(100vh - 24px));
		min-height: 420px;
		border: 1px solid var(--vscode-panel-border);
		border-radius: 8px;
		background: var(--vscode-editor-background);
		box-shadow: 0 16px 42px rgba(0, 0, 0, 0.34);
		overflow: hidden;
	}

	.loading-frame {
		display: grid;
		place-items: center;
		height: min(360px, calc(100vh - 24px));
	}

	.standard-frame {
		display: grid;
		grid-template-columns: minmax(320px, 380px) minmax(0, 1fr);
	}

	.focused-frame {
		width: min(920px, 100%);
		display: flex;
		flex-direction: column;
	}

	.sidebar {
		border-right: 1px solid var(--vscode-panel-border);
		background: var(--vscode-sideBar-background);
		display: flex;
		flex-direction: column;
		min-width: 0;
		min-height: 0;
	}

	.header,
	.detail-header,
	.focused-toolbar,
	.focused-nav {
		border-bottom: 1px solid var(--vscode-panel-border);
		background: var(--vscode-editor-background);
	}

	.header {
		padding: 14px;
		display: grid;
		gap: 10px;
		background: color-mix(in srgb, var(--vscode-sideBar-background) 82%, var(--vscode-editor-background));
	}

	.title-row,
	.toolbar-actions,
	.detail-title-row,
	.detail-actions,
	.focused-toolbar,
	.focused-actions,
	.focused-nav,
	.focused-category-row,
	.category-controls {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.title-row,
	.detail-title-row,
	.focused-toolbar,
	.focused-nav {
		justify-content: space-between;
	}

	.title-copy,
	.focused-heading {
		display: grid;
		gap: 2px;
		min-width: 0;
	}

	h1,
	h2 {
		font-weight: 600;
		line-height: 1.35;
		margin: 0;
		letter-spacing: 0;
	}

	h1 {
		font-size: 18px;
	}

	h2 {
		font-size: 20px;
	}

	.icon-btn,
	.action-btn,
	.link-btn,
	.nav-btn,
	.bell-toggle,
	.channel-pill {
		font: inherit;
		color: var(--vscode-foreground);
		border: 1px solid var(--vscode-button-border, var(--vscode-panel-border));
		background: var(--vscode-button-secondaryBackground);
		border-radius: 4px;
		min-height: 28px;
		cursor: pointer;
	}

	.icon-btn,
	.bell-toggle {
		width: 30px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: 0;
		flex: 0 0 auto;
	}

	.action-btn,
	.link-btn,
	.nav-btn,
	.channel-pill {
		padding: 5px 10px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 6px;
		text-align: center;
		white-space: nowrap;
	}

	.action-btn.primary,
	.bell-toggle.active {
		background: var(--vscode-button-background);
		color: var(--vscode-button-foreground);
		border-color: var(--vscode-button-background);
	}

	.icon-btn:hover,
	.action-btn:hover,
	.link-btn:hover,
	.nav-btn:hover:not(:disabled),
	.bell-toggle:hover,
	.channel-pill:hover {
		background: var(--vscode-button-hoverBackground);
		color: var(--vscode-button-foreground);
	}

	.channel-pill {
		min-height: 24px;
		padding: 2px 8px;
		font-size: 11px;
		line-height: 1.35;
		text-transform: lowercase;
		background: var(--vscode-badge-background);
		color: var(--vscode-badge-foreground);
		border-color: transparent;
	}

	.nav-btn:disabled {
		cursor: default;
		opacity: 0.45;
	}

	.previous svg {
		transform: rotate(180deg);
	}

	.icon-btn:focus-visible,
	.action-btn:focus-visible,
	.link-btn:focus-visible,
	.nav-btn:focus-visible,
	.category-main:focus-visible,
	.tutorial-item:focus-visible,
	.bell-toggle:focus-visible,
	.channel-pill:focus-visible {
		outline: 1px solid var(--vscode-focusBorder);
		outline-offset: 2px;
	}

	.status {
		font-size: 11px;
		line-height: 1.45;
		color: var(--vscode-descriptionForeground);
		padding: 7px 8px;
		border: 1px solid var(--vscode-panel-border);
		border-radius: 6px;
		background: color-mix(in srgb, var(--vscode-editor-background) 88%, transparent);
		word-break: break-word;
	}

	.status.warning {
		color: var(--vscode-editorWarning-foreground, var(--vscode-descriptionForeground));
		border-color: var(--vscode-editorWarning-foreground, var(--vscode-panel-border));
	}

	.section-label,
	.eyebrow,
	.position {
		font-size: 11px;
		line-height: 1.4;
		color: var(--vscode-descriptionForeground);
	}

	.section-label {
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0;
		padding: 0 4px 2px;
	}

	.categories {
		padding: 12px 10px 10px;
		display: grid;
		gap: 5px;
		border-bottom: 1px solid var(--vscode-panel-border);
	}

	.category-row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: center;
		gap: 8px;
		padding: 5px;
		border: 1px solid transparent;
		border-radius: 6px;
		background: transparent;
		min-width: 0;
	}

	.category-row:hover {
		background: var(--vscode-list-hoverBackground);
	}

	.category-row.active {
		background: var(--vscode-list-activeSelectionBackground);
		border-color: color-mix(in srgb, var(--vscode-focusBorder) 45%, transparent);
		color: var(--vscode-list-activeSelectionForeground);
	}

	.category-row.subscribed:not(.active) {
		border-color: color-mix(in srgb, var(--vscode-focusBorder) 32%, transparent);
	}

	.category-row.all {
		grid-template-columns: minmax(0, 1fr);
	}

	.category-main {
		border: 0;
		background: transparent;
		color: inherit;
		font: inherit;
		padding: 4px;
		border-radius: 4px;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		text-align: left;
		min-width: 0;
	}

	.category-copy,
	.item-copy {
		display: grid;
		gap: 3px;
		min-width: 0;
	}

	.category-title,
	.item-title {
		font-weight: 600;
		line-height: 1.35;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.category-subline,
	.item-summary,
	.detail-summary,
	.item-meta {
		color: var(--vscode-descriptionForeground);
	}

	.category-subline {
		font-size: 11px;
		line-height: 1.35;
	}

	.category-controls {
		justify-content: flex-end;
		min-width: 0;
	}

	.category-controls.compact {
		justify-content: flex-start;
	}

	.category-controls.compact .bell-toggle {
		width: 26px;
		min-height: 24px;
	}

	.bell-toggle:not(.active) {
		color: var(--vscode-descriptionForeground);
		background: transparent;
	}

	.badge {
		min-width: 20px;
		padding: 1px 6px;
		border-radius: 999px;
		font-size: 11px;
		line-height: 1.4;
		text-align: center;
		background: var(--vscode-badge-background);
		color: var(--vscode-badge-foreground);
		white-space: nowrap;
	}

	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}

	.tutorial-list {
		padding: 12px 10px;
		overflow: auto;
		min-height: 0;
		flex: 1;
		display: grid;
		align-content: start;
		gap: 8px;
	}

	.tutorial-item {
		border: 1px solid var(--vscode-panel-border);
		background: color-mix(in srgb, var(--vscode-list-inactiveSelectionBackground, transparent) 72%, transparent);
		color: var(--vscode-foreground);
		border-radius: 6px;
		padding: 10px;
		cursor: pointer;
		text-align: left;
		font: inherit;
		display: grid;
		gap: 7px;
		min-width: 0;
	}

	.tutorial-item:hover,
	.tutorial-item.active {
		border-color: var(--vscode-focusBorder);
		background: var(--vscode-list-hoverBackground);
	}

	.tutorial-item.active {
		box-shadow: inset 2px 0 0 var(--vscode-focusBorder);
	}

	.tutorial-item.incompatible {
		opacity: 0.62;
	}

	.item-summary {
		font-size: 12px;
		line-height: 1.45;
	}

	.item-meta {
		display: flex;
		align-items: center;
		gap: 6px;
		flex-wrap: wrap;
		font-size: 11px;
	}

	.detail {
		min-width: 0;
		display: flex;
		flex-direction: column;
		min-height: 0;
		background: var(--vscode-editor-background);
	}

	.detail-header {
		padding: 18px 22px 14px;
		display: grid;
		gap: 12px;
	}

	.detail-title-row {
		align-items: flex-start;
		gap: 16px;
	}

	.detail-summary {
		margin: 4px 0 0;
		line-height: 1.5;
		max-width: 760px;
	}

	.detail-actions {
		flex-wrap: wrap;
	}

	.content,
	.focused-content {
		padding: 20px 22px;
		overflow: auto;
		flex: 1;
		line-height: 1.6;
		min-height: 0;
	}

	.focused-toolbar {
		padding: 14px 16px;
		align-items: flex-start;
	}

	.focused-category-row {
		justify-content: flex-start;
		flex-wrap: wrap;
	}

	.focused-heading h1 {
		font-size: 18px;
	}

	.focused-actions {
		flex: 0 0 auto;
		flex-wrap: wrap;
		justify-content: flex-end;
	}

	.focused-content {
		padding: 22px 26px;
	}

	.focused-nav {
		border-top: 1px solid var(--vscode-panel-border);
		border-bottom: 0;
		padding: 10px 14px;
	}

	.markdown {
		max-width: 820px;
	}

	.focused-markdown {
		max-width: 760px;
		margin: 0 auto;
	}

	.markdown h1,
	.markdown h2,
	.markdown h3 {
		line-height: 1.35;
		margin: 22px 0 10px;
		letter-spacing: 0;
	}

	.markdown h1:first-child,
	.markdown h2:first-child,
	.markdown h3:first-child,
	.markdown p:first-child {
		margin-top: 0;
	}

	.markdown p,
	.markdown ul,
	.markdown ol,
	.markdown table,
	.markdown pre {
		margin: 0 0 14px;
	}

	.markdown code {
		font-family: var(--vscode-editor-font-family);
		font-size: 0.95em;
		background: var(--vscode-textCodeBlock-background);
		padding: 1px 4px;
		border-radius: 3px;
	}

	.markdown pre {
		background: var(--vscode-textCodeBlock-background);
		padding: 12px;
		border-radius: 6px;
		overflow: auto;
	}

	.markdown pre code {
		padding: 0;
		background: transparent;
	}

	.markdown img {
		max-width: 100%;
		height: auto;
		border: 1px solid var(--vscode-panel-border);
		border-radius: 6px;
	}

	.empty,
	.loading {
		color: var(--vscode-descriptionForeground);
		padding: 20px;
	}

	.error-list {
		border-left: 3px solid var(--vscode-editorWarning-foreground, #cca700);
		padding: 8px 10px;
		background: var(--vscode-inputValidation-warningBackground, transparent);
		color: var(--vscode-inputValidation-warningForeground, var(--vscode-foreground));
		font-size: 12px;
		line-height: 1.45;
		max-width: 820px;
		margin-bottom: 14px;
	}

	@media (max-width: 900px) {
		.viewer-shell {
			padding: 8px;
			place-items: stretch;
		}

		.viewer-frame {
			height: calc(100vh - 16px);
		}

		.standard-frame {
			grid-template-columns: 1fr;
		}

		.sidebar {
			border-right: 0;
			border-bottom: 1px solid var(--vscode-panel-border);
			max-height: 48vh;
		}

		.tutorial-list {
			max-height: 24vh;
		}

		.detail-title-row,
		.focused-toolbar,
		.focused-nav {
			align-items: stretch;
			flex-direction: column;
		}

		.focused-actions,
		.focused-nav {
			justify-content: stretch;
		}

		.focused-actions > *,
		.focused-nav > * {
			width: 100%;
		}
	}

	@media (max-width: 520px) {
		.category-row {
			grid-template-columns: minmax(0, 1fr);
		}

		.category-controls {
			justify-content: flex-start;
			padding-left: 4px;
		}

		.detail-header,
		.content,
		.focused-content {
			padding-left: 14px;
			padding-right: 14px;
		}
	}
`;