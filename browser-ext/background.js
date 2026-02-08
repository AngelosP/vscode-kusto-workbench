/**
 * Background service worker for the Kusto Workbench browser extension.
 *
 * Used to open the viewer in a new tab when the content script can't
 * do it directly (e.g. on sandboxed pages like raw.githubusercontent.com
 * where window.open() is blocked).
 *
 * Flow:
 * 1. Content script fetches file content and sends it here via sendMessage()
 * 2. We store the content and open viewer-standalone.html in a new tab
 * 3. viewer-standalone.html asks us for the pending content
 * 4. We respond and clear the stored content
 */

let pendingViewerContent = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
	if (!message || typeof message !== 'object') return false;

	switch (message.type) {
		case 'open-viewer-tab': {
			pendingViewerContent = message.payload || null;
			chrome.tabs.create({
				url: chrome.runtime.getURL('viewer-standalone.html'),
			});
			sendResponse({ ok: true });
			return false;
		}

		case 'get-pending-viewer-content': {
			const content = pendingViewerContent;
			pendingViewerContent = null; // one-shot
			sendResponse({ payload: content });
			return false;
		}
	}

	return false;
});
