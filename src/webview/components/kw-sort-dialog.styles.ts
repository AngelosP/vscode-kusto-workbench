import { css } from 'lit';

export const styles = css`
	*,*::before,*::after{box-sizing:border-box}
	:host{display:contents}

	/* Modal backdrop — uses CSS vars for viewport-aware positioning in iframes */
	.sd-bg{position:fixed;top:var(--kw-modal-top, 0);left:0;right:0;height:var(--kw-modal-height, 100vh);background:rgba(0,0,0,.6);z-index:10000;display:flex;align-items:center;justify-content:center}
	.sd{background:var(--vscode-editor-background);border:1px solid var(--vscode-panel-border);border-radius:4px;width:520px;max-width:calc(100% - 24px);max-height:80%;display:flex;flex-direction:column;box-shadow:0 4px 20px rgba(0,0,0,.3)}
	.sd-h{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-bottom:1px solid var(--vscode-panel-border)}
	.sd-x{flex-shrink:0;width:28px;height:28px}
	.sd-b{padding:10px 12px;overflow:auto;overscroll-behavior:contain}
	.sd-f{display:flex;justify-content:flex-end;gap:8px;padding:10px 12px;border-top:1px solid var(--vscode-panel-border)}
	.sd-btn{padding:4px 12px;font-size:12px;font-family:inherit;border-radius:2px;cursor:pointer;border:1px solid var(--vscode-button-border,transparent);background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}.sd-btn:hover{background:var(--vscode-button-secondaryHoverBackground)}
	.sd-btn-danger{color:var(--vscode-errorForeground)}
	.sd-e{font-size:12px;color:var(--vscode-descriptionForeground);padding:6px 2px}
	.nb{width:22px;height:22px;padding:0;border:none;background:transparent;color:var(--vscode-foreground);cursor:pointer;display:flex;align-items:center;justify-content:center;border-radius:2px}.nb:hover:not(:disabled){background:var(--vscode-toolbar-hoverBackground)}.nb:disabled{opacity:.35;cursor:default}
	.sr{display:grid;grid-template-columns:26px 28px 1fr 140px;gap:8px;align-items:center;padding:6px 4px;border-radius:4px}
	.sr:hover{background:var(--vscode-list-hoverBackground)}
	.sr-ord{text-align:right;font-size:11px;color:var(--vscode-descriptionForeground)}
	.sr-rm{padding:0;width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;background:transparent;border:1px solid transparent;border-radius:2px;color:var(--vscode-errorForeground);cursor:pointer}.sr-rm:hover{background:var(--vscode-button-secondaryHoverBackground);border-color:var(--vscode-input-border)}
	.sr-col,.sr-dir{background:var(--vscode-dropdown-background);color:var(--vscode-dropdown-foreground);border:1px solid var(--vscode-dropdown-border);border-radius:0;padding:4px 6px;font-size:12px;font-family:inherit}
	.sr-add{display:grid;grid-template-columns:1fr 1fr 140px 32px;gap:8px;align-items:center;padding:8px 4px 4px;border-top:1px solid var(--vscode-panel-border);margin-top:6px}
	.sr-add-label{font-size:11px;color:var(--vscode-descriptionForeground)}
	.sr-add-btn{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border:1px solid var(--vscode-button-border,transparent);border-radius:4px;width:32px;height:28px;cursor:pointer;font-size:16px;line-height:1;padding:0}.sr-add-btn:hover{background:var(--vscode-button-secondaryHoverBackground)}
`;
