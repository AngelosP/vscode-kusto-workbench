import { FileSourceProvider, DetectedFile, ViewModeTabBarInfo, isSupportedFile, getFilenameFromUrl } from './types';

/**
 * GitHub provider — detects .kqlx/.kql/.csl files on github.com blob pages
 * and raw.githubusercontent.com.
 *
 * URL patterns:
 *   https://github.com/{owner}/{repo}/blob/{ref}/{path}
 *   https://raw.githubusercontent.com/{owner}/{repo}/{ref}/{path}
 */
export class GitHubProvider implements FileSourceProvider {
	readonly id = 'github';
	readonly label = 'GitHub';

	canHandle(url: URL): boolean {
		const host = url.hostname.toLowerCase();
		return host === 'github.com' || host === 'raw.githubusercontent.com';
	}

	getFileInfo(url: URL): DetectedFile | null {
		const host = url.hostname.toLowerCase();
		const filename = getFilenameFromUrl(url);

		if (!isSupportedFile(filename)) return null;

		if (host === 'raw.githubusercontent.com') {
			return {
				filename,
				rawContentUrl: url.href,
				sidecarUrl: this.getSidecarUrl(url.href, filename),
				pageUrl: url.href,
				sourceLabel: this.label,
			};
		}

		// github.com/{owner}/{repo}/blob/{ref}/{path...}
		const parts = url.pathname.split('/').filter(Boolean);
		if (parts.length < 5 || parts[2] !== 'blob') return null;

		const [owner, repo, , ref, ...pathParts] = parts;
		// Use github.com/…/raw/… (same origin) instead of raw.githubusercontent.com
		// so the browser sends the user's github.com cookies — critical for private repos.
		const rawUrl = `https://github.com/${owner}/${repo}/raw/${ref}/${pathParts.join('/')}`;

		return {
			filename,
			rawContentUrl: rawUrl,
			sidecarUrl: this.getSidecarUrl(rawUrl, filename),
			pageUrl: url.href,
			sourceLabel: this.label,
		};
	}

	getContentAreaSelector(): string | null {
		// GitHub's blob view renders into several possible containers
		// depending on the UI version. Try the most common selectors.
		// React-based (new UI 2024+):
		//   div[data-testid="blob-container"]  or  .react-blob-print-hide
		// Classic:
		//   .blob-wrapper  or  .Box-body.p-0  or  .js-blob-code-container
		const selectors = [
			'[data-testid="repo-content-pjax-container"]',
			'.react-blob-print-hide',
			'.blob-wrapper',
			'.Box-body.p-0',
			'.js-blob-code-container',
			'[data-target="readme-toc.content"]',
			'main .Box',
		];

		for (const sel of selectors) {
			if (document.querySelector(sel)) return sel;
		}
		return null;
	}

	getActionBarSelector(): string | null {
		// Insert the render button in the file header bar
		const selectors = [
			'[data-testid="latest-commit"]',
			'.file-navigation',
			'.js-file-header',
			'.Box-header',
		];
		for (const sel of selectors) {
			if (document.querySelector(sel)) return sel;
		}
		return null;
	}

	getViewModeTabBar(): ViewModeTabBarInfo | null {
		// Strategy 1: GitHub's Primer SegmentedControl for Code/Blame.
		// The <ul aria-label="File view"> is the most reliable selector.
		const segCtrl = document.querySelector('ul[aria-label="File view"]') as HTMLElement | null;
		if (segCtrl) {
			const items = Array.from(segCtrl.querySelectorAll('li'));
			// Each <li> contains a <button> — we want the <li> elements as tabs
			// because that's where data-selected lives.
			const codeItem = items.find(li => {
				const btn = li.querySelector('button');
				return btn && btn.textContent?.trim() === 'Code';
			});
			const blameItem = items.find(li => {
				const btn = li.querySelector('button');
				return btn && btn.textContent?.trim() === 'Blame';
			});
			if (codeItem && blameItem) {
				return { container: segCtrl, existingTabs: [codeItem, blameItem] };
			}
		}

		// Strategy 2: Look for a [role="tablist"] with Code and Blame.
		const tabLists = document.querySelectorAll('[role="tablist"]');
		for (const tabList of Array.from(tabLists)) {
			const tabs = Array.from(tabList.querySelectorAll('[role="tab"]'));
			const codeTab = tabs.find(t => t.textContent?.trim() === 'Code') as HTMLElement | undefined;
			const blameTab = tabs.find(t => t.textContent?.trim() === 'Blame') as HTMLElement | undefined;
			if (codeTab && blameTab) {
				return { container: tabList as HTMLElement, existingTabs: [codeTab, blameTab] };
			}
		}

		// Strategy 3: SegmentedControl by class prefix (fallback for minified class names).
		const segCtrlByClass = document.querySelector('[class*="SegmentedControl-SegmentedControl"]') as HTMLElement | null;
		if (segCtrlByClass) {
			const buttons = Array.from(segCtrlByClass.querySelectorAll('button'));
			const codeBtn = buttons.find(b => b.textContent?.trim() === 'Code');
			const blameBtn = buttons.find(b => b.textContent?.trim() === 'Blame');
			if (codeBtn && blameBtn) {
				// Return the <li> parents if they exist, otherwise the buttons
				const codeItem = (codeBtn.closest('li') || codeBtn) as HTMLElement;
				const blameItem = (blameBtn.closest('li') || blameBtn) as HTMLElement;
				return { container: segCtrlByClass, existingTabs: [codeItem, blameItem] };
			}
		}

		return null;
	}

	observeNavigation(callback: () => void): () => void {
		// GitHub uses Turbo (formerly Turbolinks/PJAX) for SPA navigation.
		// Listen for turbo:load which fires after each navigation.
		const turboHandler = () => callback();
		document.addEventListener('turbo:load', turboHandler);

		// Also observe URL changes via popstate (browser back/forward)
		const popstateHandler = () => callback();
		window.addEventListener('popstate', popstateHandler);

		// MutationObserver as fallback — watches for main content changes
		let lastUrl = location.href;
		const observer = new MutationObserver(() => {
			if (location.href !== lastUrl) {
				lastUrl = location.href;
				callback();
			}
		});
		observer.observe(document.documentElement, { childList: true, subtree: true });

		return () => {
			document.removeEventListener('turbo:load', turboHandler);
			window.removeEventListener('popstate', popstateHandler);
			observer.disconnect();
		};
	}

	/** Compute the sidecar URL for .kql/.csl files. */
	private getSidecarUrl(rawUrl: string, filename: string): string | undefined {
		const lower = filename.toLowerCase();
		if (lower.endsWith('.kql') || lower.endsWith('.csl')) {
			return rawUrl + '.json';
		}
		return undefined;
	}
}
