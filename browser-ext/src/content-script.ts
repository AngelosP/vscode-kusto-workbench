/**
 * Content script for the Kusto Workbench browser extension.
 *
 * Injected into pages matching the URL patterns in manifest.json.
 * Detects supported files (.kqlx, .kql, .csl) on the current page.
 *
 * On platforms that have a view-mode tab bar (GitHub: Code | Blame),
 * a "Kusto Workbench" tab is added and automatically selected. The
 * original code view is hidden and the sandboxed viewer iframe is shown.
 *
 * On platforms without a tab bar (ADO, raw URLs) a top-bar render
 * button is shown as fallback.
 *
 * The content script fetches file content using the browser's existing
 * session/cookies — no OAuth flow needed.
 */

import { findProvider } from './providers/registry';
import type { DetectedFile, FileSourceProvider, ViewModeTabBarInfo } from './providers/types';

// ---- State ----

const LOG_PREFIX = '[Kusto Workbench]';

let currentProvider: FileSourceProvider | null = null;
let currentFile: DetectedFile | null = null;
let viewerIframe: HTMLIFrameElement | null = null;
let originalContent: HTMLElement | null = null;
let navigationCleanup: (() => void) | null = null;
let isRendered = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

// Tab-mode state
let kustoTab: HTMLElement | null = null;
let tabBarInfo: ViewModeTabBarInfo | null = null;
/** Elements hidden in tab mode (siblings after the blob header). */
let hiddenSiblings: HTMLElement[] = [];
/** The element after which the iframe is inserted in tab mode. */
let iframeAnchor: HTMLElement | null = null;

// Fallback button-mode state
let renderButton: HTMLElement | null = null;

// Cross-navigation state (survives cleanup so we remember user intent across SPA navigations)
/** True when user explicitly clicked Code/Blame to leave the Kusto tab. */
let wasKustoDeactivatedByUser = false;
/** Last raw URL detected — used to reset deactivation flag when navigating to a different file. */
let lastDetectedRawUrl: string | null = null;

// ---- Main entry point ----

function init() {
	console.log(LOG_PREFIX, 'init', location.href);
	detectAndSetup();

	// Re-detect on SPA navigations
	const url = new URL(location.href);
	const provider = findProvider(url);
	if (provider) {
		navigationCleanup = provider.observeNavigation(() => {
			cleanup();
			// Small delay to let the SPA finish rendering the new page
			setTimeout(detectAndSetup, 500);
		});
	}
}

function detectAndSetup(retryCount = 0) {
	const url = new URL(location.href);
	currentProvider = findProvider(url);
	if (!currentProvider) {
		console.log(LOG_PREFIX, 'No provider found for', url.href);
		return;
	}

	currentFile = currentProvider.getFileInfo(url);
	if (!currentFile) {
		console.log(LOG_PREFIX, 'Provider matched but no supported file detected');
		return;
	}

	// If this is a different file than what we last saw, reset the deactivation flag
	// so the Kusto tab auto-activates on the new file.
	if (lastDetectedRawUrl !== null && lastDetectedRawUrl !== currentFile.rawContentUrl) {
		wasKustoDeactivatedByUser = false;
	}
	lastDetectedRawUrl = currentFile.rawContentUrl;

	console.log(LOG_PREFIX, 'Detected file:', currentFile.filename, '| Provider:', currentProvider.id);
	injectStyles();

	// Check if this page requires a new-tab viewer (e.g. sandboxed pages)
	const needsNewTab = currentProvider.requiresNewTabViewer ? currentProvider.requiresNewTabViewer() : false;
	if (needsNewTab) {
		console.log(LOG_PREFIX, 'Page requires new-tab viewer (sandboxed) — showing render button');
		injectRenderButton();
		return;
	}

	// Try the tab-bar approach first; fall back to the render button
	const canHaveTabBar = currentProvider.supportsTabBar ? currentProvider.supportsTabBar() : true;
	tabBarInfo = canHaveTabBar ? currentProvider.getViewModeTabBar() : null;
	if (tabBarInfo) {
		console.log(LOG_PREFIX, 'Tab bar found — injecting tab. Container:', tabBarInfo.container.tagName, '| Tabs:', tabBarInfo.existingTabs.map(t => t.textContent?.trim()));
		injectTab(tabBarInfo);
	} else if (canHaveTabBar && retryCount < 10) {
		// GitHub React UI renders tabs lazily — retry with increasing delay
		const delay = retryCount < 3 ? 500 : 1000;
		console.log(LOG_PREFIX, `Tab bar not found yet, retry ${retryCount + 1}/10 in ${delay}ms`);
		retryTimer = setTimeout(() => detectAndSetup(retryCount + 1), delay);
	} else {
		if (canHaveTabBar) {
			// Only dump diagnostics when we expected a tab bar but couldn't find it
			console.log(LOG_PREFIX, 'Tab bar not found after retries — dumping DOM diagnostics');
			dumpTabBarDiagnostics();
		} else {
			console.log(LOG_PREFIX, 'Page does not support tab bar — using render button');
		}
		injectRenderButton();
	}
}

