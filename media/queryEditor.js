// Bootstrap loader for the Kusto Query Editor webview.
//
// The implementation is split into smaller files under media/queryEditor/.
// This file remains as the stable entrypoint referenced by the webview HTML.
(function bootstrapKustoQueryEditor() {
	// If the user clicks one of the add buttons before scripts are fully loaded,
	// queue those clicks and replay them once initialization completes.
	if (!window.__kustoQueryEditorPendingAdds || typeof window.__kustoQueryEditorPendingAdds !== 'object') {
		window.__kustoQueryEditorPendingAdds = { query: 0, markdown: 0, python: 0, url: 0, copilotQuery: 0 };
	}
	const pendingAdds = window.__kustoQueryEditorPendingAdds;
	if (typeof window.__kustoRequestAddSection !== 'function') {
		window.__kustoRequestAddSection = function (kind) {
			const k = String(kind || '').trim();
			if (!k) return;
			if (k === 'query' || k === 'markdown' || k === 'python' || k === 'url' || k === 'copilotQuery') {
				pendingAdds[k] = (pendingAdds[k] || 0) + 1;
			}
		};
	}
	if (typeof window.addQueryBox !== 'function') {
		window.addQueryBox = function () {
			pendingAdds.query = (pendingAdds.query || 0) + 1;
		};
	}
	if (typeof window.addMarkdownBox !== 'function') {
		window.addMarkdownBox = function () {
			pendingAdds.markdown = (pendingAdds.markdown || 0) + 1;
		};
	}
	if (typeof window.addPythonBox !== 'function') {
		window.addPythonBox = function () {
			pendingAdds.python = (pendingAdds.python || 0) + 1;
		};
	}
	if (typeof window.addUrlBox !== 'function') {
		window.addUrlBox = function () {
			pendingAdds.url = (pendingAdds.url || 0) + 1;
		};
	}
	if (typeof window.addCopilotQueryBox !== 'function') {
		window.addCopilotQueryBox = function () {
			pendingAdds.copilotQuery = (pendingAdds.copilotQuery || 0) + 1;
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
		'queryEditor/persistence.js',
		'queryEditor/utils.js',
		'queryEditor/dropdown.js',
		'queryEditor/vendor/marked.min.js',
		'queryEditor/vendor/purify.min.js',
		'queryEditor/vendor/toastui-editor/toastui-editor.webview.js',
		'queryEditor/controlCommands.generated.js',
		'queryEditor/schema.js',
		'queryEditor/monaco.js',
		'queryEditor/queryBoxes.js',
		'queryEditor/copilotQueryBoxes.js',
		'queryEditor/extraBoxes.js',
		'queryEditor/resultsTable.js',
		'queryEditor/objectViewer.js',
		'queryEditor/columnAnalysis.js',
		'queryEditor/main.js'
	];

	const getCacheBuster = () => {
		try {
			return (window.__kustoQueryEditorConfig && window.__kustoQueryEditorConfig.cacheBuster) ?
				String(window.__kustoQueryEditorConfig.cacheBuster) :
				'';
		} catch {
			return '';
		}
	};

	const loadScript = (relativePath) => {
		return new Promise((resolve, reject) => {
			const el = document.createElement('script');
			const url = new URL(relativePath, baseUrl);
			const bust = getCacheBuster();
			if (bust) {
				url.searchParams.set('v', bust);
			}

			// Monaco registers an AMD loader (`define.amd`). Some UMD bundles will detect AMD and
			// register as modules instead of exposing globals.
			// - Our markdown preview expects `window.marked` and `window.DOMPurify`.
			// - Our markdown editor expects `window.toastui.Editor`.
			// For these scripts, temporarily disable AMD/CommonJS detection so they take the
			// globals path.
			const isVendorLib = /(^|\/)(queryEditor\/vendor\/)(marked\.min\.js|purify\.min\.js|toastui-editor\/toastui-editor\.(js|webview\.js))$/i.test(relativePath);
			let restore = null;
			if (isVendorLib) {
				try {
					const saved = {
						define: window.define,
						defineAmd: window.define && window.define.amd,
						module: window.module,
						exports: window.exports
					};

					// Prefer minimally disabling AMD detection (define.amd) so UMD bundles
					// take the globals path without breaking RequireJS itself.
					try {
						if (window.define && window.define.amd) {
							window.define.amd = undefined;
						}
					} catch {
						// ignore
					}

					// Also clear CommonJS detection for these bundles.
					try {
						window.module = undefined;
						window.exports = undefined;
					} catch {
						// ignore
					}

					restore = () => {
						try {
							window.define = saved.define;
							if (window.define) {
								window.define.amd = saved.defineAmd;
							}
							window.module = saved.module;
							window.exports = saved.exports;
						} catch {
							// ignore
						}
					};
				} catch {
					restore = null;
				}
			}

			el.src = url.toString();
			el.onload = () => {
				try { if (restore) restore(); } catch { /* ignore */ }
				resolve();
			};
			el.onerror = () => {
				try { if (restore) restore(); } catch { /* ignore */ }
				reject(new Error(`Failed to load ${relativePath}`));
			};
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