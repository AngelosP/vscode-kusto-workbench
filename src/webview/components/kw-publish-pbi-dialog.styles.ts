import { css } from 'lit';

export const styles = css`
	*,*::before,*::after{box-sizing:border-box}
	:host{display:contents}

	.sd-bg{position:fixed;top:var(--kw-modal-top, 0);left:0;right:0;height:var(--kw-modal-height, 100vh);background:rgba(0,0,0,.6);z-index:10000;display:flex;align-items:center;justify-content:center}
	.sd{background:var(--vscode-editor-background);border:1px solid var(--vscode-panel-border);border-radius:6px;width:480px;max-width:calc(100% - 24px);max-height:80%;display:flex;flex-direction:column;box-shadow:0 8px 32px rgba(0,0,0,.4);overflow:hidden}
	.sd-h{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;background:linear-gradient(135deg, rgba(246,190,0,.08) 0%, rgba(246,190,0,.02) 100%);border-bottom:1px solid var(--vscode-panel-border)}
	.sd-h-title{display:flex;align-items:center;gap:8px;overflow:hidden}
	.sd-h-title strong{font-size:14px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
	.sd-h-icon{width:20px;height:20px;flex-shrink:0;color:#f2c811}
	.sd-x{flex-shrink:0;width:28px;height:28px}
	.sd-b{padding:16px;overflow:auto}
	.sd-f{display:flex;justify-content:flex-end;gap:8px;padding:12px 16px;border-top:1px solid var(--vscode-panel-border);background:var(--vscode-sideBar-background, var(--vscode-editor-background))}
	.sd-btn{padding:6px 16px;font-size:12px;font-family:inherit;border-radius:4px;cursor:pointer;border:1px solid var(--vscode-button-border,transparent);background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);transition:background .15s}.sd-btn:hover:not(:disabled){background:var(--vscode-button-secondaryHoverBackground)}
	.sd-btn-primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}.sd-btn-primary:hover:not(:disabled){background:var(--vscode-button-hoverBackground)}
	.sd-btn:disabled{opacity:.5;cursor:default}
	.nb{width:22px;height:22px;padding:0;border:none;background:transparent;color:var(--vscode-foreground);cursor:pointer;display:flex;align-items:center;justify-content:center;border-radius:2px}.nb:hover:not(:disabled){background:var(--vscode-toolbar-hoverBackground)}.nb:disabled{opacity:.35;cursor:default}

	/* ── Sections ── */
	.ppd-section{margin-bottom:14px}
	.ppd-section:last-child{margin-bottom:0}
	.ppd-section-label{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--vscode-descriptionForeground);margin-bottom:8px}

	.ppd-row{padding:4px 0}
	.ppd-label{display:block;font-size:12px;font-weight:500;color:var(--vscode-foreground);margin-bottom:6px}
	.ppd-input{width:100%;padding:6px 8px;font-size:12px;font-family:inherit;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:4px;outline:none;transition:border-color .15s}.ppd-input:focus{border-color:var(--vscode-focusBorder)}
	.ppd-input::placeholder{color:var(--vscode-input-placeholderForeground)}
	.ppd-select{width:100%;padding:6px 8px;font-size:12px;font-family:inherit;background:var(--vscode-dropdown-background);color:var(--vscode-dropdown-foreground);border:1px solid var(--vscode-dropdown-border);border-radius:4px;outline:none}.ppd-select:focus{border-color:var(--vscode-focusBorder)}
	.ppd-combo{position:relative}
	.ppd-combo-list{position:absolute;top:100%;left:0;right:0;margin:2px 0 0;padding:4px 0;list-style:none;background:var(--vscode-dropdown-background);border:1px solid var(--vscode-dropdown-border);border-radius:4px;box-shadow:0 4px 12px rgba(0,0,0,.35);max-height:160px;overflow-y:auto;z-index:1}
	.ppd-combo-item{padding:5px 10px;font-size:12px;cursor:pointer;color:var(--vscode-dropdown-foreground);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border-radius:2px;margin:0 4px}
	.ppd-combo-item:hover{background:var(--vscode-list-hoverBackground)}
	.ppd-combo-item.is-selected{background:var(--vscode-list-activeSelectionBackground);color:var(--vscode-list-activeSelectionForeground)}
	.ppd-dims{display:flex;gap:10px}
	.ppd-dims .ppd-row{flex:1}

	/* ── Status ── */
	.ppd-status{display:flex;align-items:center;gap:8px;padding:12px 16px;font-size:12px;border-top:1px solid var(--vscode-panel-border)}
	.ppd-status-error{color:var(--vscode-errorForeground)}
	.ppd-status-success{padding:16px;margin:0 16px 12px;border-radius:6px;background:rgba(115,201,145,.08);border:1px solid rgba(115,201,145,.2)}
	.ppd-success-main{display:flex;align-items:center;gap:10px;font-size:14px;font-weight:600;color:var(--vscode-testing-iconPassed, #73c991)}
	.ppd-success-check{width:20px;height:20px;flex-shrink:0}
	.ppd-success-link{display:inline-flex;align-items:center;gap:4px;margin-top:10px;padding:5px 12px;font-size:12px;border-radius:4px;background:var(--vscode-button-secondaryBackground);color:var(--vscode-textLink-foreground);text-decoration:none;border:1px solid var(--vscode-button-border,transparent);cursor:pointer;transition:background .15s}
	.ppd-success-link:hover{background:var(--vscode-button-secondaryHoverBackground);text-decoration:none}
	.ppd-success-link a{color:inherit;text-decoration:none}
	.ppd-success-divider{width:100%;height:1px;background:rgba(115,201,145,.15);margin:10px 0}
	.ppd-success-schedule{font-size:11px;color:var(--vscode-descriptionForeground);display:flex;align-items:center;gap:6px}
	.ppd-spinner{display:inline-block;width:14px;height:14px;border:2px solid var(--vscode-foreground);border-top-color:transparent;border-radius:50%;animation:ppd-spin .8s linear infinite;flex-shrink:0;vertical-align:middle}
	@keyframes ppd-spin{to{transform:rotate(360deg)}}

	/* ── Validation (hidden for now) ── */
	.ppd-validation{padding:8px 12px;border-top:1px solid var(--vscode-panel-border);background:var(--vscode-inputValidation-warningBackground, rgba(255,204,0,0.08))}
	.ppd-validation-header{font-size:12px;font-weight:600;color:var(--vscode-editorWarning-foreground, #cca700);margin-bottom:4px}
	.ppd-validation-item{font-size:11px;color:var(--vscode-foreground);padding:2px 0;padding-left:12px;position:relative}.ppd-validation-item::before{content:'•';position:absolute;left:2px}
	.ppd-validation-hint{font-size:11px;color:var(--vscode-descriptionForeground);margin-top:6px;line-height:1.4;font-style:italic}

	/* ── Publish mode toggle ── */
	.ppd-toggle-group{display:flex;gap:0;border-radius:4px;overflow:hidden;border:1px solid var(--vscode-input-border);margin-bottom:8px}
	.ppd-toggle-btn{flex:1;padding:6px 12px;font-size:12px;font-family:inherit;border:none;cursor:pointer;background:var(--vscode-input-background);color:var(--vscode-foreground);transition:background .15s,color .15s}
	.ppd-toggle-btn:not(:last-child){border-right:1px solid var(--vscode-input-border)}
	.ppd-toggle-btn:hover:not(.is-active){background:var(--vscode-list-hoverBackground)}
	.ppd-toggle-btn.is-active{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
	.ppd-info-note{font-size:11px;color:var(--vscode-descriptionForeground);line-height:1.4;padding:6px 8px;border-radius:3px;background:var(--vscode-inputValidation-infoBackground, rgba(0,122,204,0.08));border:1px solid var(--vscode-inputValidation-infoBorder, rgba(0,122,204,0.2));margin-top:6px}
`;
