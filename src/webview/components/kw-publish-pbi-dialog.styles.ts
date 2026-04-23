import { css } from 'lit';

export const styles = css`
	*,*::before,*::after{box-sizing:border-box}
	:host{display:contents}

	.sd-bg{position:fixed;top:var(--kw-modal-top, 0);left:0;right:0;height:var(--kw-modal-height, 100vh);background:rgba(0,0,0,.6);z-index:10000;display:flex;align-items:center;justify-content:center}
	.sd{background:var(--vscode-editor-background);border:1px solid var(--vscode-panel-border);border-radius:4px;width:480px;max-width:calc(100% - 24px);max-height:80%;display:flex;flex-direction:column;box-shadow:0 4px 20px rgba(0,0,0,.3)}
	.sd-h{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-bottom:1px solid var(--vscode-panel-border)}
	.sd-h strong{font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
	.sd-x{flex-shrink:0;width:28px;height:28px}
	.sd-b{padding:10px 12px;overflow:auto}
	.sd-f{display:flex;justify-content:flex-end;gap:8px;padding:10px 12px;border-top:1px solid var(--vscode-panel-border)}
	.sd-btn{padding:4px 12px;font-size:12px;font-family:inherit;border-radius:2px;cursor:pointer;border:1px solid var(--vscode-button-border,transparent);background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}.sd-btn:hover{background:var(--vscode-button-secondaryHoverBackground)}
	.sd-btn-primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}.sd-btn-primary:hover{background:var(--vscode-button-hoverBackground)}
	.sd-btn:disabled{opacity:.5;cursor:default}
	.nb{width:22px;height:22px;padding:0;border:none;background:transparent;color:var(--vscode-foreground);cursor:pointer;display:flex;align-items:center;justify-content:center;border-radius:2px}.nb:hover:not(:disabled){background:var(--vscode-toolbar-hoverBackground)}.nb:disabled{opacity:.35;cursor:default}

	.ppd-row{padding:6px 0}
	.ppd-label{display:block;font-size:12px;font-weight:600;color:var(--vscode-foreground);margin-bottom:6px}
	.ppd-input{width:100%;padding:4px 6px;font-size:12px;font-family:inherit;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:2px;outline:none}.ppd-input:focus{border-color:var(--vscode-focusBorder)}
	.ppd-input::placeholder{color:var(--vscode-input-placeholderForeground)}
	.ppd-select{width:100%;padding:4px 6px;font-size:12px;font-family:inherit;background:var(--vscode-dropdown-background);color:var(--vscode-dropdown-foreground);border:1px solid var(--vscode-dropdown-border);border-radius:2px;outline:none}.ppd-select:focus{border-color:var(--vscode-focusBorder)}
	.ppd-combo{position:relative}
	.ppd-combo-list{position:absolute;top:100%;left:0;right:0;margin:2px 0 0;padding:4px 0;list-style:none;background:var(--vscode-dropdown-background);border:1px solid var(--vscode-dropdown-border);border-radius:2px;box-shadow:0 2px 8px rgba(0,0,0,.3);max-height:160px;overflow-y:auto;z-index:1}
	.ppd-combo-item{padding:4px 8px;font-size:12px;cursor:pointer;color:var(--vscode-dropdown-foreground);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
	.ppd-combo-item:hover{background:var(--vscode-list-hoverBackground)}
	.ppd-combo-item.is-selected{background:var(--vscode-list-activeSelectionBackground);color:var(--vscode-list-activeSelectionForeground)}
	.ppd-dims{display:flex;gap:8px}
	.ppd-dims .ppd-row{flex:1}

	.ppd-status{display:flex;align-items:center;padding:8px 12px;font-size:12px;border-top:1px solid var(--vscode-panel-border)}
	.ppd-status-error{color:var(--vscode-errorForeground)}
	.ppd-status-success{color:var(--vscode-testing-iconPassed, #73c991)}
	.ppd-status a{color:var(--vscode-textLink-foreground);text-decoration:none}.ppd-status a:hover{text-decoration:underline}
	.ppd-spinner{display:inline-block;width:14px;height:14px;border:2px solid var(--vscode-foreground);border-top-color:transparent;border-radius:50%;animation:ppd-spin .8s linear infinite;vertical-align:middle;margin-right:6px}
	@keyframes ppd-spin{to{transform:rotate(360deg)}}

	.ppd-validation{padding:8px 12px;border-top:1px solid var(--vscode-panel-border);background:var(--vscode-inputValidation-warningBackground, rgba(255,204,0,0.08))}
	.ppd-validation-header{font-size:12px;font-weight:600;color:var(--vscode-editorWarning-foreground, #cca700);margin-bottom:4px}
	.ppd-validation-item{font-size:11px;color:var(--vscode-foreground);padding:2px 0;padding-left:12px;position:relative}.ppd-validation-item::before{content:'•';position:absolute;left:2px}
	.ppd-validation-hint{font-size:11px;color:var(--vscode-descriptionForeground);margin-top:6px;line-height:1.4;font-style:italic}
`;
