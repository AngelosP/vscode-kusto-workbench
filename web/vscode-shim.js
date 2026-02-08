// Shim for acquireVsCodeApi() — replaces media/queryEditor/vscode.js in the web viewer.
// The extension's webview code uses `vscode.postMessage(...)` for all communication
// with the extension host. This stub makes those calls no-ops so the webview scripts
// load and run without errors in a plain browser context.
//
// The viewer-boot.js script drives the UI by posting simulated extension-host messages
// to window, using the same protocol the real extension uses.

window.__kustoReadOnlyMode = true;

const vscode = {
	postMessage: function(message) {
		// In read-only mode, intercept specific messages that we can handle in-browser.
		if (!message || typeof message !== 'object') return;

		// CSV export: handle in-browser instead of delegating to extension host.
		if (message.type === 'saveResultsCsv' && typeof message.csv === 'string') {
			try {
				const blob = new Blob([message.csv], { type: 'text/csv;charset=utf-8;' });
				const url = URL.createObjectURL(blob);
				const a = document.createElement('a');
				a.href = url;
				a.download = (message.filename || 'results') + '.csv';
				document.body.appendChild(a);
				a.click();
				setTimeout(function() {
					document.body.removeChild(a);
					URL.revokeObjectURL(url);
				}, 100);
			} catch (e) {
				console.warn('[viewer] CSV download failed:', e);
			}
			return;
		}

		// Everything else is silently ignored — no extension host to talk to.
	},
	getState: function() { return null; },
	setState: function() {}
};

// Make it available globally, same as acquireVsCodeApi() would.
window.vscode = vscode;
