import { css } from 'lit';

export const styles = css`
	*,*::before,*::after{box-sizing:border-box}
	:host{display:contents}

	/* Modal backdrop — uses CSS vars for viewport-aware positioning in iframes */
	.sd-bg{position:fixed;top:var(--kw-modal-top, 0);left:0;right:0;height:var(--kw-modal-height, 100vh);background:rgba(0,0,0,.6);z-index:10000;display:flex;align-items:center;justify-content:center}

	/* Dialog box */
	.sd{background:var(--vscode-editor-background);border:1px solid var(--vscode-panel-border);border-radius:4px;width:520px;max-width:calc(100% - 24px);max-height:80%;display:flex;flex-direction:column;box-shadow:0 4px 20px rgba(0,0,0,.3)}
	.sd-h{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-bottom:1px solid var(--vscode-panel-border)}
	.sd-x{flex-shrink:0;width:28px;height:28px}
	.sd-b{padding:10px 12px;overflow:auto}
	.sd-f{display:flex;justify-content:flex-end;gap:8px;padding:10px 12px;border-top:1px solid var(--vscode-panel-border)}
	.sd-btn{padding:4px 12px;font-size:12px;font-family:inherit;border-radius:2px;cursor:pointer;border:1px solid var(--vscode-button-border,transparent);background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}.sd-btn:hover{background:var(--vscode-button-secondaryHoverBackground)}
	.sd-btn-danger{color:var(--vscode-errorForeground)}

	/* Close mini-button */
	.nb{width:22px;height:22px;padding:0;border:none;background:transparent;color:var(--vscode-foreground);cursor:pointer;display:flex;align-items:center;justify-content:center;border-radius:2px}.nb:hover:not(:disabled){background:var(--vscode-toolbar-hoverBackground)}.nb:disabled{opacity:.35;cursor:default}

	/* Shared select/input */
	.sr-col,.sr-dir{background:var(--vscode-dropdown-background);color:var(--vscode-dropdown-foreground);border:1px solid var(--vscode-dropdown-border);border-radius:0;padding:4px 6px;font-size:12px;font-family:inherit}
	select.sr-col:hover,select.sr-dir:hover{border-color:var(--vscode-focusBorder)}
	.sr-rm{padding:0;width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;background:transparent;border:1px solid transparent;border-radius:2px;color:var(--vscode-errorForeground);cursor:pointer}.sr-rm:hover{background:var(--vscode-button-secondaryHoverBackground);border-color:var(--vscode-input-border)}
	.sr-rm.is-hidden{visibility:hidden;pointer-events:none}
	.sr-rm-delete{color:var(--vscode-errorForeground)}

	/* Search within filter */
	.sc{position:relative;display:flex;align-items:center;flex:1;background:var(--vscode-input-background);border:1px solid var(--vscode-input-border);border-radius:2px}
	.sc:focus-within{border-color:var(--vscode-focusBorder)}
	.sc-icon{position:absolute;left:6px;top:50%;transform:translateY(-50%);pointer-events:none;color:var(--vscode-input-placeholderForeground);opacity:.7;flex-shrink:0}
	.sinp{flex:1;padding:4px 8px 4px 26px;font-size:12px;font-family:inherit;background:transparent;color:var(--vscode-input-foreground);border:none;outline:none;min-width:0}.sinp::placeholder{color:var(--vscode-input-placeholderForeground)}

	/* Filter-specific overrides */
	.fd{width:min(900px,calc(100vw - 24px));min-width:0;max-width:calc(100vw - 24px);max-height:calc(100vh - 24px)}
	.fd .sd-b{padding:8px;max-height:calc(100vh - 210px)}
	.fd-modes{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--vscode-panel-border);flex-wrap:wrap}
	.fd-mode{padding:4px 10px;font-size:12px;border:1px solid var(--vscode-input-border);background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border-radius:999px;cursor:pointer}
	.fd-mode.active{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border-color:var(--vscode-button-background)}
	.fd-combine{margin-left:auto;font-size:12px;color:var(--vscode-descriptionForeground);display:flex;align-items:center;gap:8px;line-height:1.2}
	.fd-combine-cb{margin:0;inline-size:14px;block-size:14px;flex:0 0 14px}
	.fd-tools{display:flex;gap:8px;align-items:center;margin-bottom:8px;flex-wrap:wrap}
	.fd-search{flex:1}
	.fd-actions{display:flex;gap:6px;flex-wrap:wrap}
	.fd-list{max-height:min(60vh,640px);overflow:auto;border:1px solid var(--vscode-panel-border);border-radius:4px}
	.fd-item{display:grid;grid-template-columns:18px 1fr auto;gap:8px;align-items:center;padding:6px 8px;border-bottom:1px solid var(--vscode-panel-border)}
	.fd-item:last-child{border-bottom:none}
	.fd-item:hover{background:var(--vscode-list-hoverBackground)}
	.fd-item-text{overflow:visible;white-space:normal;word-break:break-word;line-height:1.35}
	.fd-item-count{font-size:11px;color:var(--vscode-descriptionForeground)}
	.fd-empty{padding:10px;font-size:12px;color:var(--vscode-descriptionForeground)}

	/* Rules */
	.fr-head{display:flex;gap:8px;align-items:center;justify-content:space-between;margin-bottom:8px;flex-wrap:wrap}
	.fr-type-group{display:flex;align-items:center;gap:8px;min-width:0}
	.fr-type-label{font-size:12px;color:var(--vscode-descriptionForeground);white-space:nowrap}
	.fr-type-select{min-width:120px}
	.fr-list{display:flex;flex-direction:column;gap:8px;max-height:min(60vh,640px);overflow:auto;padding-right:2px;padding-left:34px}
	.fr-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
	.fr-add-inline{margin-left:auto;flex:0 0 28px;width:28px;height:28px;padding:0;border:1px solid transparent;border-radius:2px;background:transparent;color:var(--vscode-terminal-ansiGreen);display:inline-flex;align-items:center;justify-content:center;cursor:pointer}
	.fr-add-inline:hover{background:var(--vscode-button-secondaryHoverBackground);border-color:var(--vscode-input-border)}
	.fr-add-inline:disabled{opacity:.35;cursor:default}
	.fr-rule-op{flex:0 0 200px;min-width:200px}
	.fr-row > .sr-rm{flex:0 0 28px}
	.fr-row > .sr-col,.fr-row > .sr-dir{flex:1 1 160px;min-width:120px}
	.fr-row > .sr-col,.fr-row > .sr-dir,.fr-row > input.sr-col{height:28px}
	.fr-row > select.fr-join-select.sr-dir{flex:0 0 auto;width:auto;min-width:0}
	@media (max-width: 640px){
		.fd-combine{margin-left:0;flex-basis:100%}
		.fd .sd-b{max-height:calc(100vh - 240px)}
		.fr-head{align-items:flex-start}
		.fr-list{padding-left:0}
	}
`;
