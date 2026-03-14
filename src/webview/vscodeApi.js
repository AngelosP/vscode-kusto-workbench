const vscode = acquireVsCodeApi();
// Expose on window so Lit components (loaded as IIFE bundles) can access it.
window.vscode = vscode;
