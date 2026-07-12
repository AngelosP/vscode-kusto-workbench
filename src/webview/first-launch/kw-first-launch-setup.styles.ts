import { css } from 'lit';

export const firstLaunchSetupStyles = css`
	:host {
		display: block;
		min-height: 100vh;
		color: var(--vscode-foreground);
		background:
			linear-gradient(180deg, color-mix(in srgb, var(--vscode-focusBorder) 7%, transparent), transparent 260px),
			var(--vscode-editor-background);
		font-family: var(--vscode-font-family);
		font-size: var(--vscode-font-size);
		letter-spacing: 0;
	}

	main {
		width: min(820px, calc(100% - 48px));
		margin: 0 auto;
		padding: 56px 0 104px;
		animation: enter 180ms ease-out both;
	}

	header {
		display: grid;
		grid-template-columns: 44px minmax(0, 1fr);
		gap: 16px;
		align-items: center;
		margin-bottom: 34px;
	}

	.brand-mark {
		display: grid;
		place-items: center;
		width: 42px;
		height: 42px;
		color: var(--vscode-button-foreground);
		background: var(--vscode-button-background);
		border-radius: 6px;
	}

	.brand-mark img {
		display: block;
		width: 28px;
		height: 28px;
		object-fit: contain;
	}

	h1 {
		margin: 0 0 4px;
		font-size: 24px;
		font-weight: 650;
		line-height: 1.2;
		letter-spacing: 0;
	}

	.intro {
		margin: 0;
		color: var(--vscode-descriptionForeground);
		line-height: 1.5;
	}

	fieldset {
		min-width: 0;
		margin: 0 0 30px;
		padding: 0;
		border: 0;
	}

	legend {
		width: 100%;
		padding: 0 0 9px;
		border-bottom: 1px solid var(--vscode-widget-border);
		font-size: 15px;
		font-weight: 650;
		letter-spacing: 0;
	}

	.section-description {
		margin: 9px 0 3px;
		color: var(--vscode-descriptionForeground);
		line-height: 1.45;
	}

	.toolbar-guidance { margin-top: 6px; }

	.option-row {
		display: grid;
		grid-template-columns: 24px minmax(0, 1fr) auto;
		gap: 12px;
		align-items: start;
		padding: 15px 4px;
		border-bottom: 1px solid color-mix(in srgb, var(--vscode-widget-border) 72%, transparent);
		cursor: pointer;
	}

	.option-row:hover { background: var(--vscode-list-hoverBackground); }

	.option-icon {
		display: grid;
		place-items: center;
		width: 22px;
		height: 22px;
		margin-top: 1px;
		color: var(--vscode-symbolIcon-functionForeground, var(--vscode-foreground));
	}

	.option-icon svg { width: 18px; height: 18px; }

	.option-copy { min-width: 0; }

	.option-title {
		display: flex;
		flex-wrap: wrap;
		gap: 7px;
		align-items: baseline;
		font-weight: 600;
		line-height: 1.35;
	}

	.option-description {
		display: block;
		margin-top: 4px;
		color: var(--vscode-descriptionForeground);
		font-size: 12px;
		line-height: 1.48;
	}

	.extension,
	kbd {
		border: 1px solid var(--vscode-widget-border);
		border-radius: 3px;
		background: var(--vscode-textCodeBlock-background);
		font-family: var(--vscode-editor-font-family);
		font-size: 11px;
		font-weight: 500;
		line-height: 1.4;
	}

	.extension { padding: 1px 5px; }
	kbd { padding: 1px 6px; white-space: nowrap; }

	input[type='checkbox'] {
		width: 17px;
		height: 17px;
		margin: 2px 2px 0 0;
		accent-color: var(--vscode-focusBorder);
	}

	.always-supported {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		padding: 13px 4px 0;
		color: var(--vscode-descriptionForeground);
		font-size: 12px;
	}

	.notice {
		margin: 12px 0 0;
		padding: 10px 12px;
		border-left: 2px solid var(--vscode-editorWarning-foreground);
		background: var(--vscode-textBlockQuote-background);
		color: var(--vscode-descriptionForeground);
		line-height: 1.45;
	}

	.error {
		margin: 0 0 16px;
		padding: 10px 12px;
		border-left: 2px solid var(--vscode-errorForeground);
		background: var(--vscode-inputValidation-errorBackground);
		color: var(--vscode-errorForeground);
		line-height: 1.45;
	}

	footer {
		position: fixed;
		z-index: 5;
		left: max(24px, calc((100vw - 820px) / 2));
		right: max(24px, calc((100vw - 820px) / 2));
		bottom: 0;
		display: flex;
		justify-content: flex-end;
		gap: 10px;
		padding: 14px 0 12px;
		border-top: 1px solid var(--vscode-widget-border);
		background: var(--vscode-editor-background);
		box-shadow: 0 -10px 20px color-mix(in srgb, var(--vscode-editor-background) 88%, transparent);
	}

	button {
		min-height: 32px;
		padding: 6px 14px;
		border: 1px solid transparent;
		border-radius: 3px;
		font: inherit;
		letter-spacing: 0;
		cursor: pointer;
	}

	button.primary {
		background: var(--vscode-button-background);
		color: var(--vscode-button-foreground);
	}

	button.primary:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }

	button.secondary {
		border-color: var(--vscode-button-secondaryBackground);
		background: var(--vscode-button-secondaryBackground);
		color: var(--vscode-button-secondaryForeground);
	}

	button.secondary:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
	button:disabled, input:disabled { cursor: default; opacity: 0.65; }
	button:focus-visible, input:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }

	.loading {
		display: grid;
		place-items: center;
		min-height: 70vh;
		color: var(--vscode-descriptionForeground);
	}

	@keyframes enter {
		from { opacity: 0; }
		to { opacity: 1; }
	}

	@media (max-width: 560px) {
		main { width: min(100% - 28px, 820px); padding: 30px 0 130px; }
		header { grid-template-columns: 36px minmax(0, 1fr); gap: 12px; }
		.brand-mark { width: 34px; height: 34px; }
		.brand-mark img { width: 23px; height: 23px; }
		h1 { font-size: 20px; }
		.option-row { grid-template-columns: 22px minmax(0, 1fr) auto; gap: 9px; }
		footer { left: 14px; right: 14px; flex-direction: column-reverse; }
		button { width: 100%; }
	}

	@media (prefers-reduced-motion: reduce) {
		main { animation: none; }
	}

	@media (forced-colors: active) {
		.brand-mark, .notice, .error, .option-row, footer { border: 1px solid CanvasText; }
	}
`;