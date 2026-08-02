/**
 * Background service worker for the Kusto Workbench browser extension.
 *
 * Used to open the viewer in a new tab when the content script can't
 * do it directly (e.g. on sandboxed pages like raw.githubusercontent.com
 * where window.open() is blocked).
 *
 * Flow:
 * 1. Content script fetches file content and sends it here via sendMessage()
 * 2. We store the content under a one-shot request token and open viewer-standalone.html
 * 3. viewer-standalone.html asks us for the content assigned to its token
 * 4. We respond and clear only that token's content
 */

const pendingViewerContentByToken = new Map();
const PENDING_VIEWER_CONTENT_TTL_MS = 60_000;

function prunePendingViewerContent() {
	const now = Date.now();
	for (const [token, pending] of pendingViewerContentByToken) {
		if (pending.expiresAt <= now) pendingViewerContentByToken.delete(token);
	}
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
	if (!message || typeof message !== 'object') return false;

	switch (message.type) {
		case 'open-viewer-tab': {
			prunePendingViewerContent();
			const requestToken = crypto.randomUUID();
			pendingViewerContentByToken.set(requestToken, {
				payload: message.payload || null,
				expiresAt: Date.now() + PENDING_VIEWER_CONTENT_TTL_MS,
			});
			chrome.tabs.create({
				url: `${chrome.runtime.getURL('viewer-standalone.html')}?request=${encodeURIComponent(requestToken)}`,
			});
			sendResponse({ ok: true, requestToken });
			return false;
		}

		case 'get-pending-viewer-content': {
			prunePendingViewerContent();
			const requestToken = String(message.requestToken || '');
			const pending = requestToken ? pendingViewerContentByToken.get(requestToken) : undefined;
			if (requestToken) pendingViewerContentByToken.delete(requestToken);
			sendResponse({ payload: pending?.payload || null });
			return false;
		}
	}

	return false;
});
