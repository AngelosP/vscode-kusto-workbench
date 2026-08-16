import { BrowserViewerRoot } from './src/browser-viewer-root';
import {
	BROWSER_VIEWER_PRESENTATION_READY_DATASET_KEY,
	BROWSER_VIEWER_PRESENTATION_READY_EVENT,
	BROWSER_VIEWER_PROJECTION_APPLIED_EVENT,
	BROWSER_VIEWER_PROJECTION_EVENT,
} from '../src/shared/browserViewerProjection';

// Viewer Boot Script for Browser Extension
// Receives file content from the content script via postMessage (instead of
// fetching from a server proxy like the web app does), delegates adoption to the
// typed browser root, and owns only browser loading/banner/error presentation.

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

	function hideError() {
		var el = document.getElementById('viewer-error');
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

	// ---- Typed projection presentation ----

	var pendingProjection = null;
	var pendingPresentationOptions = null;

	function isPresentationReady() {
		return document.documentElement.dataset[BROWSER_VIEWER_PRESENTATION_READY_DATASET_KEY] === 'true';
	}

	function dispatchProjection(projection) {
		pendingProjection = null;
		window.dispatchEvent(new CustomEvent(BROWSER_VIEWER_PROJECTION_EVENT, { detail: projection }));
	}

	function presentProjection(projection) {
		var options = pendingPresentationOptions || {};
		pendingPresentationOptions = null;
		hideError();
		if (options.hostBackgroundColor) {
			applyHostBackgroundColor(options.hostBackgroundColor);
		}
		if (!options.standalone) {
			try {
				var container = document.getElementById('queries-container');
				if (container) container.style.paddingTop = '20px';
			} catch { /* ignore */ }
		}
		showLoading('Rendering ' + projection.source.filename + '...');
		updateBanner(projection.source.filename, projection.source.pageUrl, projection.source.sourceLabel);
		if (isPresentationReady()) dispatchProjection(projection);
		else pendingProjection = projection;
	}

	function flushPendingProjection() {
		if (pendingProjection && isPresentationReady()) dispatchProjection(pendingProjection);
	}

	window.addEventListener(BROWSER_VIEWER_PRESENTATION_READY_EVENT, flushPendingProjection);
	window.addEventListener(BROWSER_VIEWER_PROJECTION_APPLIED_EVENT, function(event) {
		var detail = event && event.detail;
		if (!detail
			|| !Number.isSafeInteger(detail.generation)
			|| detail.generation <= 0
			|| typeof detail.applied !== 'boolean') return;
		var settlement = browserViewerRoot.settlePresentation(detail.generation, detail.applied === true);
		if (settlement === 'ignored') return;
		if (settlement === 'rejected') {
			showError('Unable to render file', 'The browser presentation adapter rejected the document projection.');
			return;
		}
		hideLoading();
		reportHeight();
		setTimeout(reportHeight, 2000);
		setTimeout(reportHeight, 5000);
	});

	var browserViewerRoot = new BrowserViewerRoot({
		present: presentProjection,
		acknowledge: function(loadGeneration) {
			try {
				window.parent.postMessage({
					type: 'kusto-workbench-load-file-ack',
					loadGeneration: loadGeneration,
				}, '*');
			} catch { /* ignore — might not be in an iframe */ }
		},
	});

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

		var filename = event.data.filename || '';
		var content = event.data.content || '';
		var companionState = event.data.companionState || { status: 'missing' };
		var rawContentUrl = event.data.rawContentUrl || '';
		var sidecarUrl = event.data.sidecarUrl || '';
		var pageUrl = event.data.pageUrl || '';
		var sourceLabel = event.data.sourceLabel || '';
		var loadGeneration = event.data.loadGeneration;
		if (!Number.isSafeInteger(loadGeneration) || loadGeneration <= 0) {
			showError('Invalid viewer payload', 'The file load generation is missing or invalid.');
			return;
		}

		var file = Object.freeze({
			filename: String(filename),
			rawContentUrl: String(rawContentUrl),
			sidecarUrl: sidecarUrl ? String(sidecarUrl) : undefined,
			pageUrl: String(pageUrl),
			sourceLabel: String(sourceLabel)
		});
		pendingPresentationOptions = Object.freeze({
			hostBackgroundColor: event.data.hostBackgroundColor,
			standalone: event.data.standalone === true
		});
		var adoption = browserViewerRoot.adopt(Object.freeze({
			snapshot: Object.freeze({ generation: loadGeneration, file: file }),
			content: String(content),
			companionState: companionState
		}));
		if (!adoption.ok) pendingPresentationOptions = null;
		if (!adoption.ok && adoption.reason === 'invalid') {
			showError(adoption.title, adoption.error);
		}
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
