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
let pendingPayload = null;
let delivered = false;

// Request content from background immediately — don't wait for iframe load,
// because the iframe might already be loaded by the time this script runs
// (local extension resources load very fast and can beat the script).
chrome.runtime.sendMessage({ type: 'get-pending-viewer-content' }, (response) => {
	if (chrome.runtime.lastError) {
		console.error('[Kusto Workbench Standalone] Error getting content:', chrome.runtime.lastError.message);
		return;
	}

	if (response && response.payload) {
		pendingPayload = response.payload;

		// Set the tab title to the filename
		const filename = response.payload.filename || '';
		if (filename) {
			document.title = filename + ' — Kusto Workbench';
		}

		// Try to deliver immediately; also schedule retries in case the
		// sandboxed iframe isn't ready to receive messages yet.
		deliverToIframe();
	} else {
		console.warn('[Kusto Workbench Standalone] No pending content received from background.');
	}
});

function deliverToIframe() {
	if (delivered || !pendingPayload) return;
	try {
		iframe.contentWindow.postMessage(pendingPayload, '*');
	} catch (e) {
		// iframe might not be accessible yet
	}
	// We can't reliably detect whether the sandboxed iframe received the
	// message (cross-origin), so keep retrying for a few seconds.
	// viewer-boot.js deduplicates via __kustoLoadFileHandled.
}

// Retry delivery several times to handle the race between iframe load
// and background response arriving at different times.
let retryCount = 0;
const retryInterval = setInterval(() => {
	retryCount++;
	deliverToIframe();
	if (retryCount >= 15) {
		clearInterval(retryInterval);
	}
}, 500);

// Also try on iframe load event (belt-and-suspenders)
iframe.addEventListener('load', () => {
	// Short delay to let viewer-boot.js set up its message listener
	setTimeout(deliverToIframe, 100);
	setTimeout(deliverToIframe, 500);
});

// Listen for the viewer confirming receipt so we can stop retrying
window.addEventListener('message', (event) => {
	if (!event.data || typeof event.data !== 'object') return;

	switch (event.data.type) {
		case 'kusto-workbench-load-file-ack': {
			delivered = true;
			clearInterval(retryInterval);
			break;
		}

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