/** Dump DOM info to the console so we can figure out the real selectors. */
function dumpTabBarDiagnostics() {
	// 1. Any [role="tablist"] on the page?
	const tabLists = document.querySelectorAll('[role="tablist"]');
	console.log(LOG_PREFIX, 'DIAG: [role="tablist"] count:', tabLists.length);
	tabLists.forEach((tl, i) => {
		console.log(LOG_PREFIX, `  tablist[${i}]:`, tl.tagName, tl.className, '| innerHTML snippet:', tl.innerHTML.slice(0, 300));
	});

	// 2. Any elements whose text is exactly "Code" or "Blame"?
	const allEls = document.querySelectorAll('button, a, [role="tab"], span, li');
	const codeEls: Element[] = [];
	const blameEls: Element[] = [];
	allEls.forEach(el => {
		const text = el.textContent?.trim();
		if (text === 'Code') codeEls.push(el);
		if (text === 'Blame') blameEls.push(el);
	});
	console.log(LOG_PREFIX, 'DIAG: Elements with text "Code":', codeEls.length);
	codeEls.forEach((el, i) => {
		const he = el as HTMLElement;
		console.log(LOG_PREFIX, `  code[${i}]:`, he.tagName, he.className, '| parent:', he.parentElement?.tagName, he.parentElement?.className, '| grandparent:', he.parentElement?.parentElement?.tagName, he.parentElement?.parentElement?.className);
	});
	console.log(LOG_PREFIX, 'DIAG: Elements with text "Blame":', blameEls.length);
	blameEls.forEach((el, i) => {
		const he = el as HTMLElement;
		console.log(LOG_PREFIX, `  blame[${i}]:`, he.tagName, he.className, '| parent:', he.parentElement?.tagName, he.parentElement?.className, '| grandparent:', he.parentElement?.parentElement?.tagName, he.parentElement?.parentElement?.className);
	});

	// 3. Dump the area near the file header
	const headerCandidates = document.querySelectorAll('.react-blob-header, [class*="blob-header"], [class*="file-header"], [class*="FileHeader"]');
	console.log(LOG_PREFIX, 'DIAG: Header-like elements:', headerCandidates.length);
	headerCandidates.forEach((el, i) => {
		console.log(LOG_PREFIX, `  header[${i}]:`, el.tagName, el.className, '| innerHTML snippet:', el.innerHTML.slice(0, 500));
	});
}

// ---- Cleanup ----

