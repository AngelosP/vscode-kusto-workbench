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

	:host([embedded]) {
		height: 100%;
		background: transparent;
		pointer-events: none;
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
		overflow: visible;
	}

	:host([embedded]) .viewer-shell {
		height: 100%;
		background: transparent;
		pointer-events: none;
	}

	.mode-compact {
		background: color-mix(in srgb, var(--vscode-editor-background) 86%, #000 14%);
	}

	:host([embedded]) .mode-compact {
		background: transparent;
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

	.unavailable-frame {
		display: grid;
		place-items: center;
		height: min(360px, calc(100vh - 24px));
	}

	.unavailable-content {
		max-width: 560px;
		padding: 28px;
		display: grid;
		gap: 12px;
		text-align: left;
	}

	.unavailable-content p {
		margin: 0;
		line-height: 1.55;
		color: var(--vscode-foreground);
	}

	.unavailable-detail {
		font-size: 12px;
		color: var(--vscode-descriptionForeground) !important;
	}

	.standard-frame {
		position: relative;
		display: grid;
		grid-template-columns: minmax(320px, 380px) minmax(0, 1fr);
		overflow: visible;
	}

	.focused-frame {
		width: min(920px, 100%);
		display: flex;
		flex-direction: column;
	}

	.compact-backdrop {
		width: 100%;
		min-height: 100%;
		display: grid;
		place-items: center;
		overflow: visible;
	}

	:host([embedded]) .compact-backdrop {
		pointer-events: none;
	}

	:host([embedded]) .viewer-frame {
		pointer-events: auto;
	}

	.compact-frame {
		width: min(540px, calc(100vw - 24px));
		height: auto;
		min-height: 0;
		max-height: calc(100vh - 24px);
		display: flex;
		flex-direction: column;
		border-radius: 8px;
		background: var(--vscode-editor-background);
		box-shadow: 0 14px 36px rgba(0, 0, 0, 0.42);
		transform: translate(var(--kw-compact-offset-x, 0px), var(--kw-compact-offset-y, 0px));
		will-change: transform;
		overflow: visible;
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
	.focused-toolbar,
	.focused-nav,
	.compact-header,
	.compact-footer {
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
	.standard-brand-row,
	.standard-filter-row,
	.toolbar-actions,
	.detail-title-row,
	.detail-actions,
	.focused-toolbar,
	.focused-actions,
	.focused-nav,
	.focused-category-row,
	.category-controls,
	.compact-kicker-row,
	.compact-nav,
	.compact-utility-strip {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.title-row,
	.detail-title-row,
	.focused-toolbar,
	.focused-nav,
	.compact-kicker-row {
		justify-content: space-between;
	}

	.title-copy,
	.focused-heading {
		display: grid;
		gap: 2px;
		min-width: 0;
	}

	.standard-title-copy {
		align-content: center;
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
	.read-toggle,
	.bell-toggle,
	.channel-pill,
	.delivery-pill,
	.mute-menu button {
		font: inherit;
		color: var(--vscode-foreground);
		border: 1px solid transparent;
		background: transparent;
		border-radius: 4px;
		min-height: 28px;
		cursor: pointer;
	}

	.icon-btn,
	.read-toggle,
	.bell-toggle {
		width: 30px;
		min-width: 30px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: 0;
		flex: 0 0 auto;
	}

	.action-btn,
	.link-btn,
	.nav-btn,
	.channel-pill,
	.delivery-pill {
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

	.action-btn.primary:hover:not(:disabled),
	.bell-toggle.active:hover:not(:disabled) {
		background: var(--vscode-button-hoverBackground);
		color: var(--vscode-button-foreground);
	}

	.action-btn.primary:active:not(:disabled),
	.bell-toggle.active:active:not(:disabled) {
		opacity: 0.85;
	}

	.icon-btn:hover:not(:disabled),
	.action-btn:not(.primary):hover:not(:disabled),
	.link-btn:hover:not(:disabled),
	.nav-btn:hover:not(:disabled),
	.bell-toggle:not(.active):hover:not(:disabled),
	.channel-pill:hover:not(:disabled),
	.delivery-pill:hover:not(:disabled),
	.mute-menu button:hover:not(:disabled) {
		background: var(--vscode-list-hoverBackground);
		color: var(--vscode-foreground);
	}

	.icon-btn:active:not(:disabled),
	.action-btn:not(.primary):active:not(:disabled),
	.link-btn:active:not(:disabled),
	.nav-btn:active:not(:disabled),
	.bell-toggle:not(.active):active:not(:disabled),
	.channel-pill:active:not(:disabled),
	.delivery-pill:active:not(:disabled),
	.mute-menu button:active:not(:disabled) {
		opacity: 0.75;
	}

	.channel-pill,
	.delivery-pill {
		min-height: 24px;
		padding: 2px 8px;
		font-size: 11px;
		line-height: 1.35;
		text-transform: lowercase;
		background: var(--vscode-badge-background);
		color: var(--vscode-badge-foreground);
		border-color: transparent;
	}

	.icon-btn svg,
	.action-btn svg,
	.link-btn svg,
	.nav-btn svg,
	.read-toggle svg,
	.bell-toggle svg,
	.channel-pill svg,
	.delivery-pill svg,
	.mute-menu svg {
		width: 16px;
		height: 16px;
		flex: 0 0 16px;
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
	.read-toggle:focus-visible,
	.category-main:focus-visible,
	.tutorial-item:focus-visible,
	.bell-toggle:focus-visible,
	.channel-pill:focus-visible,
	.delivery-pill:focus-visible,
	.mute-menu button:focus-visible {
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

	.compact-header {
		position: relative;
		padding: 16px 42px 10px 16px;
		display: grid;
		gap: 8px;
		border-bottom: 0;
		background: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-sideBar-background));
	}

	.compact-brand,
	.standard-brand {
		font-size: 11px;
		font-weight: 700;
		letter-spacing: 0;
		text-transform: uppercase;
		color: var(--vscode-textLink-foreground);
	}

	.standard-brand-row {
		justify-content: flex-start;
		gap: 6px;
	}

	h1.standard-brand {
		font-size: 16px;
		font-weight: 500;
		line-height: 1.2;
	}

	.status-info {
		width: 18px;
		height: 18px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		color: var(--vscode-textLink-foreground);
		cursor: help;
		user-select: none;
	}

	.status-info .codicon {
		font-size: 16px;
		width: 16px;
		height: 16px;
	}

	.status-info.warning {
		color: var(--vscode-editorWarning-foreground, var(--vscode-textLink-foreground));
	}

	.standard-filter-row {
		min-width: 0;
		flex-wrap: wrap;
	}

	.category-dropdown {
		flex: 1 1 auto;
		min-width: 0;
	}

	.standard-seen-toggle {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		min-height: 27px;
		color: var(--vscode-descriptionForeground);
		font-size: 12px;
		line-height: 1.35;
		white-space: nowrap;
		cursor: pointer;
		user-select: none;
	}

	.standard-seen-toggle input {
		width: 14px;
		height: 14px;
		margin: 0;
		accent-color: var(--vscode-checkbox-selectBackground, var(--vscode-focusBorder));
	}

	.standard-seen-toggle input:focus-visible {
		outline: 1px solid var(--vscode-focusBorder);
		outline-offset: 2px;
	}

	.standard-mute-wrap {
		flex: 0 0 auto;
	}

	.toolbar-actions {
		justify-content: flex-end;
		gap: 4px;
		margin-left: auto;
		flex: 0 0 auto;
	}

	.standard-close {
		position: absolute;
		top: 10px;
		right: 10px;
		z-index: 20;
		color: var(--vscode-descriptionForeground);
	}

	.standard-refresh svg {
		width: 14px;
		height: 14px;
		flex-basis: 14px;
	}

	.compact-close {
		position: absolute;
		top: 10px;
		right: 10px;
		width: 26px;
		min-width: 26px;
		min-height: 26px;
		background: transparent;
		border-color: transparent;
		color: var(--vscode-descriptionForeground);
	}

	.compact-header h1 {
		font-size: 19px;
		line-height: 1.25;
		padding-right: 8px;
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
		position: relative;
		padding: 10px 24px 10px 8px;
		overflow: auto;
		min-height: 0;
		flex: 1;
		display: block;
		overscroll-behavior: contain;
		scrollbar-gutter: stable;
		background: color-mix(in srgb, var(--vscode-sideBar-background) 96%, var(--vscode-editor-background));
	}

	.tutorial-list .os-scrollbar-vertical {
		opacity: 1 !important;
		visibility: visible !important;
	}

	.tutorial-list .os-scrollbar-vertical .os-scrollbar-handle {
		min-height: 20px;
	}

	.tutorial-item-row {
		display: grid;
		grid-template-columns: 30px minmax(0, 1fr);
		align-items: stretch;
		gap: 4px;
		min-width: 0;
		width: 100%;
		margin: 0 0 3px;
		border: 1px solid transparent;
		border-radius: 4px;
		background: transparent;
		transition: background 120ms ease, border-color 120ms ease, color 120ms ease;
	}

	.tutorial-item-row:last-child {
		margin-bottom: 0;
	}

	.tutorial-item-row:hover {
		border-color: color-mix(in srgb, var(--vscode-focusBorder) 48%, transparent);
		background: var(--vscode-list-hoverBackground);
	}

	.tutorial-item-row.active {
		border-color: color-mix(in srgb, var(--vscode-focusBorder) 72%, transparent);
		background: var(--vscode-inputValidation-infoBackground, rgba(0, 122, 204, 0.08));
		box-shadow: inset 2px 0 0 color-mix(in srgb, var(--vscode-focusBorder) 86%, transparent);
	}

	.tutorial-item-row.active:hover {
		background: color-mix(in srgb, var(--vscode-inputValidation-infoBackground, rgba(0, 122, 204, 0.08)) 82%, var(--vscode-list-hoverBackground));
	}

	.tutorial-item-row.incompatible {
		opacity: 0.62;
	}

	.read-toggle {
		width: 26px;
		min-width: 26px;
		min-height: 26px;
		height: 26px;
		align-self: start;
		margin: 6px 0 0 5px;
		color: color-mix(in srgb, var(--vscode-descriptionForeground) 86%, transparent);
		background: transparent;
		border-color: transparent;
	}

	.read-toggle.unread {
		color: var(--vscode-textLink-foreground);
	}

	.read-toggle.read {
		opacity: 0.72;
	}

	.read-toggle:hover:not(:disabled) {
		background: color-mix(in srgb, var(--vscode-list-hoverBackground) 82%, var(--vscode-editor-background));
		color: var(--vscode-foreground);
		opacity: 1;
	}

	.tutorial-item {
		border: 0;
		background: transparent;
		color: color-mix(in srgb, var(--vscode-foreground) 68%, var(--vscode-descriptionForeground));
		border-radius: 3px;
		padding: 9px 10px 9px 0;
		cursor: pointer;
		text-align: left;
		font: inherit;
		display: grid;
		gap: 5px;
		min-width: 0;
		width: 100%;
		margin: 0;
		transition: background 120ms ease, border-color 120ms ease, color 120ms ease;
	}

	.search-hit {
		padding: 0 1px;
		border-radius: 2px;
		background: var(--vscode-editor-findMatchHighlightBackground, rgba(234, 92, 0, 0.33));
		color: inherit;
	}

	.search-hit.current {
		background: var(--vscode-editor-findMatchBackground, rgba(234, 92, 0, 0.55));
		outline: 1px solid var(--vscode-editor-findMatchBorder, var(--vscode-focusBorder));
		outline-offset: 1px;
	}

	.tutorial-item:hover,
	.tutorial-item:focus-visible {
		background: transparent;
		color: var(--vscode-foreground);
	}

	.tutorial-item.active {
		background: transparent;
		color: var(--vscode-foreground);
	}

	.tutorial-item.active .item-title {
		color: var(--vscode-foreground);
	}

	.tutorial-item:not(.active) .item-title {
		color: color-mix(in srgb, var(--vscode-foreground) 62%, var(--vscode-descriptionForeground));
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
		text-align: left;
	}

	.standard-footer {
		border-top: 1px solid var(--vscode-panel-border);
		padding: 10px 14px;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		flex-wrap: wrap;
		background: color-mix(in srgb, var(--vscode-editor-background) 94%, var(--vscode-sideBar-background));
	}

	.standard-nav {
		justify-content: flex-start;
		flex: 0 0 auto;
	}

	.standard-footer-actions {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: 6px;
	}

	.standard-footer-link {
		min-height: 28px;
		padding: 5px 10px;
		border-color: transparent;
		background: transparent;
		color: var(--vscode-descriptionForeground);
	}

	.standard-got-it {
		min-width: 72px;
	}

	.compact-content {
		padding: 6px 16px 12px;
		overflow: auto;
		line-height: 1.5;
		max-height: min(500px, calc(100vh - 210px));
		min-height: 0;
		text-align: left;
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
		margin: 0;
		text-align: left;
	}

	.focused-markdown {
		max-width: 760px;
		margin: 0;
	}

	.compact-markdown {
		max-width: none;
	}

	.compact-markdown h1 {
		display: none;
	}

	.compact-markdown h2,
	.compact-markdown h3 {
		font-size: 13px;
		margin: 10px 0 6px;
	}

	.compact-markdown p,
	.compact-markdown ul,
	.compact-markdown ol,
	.compact-markdown table,
	.compact-markdown pre {
		margin-bottom: 10px;
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

	.compact-markdown pre {
		padding: 10px 12px;
		border: 1px solid var(--vscode-panel-border);
		overflow: hidden;
		white-space: pre-wrap;
		word-break: break-word;
	}

	.markdown pre code {
		padding: 0;
		background: transparent;
	}

	.compact-markdown pre code {
		white-space: inherit;
		font-size: 11.5px;
		line-height: 1.45;
	}

	.markdown img {
		display: block;
		max-width: 100%;
		height: auto;
		margin: 10px 0 14px;
		border: 1px solid var(--vscode-panel-border);
		border-radius: 6px;
	}

	.compact-markdown img {
		max-height: min(320px, 42vh);
		object-fit: contain;
	}

	.compact-footer {
		border-top: 1px solid var(--vscode-panel-border);
		border-bottom: 0;
		padding: 10px 12px;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		flex-wrap: wrap;
		background: color-mix(in srgb, var(--vscode-editor-background) 94%, var(--vscode-sideBar-background));
	}

	.compact-nav,
	.compact-utility-strip {
		flex-wrap: wrap;
	}

	.compact-utility-strip {
		justify-content: flex-end;
		gap: 6px;
		margin-left: auto;
	}

	.compact-nav {
		gap: 8px;
		color: var(--vscode-descriptionForeground);
	}

	.compact-nav .icon-btn {
		width: 38px;
		min-width: 38px;
		min-height: 34px;
		border-radius: 6px;
		background: transparent;
		border-color: transparent;
		color: var(--vscode-foreground);
		transition: background-color 120ms ease, color 120ms ease, opacity 80ms ease;
	}

	.compact-nav .icon-btn:hover:not(:disabled) {
		background: var(--vscode-list-hoverBackground);
		color: var(--vscode-foreground);
	}

	.compact-nav .icon-btn:active:not(:disabled) {
		opacity: 0.75;
	}

	.compact-nav .icon-btn:disabled {
		opacity: 0.38;
		cursor: default;
		background: transparent;
		border-color: transparent;
	}

	.delivery-pill {
		background: transparent;
		color: var(--vscode-descriptionForeground);
		border-color: var(--vscode-panel-border);
		text-transform: none;
	}

	.compact-link {
		border-color: transparent;
		background: transparent;
		color: var(--vscode-descriptionForeground);
		min-height: 28px;
		padding: 5px 10px;
	}

	.compact-got-it {
		min-width: 72px;
	}

	.compact-empty-message {
		width: 100%;
		text-align: left;
		line-height: 1.5;
	}

	.mute-wrap {
		position: relative;
		display: inline-flex;
	}

	.mute-menu {
		position: absolute;
		right: 0;
		bottom: 100%;
		z-index: 40;
		min-width: 280px;
		padding: 4px;
		border: 1px solid var(--vscode-panel-border);
		border-radius: 6px;
		background: var(--vscode-dropdown-background, var(--vscode-editor-background));
		box-shadow: 0 8px 24px rgba(0, 0, 0, 0.28);
	}

	.mute-menu button {
		width: 100%;
		min-height: 28px;
		justify-content: flex-start;
		padding: 5px 8px;
		border-color: transparent;
		background: transparent;
		text-align: left;
	}

	.mute-menu button:disabled {
		opacity: 0.55;
		cursor: default;
	}

	.mute-menu-item {
		display: flex;
		align-items: flex-start;
		gap: 8px;
	}

	.mute-menu-item > span:last-child {
		display: grid;
		gap: 1px;
	}

	.mute-submenu-parent {
		position: relative;
	}

	.mute-submenu-trigger .submenu-chevron {
		width: 14px;
		height: 14px;
		margin-left: auto;
		transform: rotate(180deg);
		color: var(--vscode-descriptionForeground);
	}

	.mute-flyout {
		position: absolute;
		right: 100%;
		bottom: 0;
		z-index: 3;
		min-width: 220px;
		padding: 4px;
		border: 1px solid var(--vscode-panel-border);
		border-radius: 6px;
		background: var(--vscode-dropdown-background, var(--vscode-editor-background));
		box-shadow: 0 8px 24px rgba(0, 0, 0, 0.28);
	}

	.menu-check {
		width: 14px;
		height: 14px;
		margin-top: 1px;
		flex: 0 0 14px;
	}

	.menu-subline {
		font-size: 11px;
		line-height: 1.3;
		color: var(--vscode-descriptionForeground);
	}

	.mute-menu-divider {
		height: 1px;
		margin: 4px 2px;
		background: var(--vscode-panel-border);
	}

	.empty,
	.loading {
		color: var(--vscode-descriptionForeground);
		padding: 20px;
	}

	.content-empty {
		margin: auto;
		max-width: 420px;
		text-align: center;
		line-height: 1.5;
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

		.compact-frame {
			height: auto;
		}

		.standard-frame {
			grid-template-columns: 1fr;
		}

		.standard-close {
			position: static;
			top: auto;
			right: auto;
			z-index: auto;
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
		.viewer-shell.mode-compact {
			padding: 8px;
		}

		.compact-frame {
			width: calc(100vw - 16px);
			max-height: calc(100vh - 16px);
		}

		.compact-utility-strip {
			align-items: stretch;
			flex-direction: column;
		}

		.compact-nav {
			justify-content: space-between;
		}

		.compact-utility-strip > * {
			width: 100%;
		}

		.standard-filter-row {
			align-items: stretch;
		}

		.category-dropdown {
			flex-basis: min(220px, calc(100% - 38px));
		}

		.mute-wrap,
		.mute-wrap > .compact-link {
			width: 100%;
		}

		.standard-mute-wrap {
			width: auto;
		}

		.mute-menu {
			left: 0;
			right: 0;
			min-width: 0;
		}

		.category-row {
			grid-template-columns: minmax(0, 1fr);
		}

		.category-controls {
			justify-content: flex-start;
			padding-left: 4px;
		}

		.content,
		.focused-content {
			padding-left: 14px;
			padding-right: 14px;
		}
	}
`;