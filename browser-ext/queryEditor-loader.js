// Bootstrap loader for the Kusto Query Editor webview — browser extension variant.
//
// Adapted from media/queryEditor.js. The only difference is that paths are resolved
// relative to the extension's bundle root (the sandboxed page's origin), not from
// document.currentScript.src.

(function bootstrapKustoQueryEditor() {
	// Pending add-section clicks (queued before scripts load)
	if (!window.__kustoQueryEditorPendingAdds || typeof window.__kustoQueryEditorPendingAdds !== 'object') {
		window.__kustoQueryEditorPendingAdds = { query: 0, chart: 0, markdown: 0, python: 0, url: 0, copilotQuery: 0 };
	}
	var pendingAdds = window.__kustoQueryEditorPendingAdds;
	if (typeof window.__kustoRequestAddSection !== 'function') {
		window.__kustoRequestAddSection = function (kind) {
			var k = String(kind || '').trim();
			if (!k) return;
			if (k === 'query' || k === 'chart' || k === 'markdown' || k === 'python' || k === 'url' || k === 'copilotQuery') {
				pendingAdds[k] = (pendingAdds[k] || 0) + 1;
			}
		};
	}
	if (typeof window.addQueryBox !== 'function') {
		window.addQueryBox = function () { pendingAdds.query = (pendingAdds.query || 0) + 1; };
	}
	if (typeof window.addMarkdownBox !== 'function') {
		window.addMarkdownBox = function () { pendingAdds.markdown = (pendingAdds.markdown || 0) + 1; };
	}
	if (typeof window.addChartBox !== 'function') {
		window.addChartBox = function () { pendingAdds.chart = (pendingAdds.chart || 0) + 1; };
	}
	if (typeof window.addPythonBox !== 'function') {
		window.addPythonBox = function () { pendingAdds.python = (pendingAdds.python || 0) + 1; };
	}
	if (typeof window.addUrlBox !== 'function') {
		window.addUrlBox = function () { pendingAdds.url = (pendingAdds.url || 0) + 1; };
	}
	if (typeof window.addCopilotQueryBox !== 'function') {
		window.addCopilotQueryBox = function () { pendingAdds.copilotQuery = (pendingAdds.copilotQuery || 0) + 1; };
	}

	// In the browser extension, the sandboxed page (viewer.html) is at the extension
	// root, so all paths are relative to the page's origin. No chrome.runtime.getURL()
	// needed because we're inside the extension's own page.
	var baseUrl = new URL('media/', window.location.href);
	var extensionRootUrl = new URL('.', window.location.href);

	var scriptPaths = [
		'queryEditor/vscode.js',
		'queryEditor/state.js',
		'queryEditor/persistence.js',
		'queryEditor/utils.js',
		'queryEditor/searchControl.js',
		'queryEditor/dropdown.js',
		'queryEditor/vendor/marked.min.js',
		'queryEditor/vendor/purify.min.js',
		'dist/queryEditor/vendor/toastui-editor/toastui-editor.webview.js',
		'dist/queryEditor/vendor/echarts/echarts.webview.js',
		'queryEditor/controlCommands.generated.js',
		'queryEditor/functions.generated.js',
		'queryEditor/schema.js',
		'queryEditor/monaco.js',
		'queryEditor/queryBoxes.js',
		'queryEditor/copilotQueryBoxes.js',
		'queryEditor/extraBoxes.js',
		'queryEditor/resultsTable.js',
		'queryEditor/diffView.js',
		'queryEditor/objectViewer.js',
		'queryEditor/cellViewer.js',
		'queryEditor/columnAnalysis.js',
		'queryEditor/main.js'
	];

	var loadScript = function(relativePath) {
		return new Promise(function(resolve, reject) {
			var el = document.createElement('script');
			var urlBase = String(relativePath || '').startsWith('dist/') ? extensionRootUrl : baseUrl;
			var url = new URL(relativePath, urlBase);

			// For vendor UMD bundles, temporarily disable AMD/CommonJS detection
			// so they expose globals instead of registering as AMD modules
			var isVendorLib = /(^|\/)(queryEditor\/vendor\/)(marked\.min\.js|purify\.min\.js|toastui-editor\/toastui-editor\.(js|webview\.js))$/i.test(relativePath)
				|| /(^|\/)(dist\/queryEditor\/vendor\/toastui-editor\/toastui-editor\.webview\.js)$/i.test(relativePath);
			var restore = null;
			if (isVendorLib) {
				try {
					var saved = {
						define: window.define,
						defineAmd: window.define && window.define.amd,
						module: window.module,
						exports: window.exports
					};
					try {
						if (window.define && window.define.amd) {
							window.define.amd = undefined;
						}
					} catch (_) { /* ignore */ }
					try {
						window.module = undefined;
						window.exports = undefined;
					} catch (_) { /* ignore */ }
					restore = function() {
						try {
							window.define = saved.define;
							if (window.define) window.define.amd = saved.defineAmd;
							window.module = saved.module;
							window.exports = saved.exports;
						} catch (_) { /* ignore */ }
					};
				} catch (_) { restore = null; }
			}

			el.src = url.toString();
			el.onload = function() {
				try { if (restore) restore(); } catch (_) { /* ignore */ }
				resolve();
			};
			el.onerror = function() {
				try { if (restore) restore(); } catch (_) { /* ignore */ }
				reject(new Error('Failed to load ' + relativePath));
			};
			(document.head || document.documentElement).appendChild(el);
		});
	};

	(async function() {
		for (var i = 0; i < scriptPaths.length; i++) {
			await loadScript(scriptPaths[i]);
		}
	})().catch(function(err) {
		console.error('[kusto-workbench-browser-ext] bootstrap failed', err);
	});
})();
