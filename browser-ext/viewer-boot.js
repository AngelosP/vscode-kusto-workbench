import { browserCanonicalSectionKind, browserDefaultSectionKind, composeBrowserCompatibilityState, parseBrowserNativeWorkbenchText, parseBrowserWorkbenchText } from './src/viewer-document';

// Viewer Boot Script for Browser Extension
// Receives file content from the content script via postMessage (instead of
// fetching from a server proxy like the web app does). Then parses the content
// and posts the same sequence of messages that the real VS Code extension host
// would send to the webview, so all existing webview code works identically.

(function() {
	'use strict';

	// ---- Suppress known harmless Kusto worker errors ----
	// The @kusto/monaco-kusto worker throws "Unexpected object: [object Object]"
	// during schema processing. It's caught and recovered from internally, but
	// our generic catch handlers log it via console.error. Edge surfaces any
	// console.error from sandboxed extension pages as a blocking extension error.
	// Downgrade these to console.warn so Edge doesn't flag the extension as broken.
	try {
		var _origError = console.error;
		console.error = function() {
			try {
				if (arguments.length >= 2 && arguments[0] === '[kusto]') {
					var msg = String(arguments[1] || '');
					if (msg.indexOf('Unexpected object') !== -1) {
						console.warn.apply(console, arguments);
						return;
					}
				}
			} catch (_) { /* fall through to original */ }
			return _origError.apply(console, arguments);
		};
	} catch (_) { /* ignore */ }

	// ---- Helpers ----

	function getFilenameFromUrl(url) {
		try {
			var parts = url.split('/');
			return parts[parts.length - 1] || '';
		} catch {
			return '';
		}
	}

	function postExtensionMessage(message) {
		window.dispatchEvent(new MessageEvent('message', { data: message }));
	}

	// ---- Loading UI ----

	function showLoading(text) {
		var el = document.getElementById('viewer-loading');
		if (el) {
			el.style.display = '';
			var msgEl = el.querySelector('.viewer-loading-message');
			if (msgEl) msgEl.textContent = text || 'Loading...';
		}
	}

	function hideLoading() {
		var el = document.getElementById('viewer-loading');
		if (el) el.style.display = 'none';
	}

	function showError(title, detail) {
		hideLoading();
		var el = document.getElementById('viewer-error');
		if (!el) return;
		el.style.display = '';
		var titleEl = el.querySelector('.viewer-error-title');
		var detailEl = el.querySelector('.viewer-error-detail');
		if (titleEl) titleEl.textContent = title;
		if (detailEl) detailEl.textContent = detail || '';
	}

	function updateBanner(filename, pageUrl, sourceLabel) {
		var el = document.getElementById('viewer-banner');
		if (!el) return;
		el.style.display = '';
		var nameEl = el.querySelector('.viewer-banner-filename');
		var linkEl = el.querySelector('.viewer-banner-source-link');
		if (nameEl) nameEl.textContent = filename || '';
		if (linkEl) {
			if (pageUrl) {
				linkEl.href = pageUrl;
				linkEl.textContent = 'View on ' + (sourceLabel || 'source');
				linkEl.style.display = '';
			} else {
				linkEl.style.display = 'none';
			}
		}
	}

	// ---- Pre-process sections for browser extension defaults ----

	/**
	 * When viewing in the browser (read-only), apply sensible defaults:
	 * - Query sections collapsed (reader wants to see results, not raw KQL)
	 * - Markdown sections in Preview mode (rendered, not editable)
	 * - Chart sections in Preview mode (show the chart, not the config)
	 */
	function applyBrowserViewDefaults(sections) {
		if (!Array.isArray(sections)) return sections;
		for (var i = 0; i < sections.length; i++) {
			var sec = sections[i];
			if (!sec || typeof sec !== 'object') continue;
			var t = browserCanonicalSectionKind(sec.type);
			if (t === 'query' || t === 'sql') {
				sec.expanded = false;
			} else if (t === 'markdown') {
				sec.mode = 'preview';
			} else if (t === 'chart') {
				sec.mode = 'preview';
			}
		}
		return sections;
	}

	// ---- Process file content ----

	function processFileContent(filename, content, companionState, rawContentUrl, sidecarUrl) {
		var lowerFilename = (filename || '').toLowerCase();
		var state;
		var documentKind = 'kqlx';

		if (lowerFilename.endsWith('.kqlx') || lowerFilename.endsWith('.mdx')) {
			// .kqlx file: parse as KqlxFileV1
			var expectedKind = lowerFilename.endsWith('.mdx') ? 'mdx' : 'kqlx';
			var parsed = parseBrowserNativeWorkbenchText(content, { allowedKinds: [expectedKind], defaultKind: expectedKind });
			if (!parsed.ok) {
				showError('Invalid .kqlx file', parsed.error);
				return null;
			}
			state = parsed.file.state;
			documentKind = parsed.file.kind;

		} else if (lowerFilename.endsWith('.sqlx')) {
			// .sqlx file: SQL notebook, same JSON schema as .kqlx with kind 'sqlx'
			var sqlxParsed = parseBrowserNativeWorkbenchText(content, { allowedKinds: ['sqlx'], defaultKind: 'sqlx' });
			if (!sqlxParsed.ok) {
				showError('Invalid .sqlx file', sqlxParsed.error);
				return null;
			}
			state = sqlxParsed.file.state;
			documentKind = sqlxParsed.file.kind;

		} else if (lowerFilename.endsWith('.kql.json') || lowerFilename.endsWith('.csl.json')) {
			// .kql.json sidecar: parse it
			var sidecarParsed = parseBrowserWorkbenchText(content, { allowedKinds: ['kqlx'] });
			if (!sidecarParsed.ok) {
				showError('Invalid sidecar file', sidecarParsed.error);
				return null;
			}
			state = sidecarParsed.file.state;

		} else if (lowerFilename.endsWith('.kql') || lowerFilename.endsWith('.csl')) {
			// .kql/.csl file: raw query text + optional sidecar
			var queryText = content;
			var compatibility = composeBrowserCompatibilityState(queryText, companionState, {
				expectedFilename: filename,
				rawContentUrl: rawContentUrl,
				sidecarUrl: sidecarUrl
			});
			if (!compatibility.ok) {
				showError('Invalid companion file', compatibility.error);
				return null;
			}
			state = compatibility.state;

		} else {
			showError('Unsupported file type', 'Supported: .kqlx, .sqlx, .mdx, .kql, .csl, .kql.json, .csl.json');
			return null;
		}

		// Apply browser-view defaults (collapse queries, preview markdown/chart)
		if (state && Array.isArray(state.sections)) {
			state.sections = applyBrowserViewDefaults(state.sections);
		}

		return { state: state, documentKind: documentKind };
	}

	// ---- Render the notebook ----

	function renderNotebook(filename, state, documentKind, pageUrl) {
		showLoading('Rendering...');

		// 1. persistenceMode
		postExtensionMessage({
			type: 'persistenceMode',
			isSessionFile: false,
			documentUri: pageUrl || '',
			compatibilityMode: false,
			documentKind: documentKind,
			allowedSectionKinds: [],
			defaultSectionKind: browserDefaultSectionKind(documentKind)
		});

		// 2. connectionsData
		postExtensionMessage({
			type: 'connectionsData',
			connections: [],
			lastConnectionId: null,
			lastDatabase: null,
			cachedDatabases: {},
			favorites: [],
			leaveNoTraceClusters: [],
			caretDocsEnabled: false,
			autoTriggerAutocompleteEnabled: false,
			copilotInlineCompletionsEnabled: false
		});

		// 3. copilotAvailability
		postExtensionMessage({
			type: 'copilotAvailability',
			available: false,
			boxId: '__kusto_global__'
		});

		// 4. documentData
		postExtensionMessage({
			type: 'documentData',
			ok: true,
			state: state,
			documentUri: pageUrl || ''
		});

		hideLoading();

		// Make editors read-only
		setTimeout(function() { makeEditorsReadOnly(); }, 1500);
		setTimeout(function() { makeEditorsReadOnly(); }, 3000);
		setTimeout(function() { makeEditorsReadOnly(); }, 5000);

		// Report height to parent frame for auto-sizing
		reportHeight();
		setTimeout(reportHeight, 2000);
		setTimeout(reportHeight, 5000);
	}

	// ---- Make editors read-only ----

	function makeEditorsReadOnly() {
		try {
			if (typeof queryEditors !== 'undefined' && queryEditors) {
				for (var key in queryEditors) {
					if (queryEditors.hasOwnProperty(key)) {
						var editor = queryEditors[key];
						if (editor && typeof editor.updateOptions === 'function') {
							editor.updateOptions({ readOnly: true });
						}
					}
				}
			}
		} catch (e) {
			// ignore
		}
		try {
			if (typeof pythonEditors !== 'undefined' && pythonEditors) {
				for (var key2 in pythonEditors) {
					if (pythonEditors.hasOwnProperty(key2)) {
						var editor2 = pythonEditors[key2];
						if (editor2 && typeof editor2.updateOptions === 'function') {
							editor2.updateOptions({ readOnly: true });
						}
					}
				}
			}
		} catch (e2) {
			// ignore
		}
	}

	// ---- Report height to parent (for iframe auto-sizing) ----

	function reportHeight() {
		try {
			var height = Math.max(
				document.documentElement.scrollHeight,
				document.body.scrollHeight,
				600
			);
			window.parent.postMessage({
				type: 'kusto-workbench-resize',
				height: height
			}, '*');
		} catch {
			// ignore — might not be in an iframe
		}
	}

	// ---- Disable persistence ----

	try {
		window.__kustoPersistenceEnabled = false;
		window.schedulePersist = function() { /* no-op in read-only viewer */ };
	} catch {
		// ignore
	}

	// ---- Listen for file content from the content script ----

	/**
	 * Convert an rgb()/rgba() color string to a hex string (#rrggbb).
	 * Monaco's token theme parser rejects rgb() values — it only accepts hex.
	 */
	function rgbToHex(color) {
		if (!color || typeof color !== 'string') return color;
		var m = color.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
		if (!m) return color; // already hex or unsupported format
		var r = parseInt(m[1], 10);
		var g = parseInt(m[2], 10);
		var b = parseInt(m[3], 10);
		return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
	}

	function applyHostBackgroundColor(bgColor) {
		if (!bgColor || typeof bgColor !== 'string') return;
		try {
			var hex = rgbToHex(bgColor);
			// Apply the host page's background color to our viewer
			document.documentElement.style.setProperty('--vscode-editor-background', hex);
			document.body.style.background = hex;
		} catch {
			// ignore
		}
	}

	var __kustoLoadFileHandled = false;

	function handleIncomingMessage(event) {
		if (!event.data || typeof event.data !== 'object') return;

		// Viewport info from the content script — set CSS vars so fixed-position
		// dialogs (filter, sort) center within the visible region, not the full iframe.
		if (event.data.type === 'kusto-workbench-viewport') {
			try {
				var scrollTop = event.data.scrollTop;
				var vpHeight = event.data.viewportHeight;
				if (typeof scrollTop === 'number' && typeof vpHeight === 'number') {
					var root = document.documentElement;
					root.style.setProperty('--kw-modal-top', Math.round(scrollTop) + 'px');
					root.style.setProperty('--kw-modal-height', Math.round(vpHeight) + 'px');
				}
			} catch { /* ignore */ }
			return;
		}

		if (event.data.type !== 'kusto-workbench-load-file') return;
		// Only handle the first load-file message (retries from the opener keep arriving)
		if (__kustoLoadFileHandled) return;
		__kustoLoadFileHandled = true;

		// Acknowledge receipt so the sender can stop retrying
		try {
			window.parent.postMessage({ type: 'kusto-workbench-load-file-ack' }, '*');
		} catch { /* ignore — might not be in an iframe */ }

		var filename = event.data.filename || '';
		var content = event.data.content || '';
			var companionState = event.data.companionState || { status: 'missing' };
			var rawContentUrl = event.data.rawContentUrl || '';
			var sidecarUrl = event.data.sidecarUrl || '';
		var pageUrl = event.data.pageUrl || '';
		var sourceLabel = event.data.sourceLabel || '';

		// Apply host page background color if provided
		if (event.data.hostBackgroundColor) {
			applyHostBackgroundColor(event.data.hostBackgroundColor);
		}

		// Add top spacing inside the iframe so there's a gap between the
		// host page header and our content, without exposing the host's
		// container background through an external margin.
		// Skip for standalone tabs (opened via new-tab viewer).
		if (!event.data.standalone) {
			try {
				var container = document.getElementById('queries-container');
				if (container) container.style.paddingTop = '20px';
			} catch { /* ignore */ }
		}

		showLoading('Parsing ' + filename + '...');
		updateBanner(filename, pageUrl, sourceLabel);

			var result = processFileContent(filename, content, companionState, rawContentUrl, sidecarUrl);
		if (!result) return;

		renderNotebook(filename, result.state, result.documentKind, pageUrl);
	}

	window.addEventListener('message', handleIncomingMessage);

	// ---- Height reporting on resize ----

	var resizeObserver;
	try {
		resizeObserver = new ResizeObserver(function() {
			reportHeight();
		});
		resizeObserver.observe(document.documentElement);
	} catch {
		// fallback to interval
		setInterval(reportHeight, 3000);
	}

	showLoading('Waiting for file content...');
})();
