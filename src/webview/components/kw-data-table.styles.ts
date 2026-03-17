import { css } from 'lit';

export const styles = css`
		*,*::before,*::after{box-sizing:border-box}
		:host{display:block;min-height:60px;position:relative}
		.dt{display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden;border-top:1px solid var(--vscode-panel-border)}
		.dt.no-top-border{border-top:none}

		/* Header bar */
		.hbar{display:flex;align-items:center;justify-content:space-between;padding:4px 0 8px 0;font-size:12px;color:var(--vscode-descriptionForeground);background:var(--vscode-editor-background);flex-shrink:0;gap:8px;border-top:none;border-bottom:none;margin:0}
		.hinfo{display:flex;align-items:center;gap:6px;flex-shrink:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:-4px}.et{opacity:.7}
		.tb{display:flex;gap:2px;align-items:center;flex-shrink:0}
		.sep{width:1px;height:16px;background:var(--vscode-input-border, rgba(128,128,128,0.3));margin:0 2px}
		.tbtn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;min-width:28px;padding:0;font-size:11px;border:1px solid transparent;background:transparent;color:var(--vscode-foreground);border-radius:4px;cursor:pointer;font-family:inherit;line-height:0}
		.tbtn:hover{background:var(--vscode-list-hoverBackground);color:var(--vscode-foreground)}.tbtn.act{color:var(--vscode-foreground);background:var(--vscode-toolbar-activeBackground, var(--vscode-actionBar-toggledBackground, rgba(128, 128, 128, 0.25)))}.tbtn svg{stroke:currentColor;fill:none;display:block}
		.tbtn.vis-toggle{width:28px;height:28px;padding:0;justify-content:center;border-radius:4px}
		.tbtn.tbtn-text{width:auto;min-width:auto;padding:0 8px;gap:4px;line-height:1.4}
		.hidden-hint{font-size:11px;color:var(--vscode-disabledForeground,var(--vscode-descriptionForeground));font-style:italic;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;flex-shrink:999}
		.hidden-hint:hover{color:var(--vscode-foreground);text-decoration:underline}

		/* Search bar */
		.sbar{display:flex;align-items:center;gap:6px;padding:4px 0;font-size:12px;background:var(--vscode-editor-background);flex-shrink:0}
		.sc{position:relative;display:flex;align-items:center;flex:1;background:var(--vscode-input-background);border:1px solid var(--vscode-input-border);border-radius:2px}
		.sc:focus-within{border-color:var(--vscode-focusBorder)}
		.sc-icon{position:absolute;left:6px;top:50%;transform:translateY(-50%);pointer-events:none;color:var(--vscode-input-placeholderForeground);opacity:.7;flex-shrink:0}
		.sinp{flex:1;padding:4px 8px 4px 26px;font-size:12px;font-family:inherit;background:transparent;color:var(--vscode-input-foreground);border:none;outline:none;min-width:0}.sinp::placeholder{color:var(--vscode-input-placeholderForeground)}
		.sc-status{font-size:11px;color:var(--vscode-descriptionForeground);white-space:nowrap;padding:0 4px;flex-shrink:0;pointer-events:none}
		.sc-status.err{color:var(--vscode-errorForeground)}
		.close-mini{width:22px;height:22px;padding:0;border:1px solid transparent;background:transparent;color:var(--vscode-foreground);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;border-radius:4px;flex-shrink:0}.close-mini:hover:not(:disabled){background:var(--vscode-list-hoverBackground)}.close-mini:disabled{opacity:.35;cursor:default}
		.cj-close{align-self:flex-start;margin-top:2px}

		/* Column jump — searchable dropdown */
		.cj-wrap{flex:1;position:relative;display:flex;flex-direction:column;background:var(--vscode-input-background);border:1px solid var(--vscode-input-border);border-radius:2px}
		.cj-wrap:focus-within{border-color:var(--vscode-focusBorder)}
		.cj-inp{padding:4px 8px;font-size:12px;font-family:inherit;background:transparent;color:var(--vscode-input-foreground);border:none;outline:none}.cj-inp::placeholder{color:var(--vscode-input-placeholderForeground)}
		.cj-list{max-height:150px;overflow-y:auto;border-top:1px solid var(--vscode-panel-border)}
		.cj-item{padding:4px 8px;font-size:12px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;outline:none}.cj-item:hover,.cj-item:focus{background:var(--vscode-list-hoverBackground)}
		.cj-empty{padding:4px 8px;font-size:11px;color:var(--vscode-descriptionForeground);opacity:.7}

		/* Scroll container — the focus outline is on .dt instead */
		.vscroll{flex:1 1 0;overflow:auto;min-height:0;overflow-anchor:none;border:none;border-radius:0}
		.vscroll:focus{outline:none}

		/* Single data table matching original resultsTable.js styles */
		.dtable{border-collapse:collapse;font-size:12px;user-select:none;table-layout:fixed}
		.dtable-head-wrap{position:sticky;top:0;z-index:4;overflow:visible;border:none;border-radius:0}
		th,td{text-align:left;padding:6px 8px;border-right:1px solid var(--vscode-panel-border);border-bottom:1px solid var(--vscode-panel-border);white-space:nowrap;position:relative;max-width:75ch;overflow:hidden;text-overflow:ellipsis}
		.dtable th:first-child,.dtable td:first-child{border-left:1px solid var(--vscode-panel-border)}
		.dtable thead th{border-top:1px solid var(--vscode-panel-border)}
		th,td{height:27px}
		td{background:var(--vscode-editor-background)}
		th{font-weight:600;background:var(--vscode-list-hoverBackground);cursor:pointer;user-select:none}
		th:hover{background:var(--vscode-list-activeSelectionBackground,var(--vscode-list-hoverBackground))}th.sorted{font-weight:700}
		.thc{display:flex;align-items:center;gap:4px;flex-wrap:nowrap}.thn{display:flex;align-items:center;gap:0;flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;min-width:0;white-space:nowrap}
		.filtered-link{font-size:11px;color:var(--vscode-textLink-foreground);text-decoration:underline;cursor:pointer;flex-shrink:0;margin-left:5px}
		.filtered-link:hover{color:var(--vscode-textLink-activeForeground)}
		.si2{font-size:11px;opacity:.85;flex-shrink:0;line-height:1;margin-left:3px}.si2 sup{font-size:8px;margin-left:2px}
		.cm-btn{width:20px;height:20px;padding:0;border:none;background:transparent;color:var(--vscode-foreground);cursor:pointer;opacity:.5;display:flex;align-items:center;justify-content:center;border-radius:2px;font-size:11px;flex-shrink:0}
		.cm-btn:hover{opacity:1;background:var(--vscode-toolbar-hoverBackground)}

		/* Row number column: sticky left with double right border (matches original) */
		.rn-h{width:40px;min-width:40px;max-width:40px;text-align:center;padding:6px 2px;cursor:default;position:sticky;left:0;z-index:3;background:var(--vscode-list-hoverBackground);border-right:2px solid var(--vscode-panel-border)}
		.rn{width:40px;min-width:40px;max-width:40px;text-align:center;font-size:12px;opacity:.5;padding:6px 2px;cursor:pointer;position:sticky;left:0;z-index:1;background:var(--vscode-editor-background);border-right:2px solid var(--vscode-panel-border)}
		.rn:hover{background:var(--vscode-list-hoverBackground);opacity:.8}

		/* Object View button */
		.obj-link{color:var(--vscode-textLink-foreground);text-decoration:none;font-size:11px;cursor:pointer}.obj-link:hover{text-decoration:underline;color:var(--vscode-textLink-activeForeground,var(--vscode-textLink-foreground))}
		.obj-cell{text-align:left}

		/* Column menu */
		.cm{position:fixed;z-index:10000;background:var(--vscode-menu-background,var(--vscode-editor-background));border:1px solid var(--vscode-menu-border,var(--vscode-panel-border));border-radius:0;padding:4px 0;min-width:160px;box-shadow:0 4px 12px rgba(0,0,0,.3);transform:translateX(-100%)}
		.cmi{padding:4px 12px;font-size:12px;cursor:pointer;white-space:nowrap}.cmi:hover{background:var(--vscode-menu-selectionBackground,var(--vscode-list-hoverBackground))}
		.cms{height:1px;background:var(--vscode-menu-separatorBackground,var(--vscode-panel-border));margin:4px 0}

		/* Spacer rows */
		.vspacer td{padding:0;border:0;border-right:0;line-height:0;font-size:0;background:transparent}

		/* Selection (matching original exactly) */
		.sel-row td{background:var(--vscode-list-inactiveSelectionBackground)}
		.sel-row .rn{background:var(--vscode-list-activeSelectionBackground);color:var(--vscode-list-activeSelectionForeground);opacity:1}
		.cr{background:var(--vscode-list-activeSelectionBackground)!important;color:var(--vscode-list-activeSelectionForeground)}
		.cf{background:var(--vscode-list-activeSelectionBackground)!important;color:var(--vscode-list-activeSelectionForeground);outline:2px solid var(--vscode-focusBorder);outline-offset:-2px}
		.mh{background:var(--vscode-list-filterMatchHighlightBackground, rgba(234, 92, 0, 0.3))!important}
		.mc{background:var(--vscode-editor-findMatchBackground)!important;outline:2px solid var(--vscode-list-filterMatchHighlightBorder, var(--vscode-editor-findMatchBorder))}
		mark.hl,mark.hl-cur{all:unset;color:var(--vscode-list-highlightForeground);font-weight:600;border-radius:1px}
		mark.hl-cur{background:var(--vscode-editor-findMatchBackground);outline:2px solid var(--vscode-list-filterMatchHighlightBorder, var(--vscode-editor-findMatchBorder))}

		.empty,.empty-body,.hidden-msg{padding:16px;text-align:center;opacity:.7;font-size:12px}

		/* Compact mode overrides */
		.compact th,.compact td{padding:4px 6px;font-size:11px;height:21px}.compact .hbar{padding:7px 0;font-size:11px}
		.compact .rn{font-size:10px;width:32px;min-width:32px;max-width:32px;padding:4px 2px}.compact .rn-h{width:32px;min-width:32px;max-width:32px;padding:4px 2px}

		/* Metadata tooltip (Client Activity ID + Server Stats) */
		.hinfo-anchor{cursor:default}
		.mt-popup{position:fixed;z-index:1000;background:var(--vscode-editorHoverWidget-background,var(--vscode-editorWidget-background,#2d2d2d));color:var(--vscode-editorHoverWidget-foreground,var(--vscode-foreground,#ccc));border:1px solid var(--vscode-editorHoverWidget-border,var(--vscode-editorWidget-border,#454545));border-radius:4px;padding:8px 10px;box-shadow:0 2px 8px rgba(0,0,0,.3);display:flex;flex-direction:column;gap:4px;font-size:12px;font-weight:normal;user-select:text;pointer-events:auto;max-width:520px;white-space:nowrap}
		.mt-row{display:flex;align-items:center;gap:6px;min-height:20px}
		.mt-stat{gap:8px}
		.mt-sep{border-top:1px solid var(--vscode-editorHoverWidget-border,var(--vscode-editorWidget-border,#454545));margin:2px 0}
		.mt-title{color:var(--vscode-descriptionForeground,#888);font-size:11px;font-weight:500;margin-right:2px}
		.mt-val{font-family:var(--vscode-editor-font-family,monospace);font-size:11px;user-select:all}
		.mt-copy{display:inline-flex;align-items:center;justify-content:center;background:transparent;border:none;color:var(--vscode-descriptionForeground,#888);cursor:pointer;padding:2px 4px;border-radius:3px;flex-shrink:0}
		.mt-copy:hover{color:var(--vscode-foreground);background:var(--vscode-toolbar-hoverBackground,rgba(128,128,128,.15))}
		.mt-copy svg{width:13px;height:13px}
		.mt-copy-done{color:var(--vscode-terminal-ansiGreen,#89d185)}
`;