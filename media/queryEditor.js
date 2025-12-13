// Bootstrap loader for the Kusto Query Editor webview.
//
// The implementation is split into smaller files under media/queryEditor/.
// This file remains as the stable entrypoint referenced by the webview HTML.
(function bootstrapKustoQueryEditor() {
	// If the user clicks "+ Add Query Box" before scripts are fully loaded,
	// queue those clicks and replay them once initialization completes.
	if (typeof window.__kustoQueryEditorPendingAdd !== 'number') {
		window.__kustoQueryEditorPendingAdd = 0;
	}
	if (typeof window.addQueryBox !== 'function') {
		window.addQueryBox = function () {
			window.__kustoQueryEditorPendingAdd++;
		};
	}

	const getBaseUrl = () => {
		try {
			if (document.currentScript && document.currentScript.src) {
				return new URL('.', document.currentScript.src);
			}
		} catch {
			// ignore
		}
		const scripts = document.getElementsByTagName('script');
		const last = scripts[scripts.length - 1];
		return new URL('.', last && last.src ? last.src : window.location.href);
	};

	const baseUrl = getBaseUrl();
	const scriptPaths = [
		'queryEditor/vscode.js',
		'queryEditor/state.js',
		'queryEditor/utils.js',
		'queryEditor/schema.js',
		'queryEditor/monaco.js',
		'queryEditor/queryBoxes.js',
		'queryEditor/resultsTable.js',
		'queryEditor/objectViewer.js',
		'queryEditor/columnAnalysis.js',
		'queryEditor/main.js'
	];

	const loadScript = (relativePath) => {
		return new Promise((resolve, reject) => {
			const el = document.createElement('script');
			el.src = new URL(relativePath, baseUrl).toString();
			el.onload = () => resolve();
			el.onerror = () => reject(new Error(`Failed to load ${relativePath}`));
			(document.head || document.documentElement).appendChild(el);
		});
	};

	(async () => {
		for (const path of scriptPaths) {
			await loadScript(path);
		}
	})().catch((err) => {
		console.error('[kusto-query-editor] bootstrap failed', err);
	});
})();