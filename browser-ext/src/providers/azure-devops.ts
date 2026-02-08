import { FileSourceProvider, DetectedFile, isSupportedFile } from './types';

/**
 * Azure DevOps provider — detects .kqlx/.kql/.csl files in Azure DevOps
 * repository file views.
 *
 * URL patterns:
 *   https://dev.azure.com/{org}/{project}/_git/{repo}?path=/{filepath}&version=GB{branch}
 *   https://{org}.visualstudio.com/{project}/_git/{repo}?path=...
 */
export class AzureDevOpsProvider implements FileSourceProvider {
	readonly id = 'azure-devops';
	readonly label = 'Azure DevOps';

	canHandle(url: URL): boolean {
		const host = url.hostname.toLowerCase();
		return host === 'dev.azure.com' || host.endsWith('.visualstudio.com');
	}

	getFileInfo(url: URL): DetectedFile | null {
		const filePath = url.searchParams.get('path');
		if (!filePath) return null;

		const filename = filePath.split('/').filter(Boolean).pop() || '';
		if (!isSupportedFile(filename)) return null;

		const rawContentUrl = this.buildRawUrl(url, filePath);
		if (!rawContentUrl) return null;

		return {
			filename,
			rawContentUrl,
			sidecarUrl: this.getSidecarUrl(rawContentUrl, filename),
			pageUrl: url.href,
			sourceLabel: this.label,
		};
	}

	getContentAreaSelector(): string | null {
		// Azure DevOps renders files in a Monaco editor or a preview pane.
		const selectors = [
			'.repos-file-viewer',
			'.file-content',
			'.bolt-card-content',
			'.file-viewer',
			'.vc-file-viewer',
		];
		for (const sel of selectors) {
			if (document.querySelector(sel)) return sel;
		}
		return null;
	}

	getActionBarSelector(): string | null {
		const selectors = [
			'.repos-file-header',
			'.file-header',
			'.bolt-header-commandbar',
		];
		for (const sel of selectors) {
			if (document.querySelector(sel)) return sel;
		}
		return null;
	}

	getViewModeTabBar() {
		// ADO doesn't have a Code/Blame-style tab bar (yet).
		return null;
	}

	observeNavigation(callback: () => void): () => void {
		// Azure DevOps is a full SPA — no turbo:load. We need pushState interception
		// plus MutationObserver.

		// Intercept pushState/replaceState
		const origPush = history.pushState.bind(history);
		const origReplace = history.replaceState.bind(history);
		let lastUrl = location.href;

		history.pushState = function (...args) {
			origPush(...args);
			if (location.href !== lastUrl) {
				lastUrl = location.href;
				callback();
			}
		};
		history.replaceState = function (...args) {
			origReplace(...args);
			if (location.href !== lastUrl) {
				lastUrl = location.href;
				callback();
			}
		};

		const popstateHandler = () => {
			if (location.href !== lastUrl) {
				lastUrl = location.href;
				callback();
			}
		};
		window.addEventListener('popstate', popstateHandler);

		return () => {
			history.pushState = origPush;
			history.replaceState = origReplace;
			window.removeEventListener('popstate', popstateHandler);
		};
	}

	/** Build a raw content URL using the Azure DevOps REST API. */
	private buildRawUrl(url: URL, filePath: string): string | null {
		const host = url.hostname.toLowerCase();

		// Extract version (branch) from ?version=GBmain → main
		const versionParam = url.searchParams.get('version') || '';
		const branch = versionParam.startsWith('GB') ? versionParam.slice(2) : 'main';

		if (host === 'dev.azure.com') {
			// dev.azure.com/{org}/{project}/_git/{repo}
			const parts = url.pathname.split('/').filter(Boolean);
			if (parts.length < 4 || parts[2] !== '_git') return null;
			const [org, project, , repo] = parts;

			return `https://dev.azure.com/${org}/${project}/_apis/git/repositories/${repo}/items` +
				`?path=${encodeURIComponent(filePath)}` +
				`&versionDescriptor[version]=${encodeURIComponent(branch)}` +
				`&versionDescriptor[versionType]=branch` +
				`&$format=text`;
		}

		if (host.endsWith('.visualstudio.com')) {
			// {org}.visualstudio.com/{project}/_git/{repo}
			const org = host.replace('.visualstudio.com', '');
			const parts = url.pathname.split('/').filter(Boolean);
			if (parts.length < 3 || parts[1] !== '_git') return null;
			const [project, , repo] = parts;

			return `https://dev.azure.com/${org}/${project}/_apis/git/repositories/${repo}/items` +
				`?path=${encodeURIComponent(filePath)}` +
				`&versionDescriptor[version]=${encodeURIComponent(branch)}` +
				`&versionDescriptor[versionType]=branch` +
				`&$format=text`;
		}

		return null;
	}

	private getSidecarUrl(rawUrl: string, filename: string): string | undefined {
		const lower = filename.toLowerCase();
		if (lower.endsWith('.kql') || lower.endsWith('.csl')) {
			// For ADO API URLs, modify the path parameter
			try {
				const parsed = new URL(rawUrl);
				const currentPath = parsed.searchParams.get('path') || '';
				parsed.searchParams.set('path', currentPath + '.json');
				return parsed.toString();
			} catch {
				return undefined;
			}
		}
		return undefined;
	}
}