function cleanup() {
	if (retryTimer) {
		clearTimeout(retryTimer);
		retryTimer = null;
	}
	if (kustoTab && kustoTab.parentNode) {
		kustoTab.parentNode.removeChild(kustoTab);
		kustoTab = null;
	}
	if (renderButton && renderButton.parentNode) {
		renderButton.parentNode.removeChild(renderButton);
		renderButton = null;
	}
	if (viewerIframe && viewerIframe.parentNode) {
		viewerIframe.parentNode.removeChild(viewerIframe);
		viewerIframe = null;
	}
	if (originalContent) {
		originalContent.style.display = '';
		originalContent = null;
	}
	// Restore hidden siblings (tab mode)
	for (const el of hiddenSiblings) {
		el.style.display = '';
	}
	hiddenSiblings = [];
	iframeAnchor = null;
	// Restore original tab selection if needed
	if (tabBarInfo) {
		for (const tab of tabBarInfo.existingTabs) {
			tab.removeAttribute('data-kusto-deactivated');
		}
		tabBarInfo = null;
	}
	currentProvider = null;
	currentFile = null;
	isRendered = false;
}

// ---- Tab injection (GitHub Primer SegmentedControl: Code | Blame | Kusto Workbench) ----

function injectTab(info: ViewModeTabBarInfo) {
	if (!currentProvider || !currentFile) return;
	if (kustoTab) return; // already injected

	// Clone the first existing tab (an <li> element) to inherit Primer classes.
	const templateTab = info.existingTabs[0];
	if (!templateTab) return;

	const clone = templateTab.cloneNode(true) as HTMLElement;

	// Find the button inside the cloned <li>
	const cloneBtn = clone.querySelector('button') as HTMLElement | null;
	if (!cloneBtn) {
		console.log(LOG_PREFIX, 'Could not find button inside cloned tab');
		return;
	}

	// Replace text content while preserving the Primer span>div structure
	const textDiv = clone.querySelector('[data-text]') as HTMLElement | null;
	if (textDiv) {
		textDiv.setAttribute('data-text', 'Kusto Workbench');
		textDiv.textContent = 'Kusto Workbench';
	} else {
		cloneBtn.textContent = 'Kusto Workbench';
	}

	// Remove data-selected from the clone (it starts inactive, we'll activate it below)
	clone.removeAttribute('data-selected');
	cloneBtn.setAttribute('aria-current', 'false');

	// Remove hotkey bindings from the clone
	cloneBtn.removeAttribute('data-hotkey');

	// Mark for identification
	clone.setAttribute('data-kusto-workbench-tab', 'true');

	kustoTab = clone;

	// Append to the <ul> container
	info.container.appendChild(clone);

	// Wire click on our tab
	cloneBtn.addEventListener('click', (e) => {
		e.preventDefault();
		e.stopPropagation();
		activateKustoTab();
	});

	// Wire clicks on original tabs to deactivate ours and re-select the clicked tab
	for (const tab of info.existingTabs) {
		const btn = tab.querySelector('button') || tab;
		btn.addEventListener('click', () => deactivateKustoTab(tab));
	}

	// Auto-activate by default, unless the user explicitly navigated away from Kusto
	// for this file (e.g. clicked Code or Blame)
	if (!wasKustoDeactivatedByUser) {
		activateKustoTab();
	}
}

function activateKustoTab() {
	if (!tabBarInfo || !kustoTab || !currentProvider) return;

	wasKustoDeactivatedByUser = false;

	// Deactivate all sibling tabs (including any React may have re-rendered)
	const allSiblingItems = kustoTab.parentElement
		? Array.from(kustoTab.parentElement.querySelectorAll(':scope > li'))
		: tabBarInfo.existingTabs;
	for (const tab of allSiblingItems) {
		if (tab === kustoTab) continue;
		tab.removeAttribute('data-selected');
		const btn = tab.querySelector('button');
		if (btn) btn.setAttribute('aria-current', 'false');
	}

	// Activate the Kusto tab
	kustoTab.setAttribute('data-selected', '');
	const kustoBtn = kustoTab.querySelector('button');
	if (kustoBtn) kustoBtn.setAttribute('aria-current', 'true');

	// Load or show the viewer
	if (!isRendered) {
		loadAndShowViewer();
	} else {
		showViewer();
	}
}

