import { FileSourceProvider, DetectedFile, isSupportedFile, getFilenameFromUrl } from './types';

/**
 * Raw URL provider — catches any URL that directly serves a supported file.
 * This is the fallback provider and should be registered last.
 *
 * Examples:
 *   https://raw.githubusercontent.com/owner/repo/main/file.kqlx
 *   https://example.com/path/to/file.kqlx
 *   file:///C:/path/to/file.kql (local files if allowed)
 *
 * Note: raw.githubusercontent.com is also handled by the GitHub provider,
 * which will match first in the registry. This provider catches other raw URLs.
 */
export class RawUrlProvider implements FileSourceProvider {
	readonly id = 'raw-url';
	readonly label = 'Direct Link';

	canHandle(url: URL): boolean {
		const filename = getFilenameFromUrl(url);
		return isSupportedFile(filename);
	}

	getFileInfo(url: URL): DetectedFile | null {
		const filename = getFilenameFromUrl(url);
		if (!isSupportedFile(filename)) return null;

		return {
			filename,
			rawContentUrl: url.href,
			sidecarUrl: this.getSidecarUrl(url.href, filename),
			pageUrl: url.href,
			sourceLabel: this.label,
		};
	}

	getContentAreaSelector(): string | null {
		// For raw files, the entire body is the content.
		// We'll check for a <pre> tag (common for raw text) or just use body.
		if (document.querySelector('pre')) return 'pre';
		return 'body';
	}

	getActionBarSelector(): string | null {
		// No action bar for raw files — button goes at the top of the body.
		return null;
	}

	getViewModeTabBar() {
		// Raw file pages don't have a tab bar.
		return null;
	}

	observeNavigation(callback: () => void): () => void {
		// Raw file URLs are not SPAs — standard page load is enough.
		// Still listen for popstate in case of hash/pushState navigation.
		const handler = () => callback();
		window.addEventListener('popstate', handler);
		return () => window.removeEventListener('popstate', handler);
	}

	private getSidecarUrl(rawUrl: string, filename: string): string | undefined {
		const lower = filename.toLowerCase();
		if (lower.endsWith('.kql') || lower.endsWith('.csl')) {
			return rawUrl + '.json';
		}
		return undefined;
	}
}
