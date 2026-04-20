/**
 * Provider interface for detecting and fetching supported files from different
 * web platforms (GitHub, Azure DevOps, raw URLs, etc.).
 *
 * Each provider encapsulates all platform-specific logic:
 * - URL pattern matching
 * - Raw content URL construction
 * - Page DOM interaction (where to inject UI, where the file content area is)
 * - SPA navigation awareness
 *
 * To add support for a new platform, implement this interface and register it
 * in the provider registry.
 */

/** Information about a detected file on the current page. */
export interface DetectedFile {
	/** The raw filename, e.g. "my-queries.kqlx" */
	filename: string;

	/** URL to fetch the raw file content (the browser's cookies will be sent automatically). */
	rawContentUrl: string;

	/** Optional URL to fetch a sidecar file (e.g. .kql.json companion). */
	sidecarUrl?: string;

	/** The original page URL for reference / display. */
	pageUrl: string;

	/** Human-readable label for the source, e.g. "GitHub", "Azure DevOps". */
	sourceLabel: string;
}

export interface FileSourceProvider {
	/** Unique identifier for this provider (e.g. "github", "azure-devops", "raw-url"). */
	readonly id: string;

	/** Human-readable name shown in UI (e.g. "GitHub", "Azure DevOps"). */
	readonly label: string;

	/**
	 * Test whether this provider can handle the given URL.
	 * Should be fast — called on every navigation.
	 */
	canHandle(url: URL): boolean;

	/**
	 * Extract file information from the current page URL.
	 * Only called if canHandle() returned true.
	 * Returns null if the URL points to a supported domain but not a supported file.
	 */
	getFileInfo(url: URL): DetectedFile | null;

	/**
	 * Return a CSS selector for the DOM element that should be replaced
	 * with the Kusto Workbench viewer (the file content area).
	 * If the element is not yet in the DOM (SPA still loading), return null.
	 */
	getContentAreaSelector(): string | null;

	/**
	 * Return a CSS selector or element where the "Render in Kusto Workbench"
	 * button should be inserted.
	 * If null, the button is inserted just above the content area.
	 */
	getActionBarSelector(): string | null;

	/**
	 * Find the view-mode tab bar (e.g. "Code | Blame" on GitHub) and return
	 * the container element plus info about how to create a matching tab.
	 * Returns null if the platform doesn't have a tab bar UI.
	 */
	getViewModeTabBar(): ViewModeTabBarInfo | null;

	/**
	 * Whether this page can potentially have a tab bar.
	 * Returns false for pages where we know there is no tab bar (e.g. raw URLs),
	 * so the content script can skip retries and fall back immediately.
	 * Default behavior if not implemented: true.
	 */
	supportsTabBar?(): boolean;

	/**
	 * Whether this page requires opening the viewer in a new tab instead of
	 * an inline iframe. Needed for pages with sandbox CSP headers (e.g.
	 * raw.githubusercontent.com) where iframes can't run scripts.
	 * Default behavior if not implemented: false.
	 */
	requiresNewTabViewer?(): boolean;

	/**
	 * Register a callback that fires whenever the page navigates (SPA-aware).
	 * Returns a cleanup function to unregister.
	 */
	observeNavigation(callback: () => void): () => void;
}

/** Info about the platform's view-mode tab bar for injecting a custom tab. */
export interface ViewModeTabBarInfo {
	/** The tab bar container element (direct parent or grandparent of the tabs). */
	container: HTMLElement;
	/** All existing clickable tab elements (e.g. the "Code" and "Blame" buttons). */
	existingTabs: HTMLElement[];
}

/** Supported file extensions (lowercase). */
export const SUPPORTED_EXTENSIONS = ['.kqlx', '.sqlx', '.kql', '.csl', '.kql.json', '.csl.json'] as const;

/** Check if a filename has a supported extension. */
export function isSupportedFile(filename: string): boolean {
	const lower = filename.toLowerCase();
	return SUPPORTED_EXTENSIONS.some(ext => lower.endsWith(ext));
}

/** Extract the filename from a URL path. */
export function getFilenameFromUrl(url: URL): string {
	const parts = url.pathname.split('/').filter(Boolean);
	return parts[parts.length - 1] || '';
}