function deactivateKustoTab(clickedTab?: HTMLElement) {
	if (!kustoTab || !tabBarInfo) return;

	wasKustoDeactivatedByUser = true;

	// Deactivate our tab
	kustoTab.removeAttribute('data-selected');
	const kustoBtn = kustoTab.querySelector('button');
	if (kustoBtn) kustoBtn.setAttribute('aria-current', 'false');

	// Re-activate the tab the user clicked. We must do this ourselves because
	// activateKustoTab() previously removed data-selected from all tabs, and
	// if the URL doesn't change (e.g. clicking Code while already on /blob/),
	// React won't re-render to restore it.
	if (clickedTab) {
		clickedTab.setAttribute('data-selected', '');
		const btn = clickedTab.querySelector('button');
		if (btn) btn.setAttribute('aria-current', 'true');
	}

	hideViewer();
}

// ---- New-tab viewer (for sandboxed pages like raw.githubusercontent.com) ----

async function openViewerInNewTab() {
	if (!currentProvider || !currentFile) return;

	const btn = renderButton?.querySelector('.kusto-workbench-render-btn');
	if (btn) {
		btn.textContent = 'Loading...';
		(btn as HTMLButtonElement).disabled = true;
	}

	try {
		const content = await fetchContent(currentFile.rawContentUrl);

		let sidecarContent: string | null = null;
		if (currentFile.sidecarUrl) {
			try {
				sidecarContent = await fetchContent(currentFile.sidecarUrl);
			} catch { /* optional */ }
		}

		const payload = {
			type: 'kusto-workbench-load-file',
			filename: currentFile.filename,
			content,
			sidecarContent,
			pageUrl: currentFile.pageUrl,
			sourceLabel: currentFile.sourceLabel,
			standalone: true,
		};

		// Ask the background service worker to open the viewer in a new tab.
		// We can't use window.open() because the page's sandbox CSP blocks popups.
		chrome.runtime.sendMessage({ type: 'open-viewer-tab', payload });

		if (btn) {
			(btn as HTMLButtonElement).disabled = false;
			btn.innerHTML =
				`<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2 8l4 4 8-8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>` +
				`<span>Opened in new tab</span>`;
		}
	} catch (err: any) {
		console.error(LOG_PREFIX, 'Failed to open viewer in new tab:', err);
		if (btn) {
			btn.textContent = `Error: ${err?.message || String(err)}`;
			setTimeout(() => {
				if (btn) btn.innerHTML =
					`<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="1" y="2" width="14" height="12" rx="1.5" stroke="currentColor" stroke-width="1.2" fill="none"/>` +
					`<path d="M1 5h14" stroke="currentColor" stroke-width="1.2"/><path d="M5 5v9" stroke="currentColor" stroke-width="1.2"/></svg>` +
					`<span>Open in Kusto Workbench</span>`;
				(btn as HTMLButtonElement).disabled = false;
			}, 3000);
		}
	}
}

// ---- Fallback render button (for platforms without tab bars) ----

function injectRenderButton() {
	if (!currentProvider || !currentFile) return;
	if (renderButton) return;

	renderButton = document.createElement('div');
	renderButton.className = 'kusto-workbench-render-bar';
	renderButton.innerHTML = `
		<div class="kusto-workbench-render-bar-inner">
			<button class="kusto-workbench-render-btn" type="button">
				<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
					<rect x="1" y="2" width="14" height="12" rx="1.5" stroke="currentColor" stroke-width="1.2" fill="none"/>
					<path d="M1 5h14" stroke="currentColor" stroke-width="1.2"/>
					<path d="M5 5v9" stroke="currentColor" stroke-width="1.2"/>
				</svg>
				<span>Render in Kusto Workbench</span>
			</button>
			<span class="kusto-workbench-render-file">${escapeHtml(currentFile.filename)}</span>
		</div>
	`;

	const actionSel = currentProvider.getActionBarSelector();
	const actionBar = actionSel ? document.querySelector(actionSel) : null;
	const contentSel = currentProvider.getContentAreaSelector();
	const contentArea = contentSel ? document.querySelector(contentSel) : null;

	if (actionBar) {
		actionBar.parentNode?.insertBefore(renderButton, actionBar.nextSibling);
	} else if (contentArea) {
		contentArea.parentNode?.insertBefore(renderButton, contentArea);
	} else {
		document.body.prepend(renderButton);
	}

	const btn = renderButton.querySelector('.kusto-workbench-render-btn');
	btn?.addEventListener('click', handleRenderButtonClick);
}

