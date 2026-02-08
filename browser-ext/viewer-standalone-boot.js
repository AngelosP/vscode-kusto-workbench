/**
 * Standalone viewer wrapper boot script (NOT sandboxed).
 *
 * This runs in a non-sandboxed extension page that:
 * 1. Asks the background service worker for pending file content
 * 2. Passes it to the sandboxed viewer.html iframe via postMessage
 * 3. Handles CSV downloads forwarded from the iframe
 *
 * NOTE: This must be an external .js file (not inline <script>) because
 * MV3 extension pages have CSP "script-src 'self'" which blocks inline scripts.
 */

const iframe = document.getElementById('viewer');

iframe.addEventListener('load', () => {
	chrome.runtime.sendMessage({ type: 'get-pending-viewer-content' }, (response) => {
		if (chrome.runtime.lastError) {
			console.error('[Kusto Workbench Standalone] Error getting content:', chrome.runtime.lastError.message);
			return;
		}

		if (response && response.payload) {
			// Set the tab title to the filename
			const filename = response.payload.filename || '';
			if (filename) {
				document.title = filename + ' — Kusto Workbench';
			}

			// Forward the content to the sandboxed viewer
			iframe.contentWindow.postMessage(response.payload, '*');
		} else {
			console.warn('[Kusto Workbench Standalone] No pending content received from background.');
		}
	});
});

// Handle messages from the sandboxed viewer iframe
window.addEventListener('message', (event) => {
	if (!event.data || typeof event.data !== 'object') return;

	switch (event.data.type) {
		case 'kusto-workbench-csv-download': {
			// Handle CSV download (iframe can't trigger downloads directly)
			const blob = new Blob([event.data.csv], { type: 'text/csv;charset=utf-8;' });
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = (event.data.filename || 'results') + '.csv';
			document.body.appendChild(a);
			a.click();
			setTimeout(() => {
				document.body.removeChild(a);
				URL.revokeObjectURL(url);
			}, 100);
			break;
		}

		case 'kusto-workbench-resize': {
			// Resize isn't needed in standalone mode (iframe fills the tab)
			break;
		}
	}
});
