import { css } from 'lit';

/**
 * Styles for `<kw-copilot-chat>` — the Copilot Chat panel that lives
 * inside `<kw-query-section>` as a sibling pane to the Monaco editor.
 *
 * CSS variables are matched 1:1 against the legacy queryEditor-copilot-chat.css.
 */
export const styles = css`
	:host {
		display: flex;
		flex-direction: column;
		min-height: 0;
		width: 100%;
		flex: 1 1 auto;
		margin: 0;
		border: none;
		border-left: 1px solid var(--vscode-input-border);
		border-radius: 0;
		padding: 0;
		background: var(--vscode-editorWidget-background);
		color: var(--vscode-foreground);
		font-family: var(--vscode-font-family);
		font-size: var(--vscode-font-size);
	}

	*, *::before, *::after { box-sizing: border-box; }

	/* ── Header ─────────────────────────────────────────────────── */

	.chat-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		margin: 0;
		padding: 0 2px 0 6px;
		height: 35px;
		min-height: 35px;
		border-bottom: 1px solid var(--vscode-input-border, var(--vscode-widget-border, var(--vscode-panel-border, rgba(128,128,128,0.25))));
	}

	.chat-title {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 12px;
		font-weight: 600;
		color: var(--vscode-foreground);
		margin-left: 5px;
	}

	.chat-header-actions {
		display: inline-flex;
		align-items: center;
		gap: 0;
	}

	/* ── Buttons (shared) ───────────────────────────────────────── */

	.icon-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		background: transparent;
		border: none;
		border-radius: 0;
		color: var(--vscode-foreground);
		cursor: pointer;
		padding: 0;
		flex: 0 0 auto;
	}
	.icon-btn:hover {
		background: var(--vscode-button-secondaryHoverBackground);
	}

	.clear-btn {
		width: 28px;
		height: 28px;
		margin-left: 4px;
	}
	.clear-btn .codicon { font-size: 16px; }

	.close-btn {
		width: 28px;
		height: 28px;
	}
	.close-btn .codicon { font-size: 16px; }

	/* ── Messages container ─────────────────────────────────────── */

	.messages {
		max-height: none;
		flex: 1 1 auto;
		min-height: 0;
		overflow: auto;
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding: 6px;
		border: none;
		border-radius: 0;
		background: var(--vscode-editor-background);
		margin: 8px 8px 8px;
	}

	/* ── Message bubbles ────────────────────────────────────────── */

	.msg {
		font-size: 12px;
		line-height: 1.35;
		white-space: pre-wrap;
		word-break: break-word;
		padding: 6px 8px;
		border-radius: 0;
		border: 1px solid var(--vscode-input-border);
		margin: 0;
	}

	.msg-user {
		align-self: flex-end;
		background: color-mix(in srgb, var(--vscode-button-background, #0e639c) 15%, var(--vscode-editor-background, #1e1e1e) 85%);
		border: 1px solid color-mix(in srgb, var(--vscode-button-background, #0e639c) 30%, transparent 70%);
		margin-left: 50px;
		margin-top: 5px;
		margin-bottom: 4px;
	}

	.msg-assistant {
		align-self: flex-start;
		background: transparent;
		color: var(--vscode-foreground);
		border: none;
		white-space: normal;
	}

	/* Markdown content inside assistant messages */
	.msg-assistant p { margin: 0 0 6px; }
	.msg-assistant p:last-child { margin-bottom: 0; }
	.msg-assistant code {
		font-family: var(--vscode-editor-font-family, monospace);
		font-size: 11px;
		background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.15));
		padding: 1px 4px;
		border-radius: 3px;
	}
	.msg-assistant pre {
		margin: 4px 0;
		padding: 6px 8px;
		background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.15));
		border-radius: 3px;
		overflow-x: auto;
		font-size: 11px;
		line-height: 1.4;
	}
	.msg-assistant pre code {
		background: none;
		padding: 0;
		border-radius: 0;
	}
	.msg-assistant ul, .msg-assistant ol {
		margin: 4px 0;
		padding-left: 20px;
	}
	.msg-assistant li { margin: 1px 0; }
	.msg-assistant strong { font-weight: 600; }
	.msg-assistant a {
		color: var(--vscode-textLink-foreground, #3794ff);
		text-decoration: none;
	}
	.msg-assistant a:hover { text-decoration: underline; }

	.msg-assistant + .msg-assistant {
		margin-top: -6px;
		margin-bottom: 0;
	}

	.msg-notification {
		align-self: flex-start;
		background: transparent;
		color: var(--vscode-editorGhostText-foreground, var(--vscode-disabledForeground, rgba(204, 204, 204, 0.5)));
		border: none;
		font-style: italic;
		text-align: left;
		padding: 4px 4px;
	}
	.msg-notification a {
		color: var(--vscode-textLink-foreground, #3794ff);
		text-decoration: none;
	}
	.msg-notification a:hover {
		text-decoration: underline;
		color: var(--vscode-textLink-activeForeground, #3794ff);
	}

	/* Tool call messages */
	.msg-tool {
		background: var(--vscode-textBlockQuote-background, rgba(128, 128, 128, 0.1));
		border-left: 3px solid var(--vscode-charts-green, #89d185);
		max-width: 350px;
		margin-right: 25px;
		padding: 6px 8px;
		white-space: normal;
	}
	.msg-tool.is-error {
		border-left-color: var(--vscode-inputValidation-errorBorder, #f48771);
	}

	/* System messages (general rules, devnotes context) */
	.msg-system {
		background: var(--vscode-textBlockQuote-background, rgba(128, 128, 128, 0.1));
		border-left: 3px solid var(--vscode-textLink-foreground);
		max-width: 350px;
		margin-right: 25px;
		padding: 6px 8px;
		white-space: normal;
	}

	/* Query snapshot messages */
	.msg-query-snapshot {
		background: var(--vscode-textBlockQuote-background, rgba(128, 128, 128, 0.1));
		border-left: 3px solid var(--vscode-charts-blue, #4fc1ff);
		max-width: 350px;
		margin-right: 25px;
		padding: 6px 8px;
		white-space: normal;
	}

	/* Clarifying question messages */
	.msg-clarifying-question {
		background: var(--vscode-textBlockQuote-background, rgba(128, 128, 128, 0.1));
		border-left: 3px solid var(--vscode-charts-purple, #b180d7);
		max-width: 350px;
		margin-right: 25px;
		padding: 6px 8px;
		white-space: normal;
	}

	.clarifying-question-text {
		padding: 4px 0 2px 0;
		color: var(--vscode-foreground);
		font-size: 12px;
		line-height: 1.4;
		white-space: pre-wrap;
		word-break: break-word;
	}

	/* Removed state */
	.msg.is-removed {
		opacity: 0.5;
	}
	.msg.is-removed .tool-result {
		text-decoration: line-through;
	}

	/* ── Tool header / result rows ──────────────────────────────── */

	.tool-header {
		display: flex;
		gap: 8px;
		align-items: center;
		justify-content: space-between;
	}
	.tool-header-left {
		display: flex;
		align-items: center;
		gap: 6px;
	}
	.tool-icon {
		display: inline-flex;
		align-items: center;
		flex: 0 0 auto;
	}
	.tool-icon svg {
		width: 14px;
		height: 14px;
	}
	.tool-icon.codicon {
		font-size: 14px;
	}
	.tool-header-right {
		display: flex;
		align-items: center;
		gap: 4px;
	}
	.tool-result {
		margin-top: 2px;
		margin-bottom: 2px;
		font-size: 12px;
		color: var(--vscode-descriptionForeground);
		padding-left: 20px;
	}
	.tool-result.is-error {
		color: var(--vscode-inputValidation-errorBorder, #f48771);
	}

	/* Tool action icon buttons */
	.tool-icon-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 18px;
		height: 18px;
		padding: 0;
		border: none;
		border-radius: 4px;
		background: transparent;
		color: var(--vscode-foreground);
		opacity: 0.7;
		cursor: pointer;
	}
	.tool-icon-btn:hover {
		background: var(--vscode-toolbar-hoverBackground, rgba(90,93,94,.31));
		opacity: 1;
	}
	.tool-icon-btn .codicon { font-size: 13px; }
	.remove-btn:hover {
		color: var(--vscode-inputValidation-errorBorder, #f48771);
	}

	/* ── Tooltip ────────────────────────────────────────────────── */

	.tool-tooltip {
		position: fixed;
		background: var(--vscode-editorHoverWidget-background, #252526);
		border: 1px solid var(--vscode-editorHoverWidget-border, #454545);
		padding: 8px 10px;
		border-radius: 4px;
		font-size: 11px;
		width: 350px;
		max-height: 300px;
		overflow: auto;
		z-index: 10000;
		box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
		white-space: pre-wrap;
		word-break: break-word;
		display: none;
		pointer-events: none;
	}
	.tool-tooltip.is-visible {
		display: block;
		pointer-events: auto;
	}
	.tooltip-label {
		font-weight: 600;
		color: var(--vscode-charts-blue, #4fc1ff);
		margin-bottom: 4px;
	}
	.tooltip-content {
		color: var(--vscode-foreground);
		font-family: var(--vscode-editor-font-family, monospace);
	}

	/* ── Input area ─────────────────────────────────────────────── */

	.input-resizer {
		flex: 0 0 1px;
		height: 1px;
		cursor: ns-resize;
		background: var(--vscode-panel-border, rgba(128,128,128,0.35));
		position: relative;
		touch-action: none;
		margin: 0 8px;
		z-index: 1;
	}
	.input-resizer::after {
		content: '';
		position: absolute;
		left: 0;
		right: 0;
		top: -3px;
		bottom: -3px;
	}
	.input-resizer::before {
		content: '';
		position: absolute;
		left: 0;
		right: 0;
		top: 50%;
		height: 0;
		transform: translateY(-50%);
		background: var(--vscode-sash-hoverBorder, #007fd4);
		transition: height 0.1s ease;
		pointer-events: none;
		z-index: 1;
	}
	.input-resizer:hover::before { height: 6px; }
	.input-resizer.is-dragging::before { height: 6px; }

	.input-area {
		display: flex;
		flex-direction: column;
		flex: 0 0 auto;
		gap: 0;
		margin: 0;
		padding: 0 8px 5px;
	}

	.input-area textarea {
		flex: 0 0 auto;
		resize: none;
		min-height: 20px;
		height: 32px;
		max-height: 400px;
		overflow-y: auto;
		background: var(--vscode-input-background);
		color: var(--vscode-input-foreground);
		border: 1px solid var(--vscode-input-border);
		border-bottom: none;
		border-radius: 0;
		padding: 6px 8px;
		font-size: 12px;
		line-height: 1.35;
		outline: none;
		font-family: var(--vscode-font-family);
	}

	/* Input bar beneath textarea */
	.input-bar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0;
		padding: 3px 4px 3px 0;
		background: var(--vscode-input-background);
		border: 1px solid var(--vscode-input-border);
		border-top: none;
		min-height: 28px;
		container-type: inline-size;
		container-name: copilot-input-bar;
		position: relative;
	}

	.input-bar-left {
		display: flex;
		align-items: center;
		gap: 0;
		min-width: 0;
		overflow: hidden;
		flex: 1 1 auto;
	}

	/* ── Tools button ───────────────────────────────────────────── */

	.tools-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		background: transparent;
		border: none;
		border-radius: 0;
		color: var(--vscode-foreground);
		cursor: pointer;
		width: 18px;
		height: 18px;
		margin-left: 0;
		margin-bottom: -2px;
		padding: 0;
		flex: 0 0 auto;
	}
	.tools-btn svg { width: 14px; height: 14px; }
	.tools-btn:hover {
		background: var(--vscode-button-secondaryHoverBackground);
	}
	.tools-btn.is-active {
		background: var(--vscode-toolbar-activeBackground, var(--vscode-actionBar-toggledBackground, rgba(128, 128, 128, 0.25)));
		color: var(--vscode-foreground);
	}
	.tools-btn.is-active:hover {
		background: var(--vscode-toolbar-activeBackground, var(--vscode-actionBar-toggledBackground, rgba(128, 128, 128, 0.25)));
	}

	/* Tools container */
	.tools-container {
		position: static;
		display: inline-flex;
		margin-left: 0;
		flex: 0 0 auto;
	}

	/* Tools panel (fixed position) */
	.tools-panel {
		position: fixed;
		z-index: 1000;
		min-width: 300px;
		max-width: 380px;
		padding: 10px;
		border: 1px solid var(--vscode-input-border);
		border-radius: 4px;
		background: var(--vscode-editorWidget-background);
		color: var(--vscode-foreground);
		font-size: 12px;
		box-shadow: 0 -4px 12px rgba(0, 0, 0, 0.25);
	}
	.tools-panel-title {
		font-weight: 600;
		margin: 0 0 6px;
		color: var(--vscode-foreground);
	}
	.tools-list {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.tools-group-title {
		margin: 10px 0 2px;
		font-weight: 600;
		color: var(--vscode-descriptionForeground);
		letter-spacing: 0.2px;
		text-transform: uppercase;
		font-size: 11px;
	}
	.tools-group-title.is-first { margin-top: 0; }
	.tool-item {
		display: flex;
		gap: 8px;
		align-items: flex-start;
		cursor: pointer;
		user-select: none;
	}
	.tool-checkbox { margin-top: 2px; }
	.tool-text {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}
	.tool-name { color: var(--vscode-foreground); }
	.tool-desc {
		color: var(--vscode-descriptionForeground);
		font-size: 11px;
		line-height: 1.25;
	}

	/* ── Send / Stop icon button ────────────────────────────────── */

	.send-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 20px;
		height: 20px;
		padding: 0;
		border: none;
		border-radius: 4px;
		background: transparent;
		color: var(--vscode-foreground);
		cursor: pointer;
		flex: 0 0 auto;
	}
	.send-btn:hover:not(:disabled) {
		background: var(--vscode-toolbar-hoverBackground, rgba(90, 93, 94, 0.31));
	}
	.send-btn:disabled {
		opacity: 0.35;
		cursor: default;
	}
	.send-btn .icon-send { display: block; font-size: 14px; }
	.send-btn .icon-stop { display: none; font-size: 14px; }
	.send-btn.is-running .icon-send { display: none; }
	.send-btn.is-running .icon-stop { display: block; }
	.send-btn.is-running {
		background: transparent;
		color: var(--vscode-errorForeground, #f48771);
	}

	/* ── Model dropdown slot ────────────────────────────────────── */

	::slotted(.kusto-copilot-chat-model-dropdown) {
		max-width: 300px;
		min-width: 0;
		flex: 1 1 auto;
		overflow: hidden;
		margin-left: 10px;
	}
`;
