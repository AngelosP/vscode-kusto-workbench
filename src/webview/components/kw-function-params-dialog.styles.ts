import { css } from 'lit';

export const styles = css`
	*,*::before,*::after{box-sizing:border-box}
	:host{display:contents}

	.sd-bg{position:fixed;top:var(--kw-modal-top, 0);left:0;right:0;height:var(--kw-modal-height, 100vh);background:rgba(0,0,0,.6);z-index:10000;display:flex;align-items:center;justify-content:center}
	.sd{background:var(--vscode-editor-background);border:1px solid var(--vscode-panel-border);border-radius:4px;width:440px;max-width:calc(100% - 24px);max-height:80%;display:flex;flex-direction:column;box-shadow:0 4px 20px rgba(0,0,0,.3)}
	.sd-h{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-bottom:1px solid var(--vscode-panel-border)}
	.sd-h strong{font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
	.sd-x{flex-shrink:0;width:28px;height:28px}
	.sd-b{padding:10px 12px;overflow:auto}
	.sd-f{display:flex;justify-content:flex-end;gap:8px;padding:10px 12px;border-top:1px solid var(--vscode-panel-border)}
	.sd-btn{padding:4px 12px;font-size:12px;font-family:inherit;border-radius:2px;cursor:pointer;border:1px solid var(--vscode-button-border,transparent);background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}.sd-btn:hover{background:var(--vscode-button-secondaryHoverBackground)}
	.sd-btn-primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}.sd-btn-primary:hover{background:var(--vscode-button-hoverBackground)}
	.nb{width:22px;height:22px;padding:0;border:none;background:transparent;color:var(--vscode-foreground);cursor:pointer;display:flex;align-items:center;justify-content:center;border-radius:2px}.nb:hover:not(:disabled){background:var(--vscode-toolbar-hoverBackground)}.nb:disabled{opacity:.35;cursor:default}

	.fpd-row{padding:6px 0}
	.fpd-label{display:flex;align-items:baseline;gap:6px;margin-bottom:4px}
	.fpd-name{font-size:12px;font-weight:600;color:var(--vscode-foreground)}
	.fpd-type{font-size:11px;color:var(--vscode-descriptionForeground)}
	.fpd-default{font-size:11px;color:var(--vscode-descriptionForeground);font-style:italic}
	.fpd-input{width:100%;padding:4px 6px;font-size:12px;font-family:var(--vscode-editor-font-family, 'Consolas', monospace);background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:2px;outline:none}.fpd-input:focus{border-color:var(--vscode-focusBorder)}
	.fpd-input::placeholder{color:var(--vscode-input-placeholderForeground)}
`;