async function handleRenderButtonClick() {
	// On sandboxed pages, open in a new tab instead of inline iframe
	if (currentProvider?.requiresNewTabViewer?.()) {
		await openViewerInNewTab();
		return;
	}
	if (isRendered) {
		toggleView();
		return;
	}
	await loadAndShowViewer();
}

function toggleView() {
	if (!viewerIframe || !originalContent) return;
	if (viewerIframe.style.display === 'none') {
		showViewer();
	} else {
		hideViewer();
	}
	updateButtonState();
}

function updateButtonState() {
	if (!renderButton) return;
	const btn = renderButton.querySelector('.kusto-workbench-render-btn');
	if (!btn) return;

	(btn as HTMLButtonElement).disabled = false;

	const showingViewer = viewerIframe && viewerIframe.style.display !== 'none';

	btn.innerHTML = showingViewer
		? `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2 8l4 4 8-8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>
		   <span>Show original</span>`
		: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="1" y="2" width="14" height="12" rx="1.5" stroke="currentColor" stroke-width="1.2" fill="none"/>
		   <path d="M1 5h14" stroke="currentColor" stroke-width="1.2"/><path d="M5 5v9" stroke="currentColor" stroke-width="1.2"/></svg>
		   <span>Render in Kusto Workbench</span>`;
}

// ---- Viewer management (shared between tab and button modes) ----

/**
 * In tab mode, find the blob view header by walking up from the tab bar,
 * then collect all sibling elements after it — those are the code/blame
 * content that must be hidden when the Kusto Workbench tab is active.
 */
function findContentToHideForTabMode(): { anchor: HTMLElement; siblings: HTMLElement[] } | null {
	if (!tabBarInfo) return null;

	// Walk up from the <ul> tab bar to find the top-level blob header container.
	// On GitHub's React UI, the class hierarchy looks like:
	//   BlobViewHeader-module__Box___…  (top-level header div)
	//     BlobViewHeader-module__Box_1__…
	//       BlobViewHeader-module__Box_2__…  ← contains the <ul> tab bar
	let headerEl: HTMLElement | null = tabBarInfo.container;
	for (let i = 0; i < 10 && headerEl; i++) {
		if (!headerEl.parentElement) break;
		const p: HTMLElement = headerEl.parentElement;
		// Stop when we reach an element whose next sibling would be the code view,
		// i.e., the parent is the overall file viewer wrapper (not just the header).
		const nextSib = headerEl.nextElementSibling;
		if (nextSib && headerEl !== tabBarInfo.container) {
			// Check if the sibling looks like code content (not another header part)
			const sibClasses = (nextSib as HTMLElement).className || '';
			const headerClasses = headerEl.className || '';
			// We want to stop walking up when we've left the header.
			// The header elements all have "BlobViewHeader" or "blob-header" in their classes.
			if (!headerClasses.includes('BlobViewHeader') && !headerClasses.includes('blob-header')) {
				break;
			}
		}
		headerEl = p;
	}

	// Fallback: if the walk didn't find a good header, use a broader selector
	if (!headerEl || headerEl === document.documentElement) {
		// Try known header selectors
		const fallback = document.querySelector('[class*="BlobViewHeader-module__Box___"]') as HTMLElement
			|| document.querySelector('.react-blob-header') as HTMLElement;
		if (fallback) headerEl = fallback;
	}

	if (!headerEl) {
		console.log(LOG_PREFIX, 'Could not locate blob header for tab-mode content hiding');
		return null;
	}

	console.log(LOG_PREFIX, 'Header element for tab mode:', headerEl.tagName, headerEl.className?.slice(0, 80));

	// Collect all siblings after the header element
	const siblings: HTMLElement[] = [];
	let sib = headerEl.nextElementSibling;
	while (sib) {
		if (sib !== viewerIframe) {
			siblings.push(sib as HTMLElement);
		}
		sib = sib.nextElementSibling;
	}

	console.log(LOG_PREFIX, 'Siblings to hide:', siblings.length, siblings.map(s => s.tagName + '.' + (s.className || '').slice(0, 40)));

	return { anchor: headerEl, siblings };
}

async function loadAndShowViewer() {
	if (!currentProvider || !currentFile) return;

	const btn = renderButton?.querySelector('.kusto-workbench-render-btn');
	if (btn) {
		btn.textContent = 'Loading...';
		(btn as HTMLButtonElement).disabled = true;
	}

	try {
		const content = await fetchContent(currentFile.rawContentUrl);

		let sidecarContent: string | null = null;
		if (currentFile.sidecarUrl) {
			try {
				sidecarContent = await fetchContent(currentFile.sidecarUrl);
			} catch { /* optional */ }
		}

		// Hide original content — strategy depends on mode
		if (tabBarInfo) {
			// Tab mode: walk from tab bar to find header, hide all siblings after it
			const found = findContentToHideForTabMode();
			if (found) {
				hiddenSiblings = found.siblings;
				iframeAnchor = found.anchor;
				for (const el of hiddenSiblings) {
					el.style.display = 'none';
				}
			}
		} else {
			// Button mode: use provider's content area selector
			const contentSel = currentProvider.getContentAreaSelector();
			if (contentSel) {
				const el = document.querySelector(contentSel) as HTMLElement | null;
				if (el) {
					originalContent = el;
					el.style.display = 'none';
				}
			}
		}

		createViewerIframe(content, sidecarContent);
		isRendered = true;

		if (btn) updateButtonState();
	} catch (err: any) {
		const message = err?.message || String(err);
		if (btn) {
			btn.textContent = `Error: ${message}`;
			setTimeout(() => updateButtonState(), 3000);
		}
	}
}

function showViewer() {
	if (viewerIframe) viewerIframe.style.display = '';
	// Hide code content
	if (hiddenSiblings.length > 0) {
		for (const el of hiddenSiblings) {
			el.style.display = 'none';
		}
	} else if (originalContent) {
		originalContent.style.display = 'none';
	}
}

function hideViewer() {
	if (viewerIframe) viewerIframe.style.display = 'none';
	// Restore code content
	if (hiddenSiblings.length > 0) {
		for (const el of hiddenSiblings) {
			el.style.display = '';
		}
	} else if (originalContent) {
		originalContent.style.display = '';
	}
}

// ---- Viewer iframe ----

function createViewerIframe(content: string, sidecarContent: string | null) {
	if (!currentProvider || !currentFile) return;

	viewerIframe = document.createElement('iframe');
	viewerIframe.className = 'kusto-workbench-viewer-iframe';

	const viewerUrl = chrome.runtime.getURL('viewer.html');
	viewerIframe.src = viewerUrl;
	viewerIframe.style.width = '100%';
	viewerIframe.style.border = 'none';
	viewerIframe.style.minHeight = '600px';

	viewerIframe.onload = () => {
		// Detect host page background color so the viewer can match it
		let hostBackgroundColor: string | undefined;
		try {
			const bodyBg = getComputedStyle(document.body).backgroundColor;
			if (bodyBg && bodyBg !== 'rgba(0, 0, 0, 0)' && bodyBg !== 'transparent') {
				hostBackgroundColor = bodyBg;
			}
		} catch { /* ignore */ }

		viewerIframe?.contentWindow?.postMessage({
			type: 'kusto-workbench-load-file',
			filename: currentFile!.filename,
			content,
			sidecarContent,
			pageUrl: currentFile!.pageUrl,
			sourceLabel: currentFile!.sourceLabel,
			hostBackgroundColor,
		}, '*');

		window.addEventListener('message', handleViewerMessage);
	};

	// Tab mode: insert after the header anchor
	if (iframeAnchor && iframeAnchor.parentNode) {
		iframeAnchor.parentNode.insertBefore(viewerIframe, iframeAnchor.nextSibling);
	} else if (originalContent && originalContent.parentNode) {
		// Button mode: insert after the hidden content
		originalContent.parentNode.insertBefore(viewerIframe, originalContent.nextSibling);
	} else {
		document.body.appendChild(viewerIframe);
	}
}

function handleViewerMessage(event: MessageEvent) {
	if (!event.data || typeof event.data !== 'object') return;

	switch (event.data.type) {
		case 'kusto-workbench-csv-download': {
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
			if (viewerIframe && typeof event.data.height === 'number') {
				viewerIframe.style.height = event.data.height + 'px';
			}
			break;
		}
	}
}

// ---- Fetch helper ----

async function fetchContent(url: string): Promise<string> {
	const response = await fetch(url, {
		credentials: 'same-origin', // same-origin sends cookies for the initial request (e.g. github.com)
		redirect: 'follow',         // but not for cross-origin redirects (e.g. raw.githubusercontent.com)
		headers: {
			'Accept': 'text/plain, application/json, */*',
		},
	});

	if (!response.ok) {
		throw new Error(`HTTP ${response.status}: ${response.statusText}`);
	}

	return response.text();
}

// ---- Utility ----

function escapeHtml(str: string): string {
	const div = document.createElement('div');
	div.textContent = str;
	return div.innerHTML;
}

// ---- Styles ----

let stylesInjected = false;

function injectStyles() {
	if (stylesInjected) return;
	stylesInjected = true;

	const style = document.createElement('style');
	style.textContent = `
		/* ---- Fallback render button ---- */
		.kusto-workbench-render-bar {
			padding: 8px 16px;
			border: 1px solid #d0d7de;
			border-radius: 6px;
			margin: 8px 0;
			background: #f6f8fa;
			font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
		}

		.kusto-workbench-render-bar-inner {
			display: flex;
			align-items: center;
			gap: 12px;
		}

		.kusto-workbench-render-btn {
			display: inline-flex;
			align-items: center;
			gap: 6px;
			padding: 5px 12px;
			font-size: 12px;
			font-weight: 500;
			line-height: 20px;
			color: #fff;
			background-color: #0969da;
			border: 1px solid rgba(27,31,36,.15);
			border-radius: 6px;
			cursor: pointer;
			white-space: nowrap;
		}

		.kusto-workbench-render-btn:hover {
			background-color: #0860ca;
		}

		.kusto-workbench-render-btn:disabled {
			opacity: 0.6;
			cursor: wait;
		}

		.kusto-workbench-render-file {
			font-size: 12px;
			color: #656d76;
			font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}

		/* ---- Viewer iframe ---- */
		.kusto-workbench-viewer-iframe {
			width: 100%;
			box-sizing: border-box;
			border: none;
			border-radius: 6px;
			min-height: 600px;
		}

		/* Dark mode */
		@media (prefers-color-scheme: dark) {
			.kusto-workbench-render-bar {
				background: #161b22;
				border-color: #30363d;
			}

			.kusto-workbench-render-btn {
				background-color: #238636;
				border-color: rgba(240,246,252,.1);
			}

			.kusto-workbench-render-btn:hover {
				background-color: #2ea043;
			}

			.kusto-workbench-render-file {
				color: #8b949e;
			}
		}
	`;
	document.head.appendChild(style);
}

// ---- Boot ----

if (document.readyState === 'loading') {
	document.addEventListener('DOMContentLoaded', init);
} else {
	init();
}
