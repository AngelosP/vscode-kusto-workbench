import * as vscode from 'vscode';
import { createHash } from 'crypto';
import {
	TUTORIAL_CATALOG_SCHEMA_VERSION,
	toTutorialViewerCatalog,
	validateTutorialCatalog,
	type TutorialCatalog,
	type TutorialCatalogValidationResult,
	type TutorialItem,
	type TutorialViewerStatus,
} from '../../shared/tutorials/tutorialCatalog';
import { BUILT_IN_TUTORIAL_CATALOG, BUILT_IN_TUTORIAL_CONTENT_PATHS, REMOTE_TUTORIAL_FALLBACK_CONTENT_PATHS } from './builtInTutorialCatalog';

const DEFAULT_CATALOG_URL = 'https://raw.githubusercontent.com/AngelosP/vscode-kusto-workbench/main/docs/tutorials/catalog.v1.json';
const CATALOG_CACHE_FILE = 'catalog-cache.v1.json';
const MAX_CATALOG_BYTES = 512 * 1024;
const MAX_MARKDOWN_BYTES = 1024 * 1024;
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 8000;

interface CatalogCacheFile {
	fetchedAt: string;
	updatedAt?: string;
	etag?: string;
	sourceUrl?: string;
	catalog: unknown;
}

interface TutorialSettings {
	catalogUrl: string;
	enableUpdateChecks: boolean;
	refreshIntervalHours: number;
}

export interface ResolvedTutorialCatalog {
	catalog: TutorialCatalog;
	validation: TutorialCatalogValidationResult;
	source: TutorialViewerStatus['source'];
	stale: boolean;
	lastUpdated?: string;
	catalogUrl?: string;
	errors: string[];
	warnings: string[];
}

export interface TutorialContentResult {
	tutorialId: string;
	markdown: string;
	source: 'remote' | 'cache' | 'builtIn';
	errors: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
}

export function redactTutorialUrl(value: string): string {
	try {
		const parsed = new URL(value);
		parsed.search = '';
		parsed.hash = '';
		return parsed.toString().replace(/(token|access[_-]?token|sig|signature|code)=([^/&]+)/gi, '$1=<redacted>');
	} catch {
		return value.replace(/[?#].*$/, '').replace(/(token|access[_-]?token|sig|signature|code)=([^/&]+)/gi, '$1=<redacted>');
	}
}

export class TutorialCatalogService {
	private readonly cacheRoot: vscode.Uri;
	private inFlightCatalog: Promise<ResolvedTutorialCatalog> | null = null;
	private latestCatalog: ResolvedTutorialCatalog | null = null;

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly extensionUri: vscode.Uri,
	) {
		this.cacheRoot = vscode.Uri.joinPath(context.globalStorageUri, 'tutorials');
	}

	get installedVersion(): string {
		const packageJson = this.context.extension.packageJSON as { version?: string };
		return packageJson.version || '0.0.0-placeholder';
	}

	getCacheRoot(): vscode.Uri {
		return this.cacheRoot;
	}

	getDefaultCatalogUrl(): string {
		return DEFAULT_CATALOG_URL;
	}

	getSettings(): TutorialSettings {
		const config = vscode.workspace.getConfiguration('kustoWorkbench');
		const catalogUrl = String(config.get('tutorials.catalogUrl', DEFAULT_CATALOG_URL) || '').trim();
		const enableUpdateChecks = !!config.get('tutorials.enableUpdateChecks', true);
		const refreshIntervalHours = Math.max(1, Number(config.get('tutorials.refreshIntervalHours', 24)) || 24);
		return { catalogUrl, enableUpdateChecks, refreshIntervalHours };
	}

	async getCatalog(options: { forceRefresh?: boolean } = {}): Promise<ResolvedTutorialCatalog> {
		if (this.inFlightCatalog && !options.forceRefresh) {
			return this.inFlightCatalog;
		}
		this.inFlightCatalog = this.resolveCatalog(options).finally(() => {
			this.inFlightCatalog = null;
		});
		this.latestCatalog = await this.inFlightCatalog;
		return this.latestCatalog;
	}

	async getViewerCatalog(options: { forceRefresh?: boolean } = {}) {
		const resolved = await this.getCatalog(options);
		return {
			catalog: toTutorialViewerCatalog(resolved.catalog, this.installedVersion),
			status: this.toStatus(resolved),
		};
	}

	async getTutorialContent(tutorialId: string, webview: vscode.Webview): Promise<TutorialContentResult> {
		const resolved = this.latestCatalog ?? await this.getCatalog();
		const tutorial = resolved.catalog.tutorials.find(candidate => candidate.id === tutorialId);
		if (!tutorial) {
			return { tutorialId, markdown: '', source: 'builtIn', errors: [`Unknown tutorial '${tutorialId}'.`] };
		}
		const errors: string[] = [];
		const contentSource = this.resolveContentSource(tutorial, resolved);

		if (contentSource.kind === 'remote') {
			try {
				const markdown = await this.fetchRemoteMarkdown(contentSource.url, tutorial.id);
				return {
					tutorialId,
					markdown: await this.rewriteMarkdownImages(markdown, { kind: 'remote', baseUrl: contentSource.url }, webview, errors),
					source: 'remote',
					errors,
				};
			} catch (error) {
				errors.push(`Could not load remote tutorial content: ${this.messageFromError(error)}`);
				const cached = await this.readTextCache(this.contentCacheName(contentSource.url));
				if (cached) {
					return {
						tutorialId,
						markdown: await this.rewriteMarkdownImages(cached, { kind: 'remote', baseUrl: contentSource.url }, webview, errors),
						source: 'cache',
						errors,
					};
				}
			}
		}

		const localPath = BUILT_IN_TUTORIAL_CONTENT_PATHS[tutorialId] ?? REMOTE_TUTORIAL_FALLBACK_CONTENT_PATHS[tutorialId] ?? (contentSource.kind === 'local' ? contentSource.path : undefined);
		if (!localPath) {
			return { tutorialId, markdown: '', source: 'builtIn', errors: [...errors, 'No built-in tutorial content is available.'] };
		}
		try {
			const markdown = await this.readExtensionText(localPath);
			return {
				tutorialId,
				markdown: await this.rewriteMarkdownImages(markdown, { kind: 'local', basePath: localPath }, webview, errors),
				source: 'builtIn',
				errors,
			};
		} catch (error) {
			return { tutorialId, markdown: '', source: 'builtIn', errors: [...errors, this.messageFromError(error)] };
		}
	}

	toStatus(resolved: ResolvedTutorialCatalog): TutorialViewerStatus {
		return {
			source: resolved.source,
			stale: resolved.stale,
			lastUpdated: resolved.lastUpdated,
			errors: resolved.errors,
			warnings: [...resolved.warnings, ...resolved.validation.warnings],
		};
	}

	private async resolveCatalog(options: { forceRefresh?: boolean }): Promise<ResolvedTutorialCatalog> {
		const settings = this.getSettings();
		const cached = await this.readCatalogCache(settings.catalogUrl);
		if (!settings.catalogUrl || !settings.enableUpdateChecks) {
			return cached ?? this.builtInCatalog(settings.catalogUrl ? ['Tutorial update checks are disabled.'] : []);
		}
		if (!options.forceRefresh && cached && !this.isCacheExpired(cached.lastUpdated, settings.refreshIntervalHours)) {
			return cached;
		}

		try {
			return await this.fetchCatalog(settings.catalogUrl, cached?.validation.catalog ? cached.validation : null);
		} catch (error) {
			const message = `Could not refresh tutorial catalog from ${redactTutorialUrl(settings.catalogUrl)}: ${this.messageFromError(error)}`;
			console.warn(`[Kusto Workbench] ${message}`);
			if (cached) {
				return { ...cached, stale: true, errors: [...cached.errors, message] };
			}
			return this.builtInCatalog([message]);
		}
	}

	private async fetchCatalog(catalogUrl: string, cachedValidation: TutorialCatalogValidationResult | null): Promise<ResolvedTutorialCatalog> {
		if (!this.isAllowedRemoteUrl(catalogUrl)) {
			throw new Error('Tutorial catalog URL must be hosted on github.com or raw.githubusercontent.com.');
		}
		const headers: Record<string, string> = { Accept: 'application/json' };
		const cachedEtag = cachedValidation?.catalog ? await this.readCachedEtag(catalogUrl) : undefined;
		if (cachedEtag) {
			headers['If-None-Match'] = cachedEtag;
		}
		const response = await this.fetchWithTimeout(catalogUrl, { headers });
		if (response.status === 304) {
			const cached = await this.readCatalogCache(catalogUrl);
			if (cached) {
				return { ...cached, source: 'remote', stale: false };
			}
		}
		if (!response.ok) {
			throw new Error(`HTTP ${response.status}`);
		}
		const text = await this.responseTextWithLimit(response, MAX_CATALOG_BYTES, 'catalog');
		const parsed = JSON.parse(text) as unknown;
		const validation = validateTutorialCatalog(parsed, this.installedVersion);
		if (!validation.catalog) {
			throw new Error(validation.errors.join(' '));
		}
		const lastUpdated = new Date().toISOString();
		const etag = response.headers.get('etag') ?? undefined;
		await this.writeCatalogCache({ fetchedAt: lastUpdated, updatedAt: lastUpdated, etag, sourceUrl: catalogUrl, catalog: parsed });
		if (etag) {
			await this.writeTextCache(this.etagCacheName(catalogUrl), etag);
		}
		return {
			catalog: validation.catalog,
			validation,
			source: 'remote',
			stale: false,
			lastUpdated,
			catalogUrl,
			errors: [],
			warnings: validation.warnings,
		};
	}

	private builtInCatalog(errors: string[] = []): ResolvedTutorialCatalog {
		const validation = validateTutorialCatalog(BUILT_IN_TUTORIAL_CATALOG, this.installedVersion);
		return {
			catalog: validation.catalog ?? BUILT_IN_TUTORIAL_CATALOG,
			validation,
			source: 'builtIn',
			stale: false,
			lastUpdated: BUILT_IN_TUTORIAL_CATALOG.generatedAt,
			errors: [...errors, ...validation.errors],
			warnings: validation.warnings,
		};
	}

	private async readCatalogCache(expectedSourceUrl: string): Promise<ResolvedTutorialCatalog | null> {
		const file = await this.readJsonCache(CATALOG_CACHE_FILE);
		if (!isRecord(file) || !('catalog' in file)) {
			return null;
		}
		if (expectedSourceUrl && asString(file.sourceUrl) && file.sourceUrl !== expectedSourceUrl) {
			return null;
		}
		const validation = validateTutorialCatalog(file.catalog, this.installedVersion);
		if (!validation.catalog) {
			return null;
		}
		return {
			catalog: validation.catalog,
			validation,
			source: 'cache',
			stale: false,
			lastUpdated: asString(file.updatedAt) ?? asString(file.fetchedAt),
			catalogUrl: asString(file.sourceUrl),
			errors: [],
			warnings: validation.warnings,
		};
	}

	private async writeCatalogCache(cache: CatalogCacheFile): Promise<void> {
		await this.writeJsonCache(CATALOG_CACHE_FILE, cache);
	}

	private isCacheExpired(lastUpdated: string | undefined, refreshIntervalHours: number): boolean {
		if (!lastUpdated) {
			return true;
		}
		const updatedAt = Date.parse(lastUpdated);
		if (!Number.isFinite(updatedAt)) {
			return true;
		}
		return Date.now() - updatedAt > refreshIntervalHours * 60 * 60 * 1000;
	}

	private resolveContentSource(tutorial: TutorialItem, resolved: ResolvedTutorialCatalog): { kind: 'remote'; url: string } | { kind: 'local'; path: string } {
		const contentUrl = tutorial.contentUrl;
		if (/^https?:\/\//i.test(contentUrl)) {
			return { kind: 'remote', url: contentUrl };
		}
		if (resolved.catalogUrl && /^https?:\/\//i.test(resolved.catalogUrl)) {
			return { kind: 'remote', url: new URL(contentUrl, resolved.catalogUrl).toString() };
		}
		return { kind: 'local', path: contentUrl };
	}

	private async fetchRemoteMarkdown(url: string, tutorialId: string): Promise<string> {
		if (!this.isAllowedRemoteUrl(url)) {
			throw new Error('Tutorial content URL must be hosted on github.com or raw.githubusercontent.com.');
		}
		const response = await this.fetchWithTimeout(url, { headers: { Accept: 'text/markdown,text/plain,*/*' } });
		if (!response.ok) {
			throw new Error(`HTTP ${response.status} for ${redactTutorialUrl(url)}`);
		}
		const markdown = await this.responseTextWithLimit(response, MAX_MARKDOWN_BYTES, 'tutorial');
		await this.writeTextCache(this.contentCacheName(url), markdown);
		await this.writeTextCache(`content-by-id-${this.cacheKey(tutorialId)}.md`, markdown);
		return markdown;
	}

	private async rewriteMarkdownImages(
		markdown: string,
		base: { kind: 'remote'; baseUrl: string } | { kind: 'local'; basePath: string },
		webview: vscode.Webview,
		errors: string[],
	): Promise<string> {
		const imageSources = this.findMarkdownImageSources(markdown);
		let rewritten = markdown;
		const replacements = new Map<string, string | null>();
		for (const imageSource of imageSources) {
			const replacement = await this.resolveImageSource(imageSource, base, webview, errors);
			replacements.set(imageSource, replacement);
		}
		return rewritten.replace(/!\[([^\]]*)\]\(([^)\s]+)(\s+"[^"]*")?\)/g, (match, altText: string, rawSource: string, title: string | undefined) => {
			const replacement = replacements.get(rawSource.trim());
			if (replacement === undefined) {
				return match;
			}
			return replacement ? `![${altText}](${replacement}${title ?? ''})` : '';
		});
	}

	private findMarkdownImageSources(markdown: string): string[] {
		const sources = new Set<string>();
		const imagePattern = /!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
		let match: RegExpExecArray | null;
		while ((match = imagePattern.exec(markdown)) !== null) {
			sources.add(match[1].trim());
		}
		return [...sources];
	}

	private async resolveImageSource(
		source: string,
		base: { kind: 'remote'; baseUrl: string } | { kind: 'local'; basePath: string },
		webview: vscode.Webview,
		errors: string[],
	): Promise<string | null> {
		const normalized = source.trim();
		if (!normalized || /^(data|file|command|javascript|vscode|vscode-insiders):/i.test(normalized) || normalized.toLowerCase().includes('.svg')) {
			errors.push(`Blocked tutorial image source '${normalized}'.`);
			return null;
		}
		if (/^https?:\/\//i.test(normalized) || base.kind === 'remote') {
			const imageUrl = /^https?:\/\//i.test(normalized)
				? normalized
				: base.kind === 'remote'
					? new URL(normalized, base.baseUrl).toString()
					: normalized;
			try {
				return (await this.fetchAndCacheImage(imageUrl, webview))?.toString() ?? null;
			} catch (error) {
				errors.push(`Could not cache tutorial image ${redactTutorialUrl(imageUrl)}: ${this.messageFromError(error)}`);
				return null;
			}
		}

		if (normalized.startsWith('/') || normalized.split('/').includes('..')) {
			errors.push(`Blocked tutorial image source '${normalized}'.`);
			return null;
		}
		const baseSegments = base.basePath.split('/').slice(0, -1);
		const localUri = vscode.Uri.joinPath(this.extensionUri, ...baseSegments, normalized);
		return webview.asWebviewUri(localUri).toString();
	}

	private async fetchAndCacheImage(imageUrl: string, webview: vscode.Webview): Promise<vscode.Uri | null> {
		if (!this.isAllowedRemoteUrl(imageUrl)) {
			throw new Error('tutorial images must be hosted on github.com or raw.githubusercontent.com');
		}
		const response = await this.fetchWithTimeout(imageUrl, { headers: { Accept: 'image/png,image/jpeg,image/gif,image/webp,*/*' } });
		if (!response.ok) {
			throw new Error(`HTTP ${response.status}`);
		}
		const contentType = response.headers.get('content-type') ?? '';
		if (/svg/i.test(contentType)) {
			throw new Error('SVG images are not allowed in tutorial content.');
		}
		const bytes = new Uint8Array(await response.arrayBuffer());
		if (bytes.byteLength > MAX_IMAGE_BYTES) {
			throw new Error('image is too large');
		}
		const extension = this.imageExtension(imageUrl, contentType);
		const imageUri = vscode.Uri.joinPath(this.cacheRoot, 'images', `${this.cacheKey(imageUrl)}.${extension}`);
		await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(this.cacheRoot, 'images'));
		await vscode.workspace.fs.writeFile(imageUri, bytes);
		return webview.asWebviewUri(imageUri);
	}

	private imageExtension(imageUrl: string, contentType: string): string {
		if (/png/i.test(contentType)) return 'png';
		if (/jpe?g/i.test(contentType)) return 'jpg';
		if (/gif/i.test(contentType)) return 'gif';
		if (/webp/i.test(contentType)) return 'webp';
		const pathname = (() => {
			try { return new URL(imageUrl).pathname.toLowerCase(); } catch { return ''; }
		})();
		if (pathname.endsWith('.png')) return 'png';
		if (pathname.endsWith('.jpg') || pathname.endsWith('.jpeg')) return 'jpg';
		if (pathname.endsWith('.gif')) return 'gif';
		if (pathname.endsWith('.webp')) return 'webp';
		return 'png';
	}

	private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
		try {
			return await fetch(url, { ...init, signal: controller.signal });
		} finally {
			clearTimeout(timeout);
		}
	}

	private isAllowedRemoteUrl(value: string): boolean {
		try {
			const parsed = new URL(value);
			if (parsed.protocol !== 'https:') {
				return false;
			}
			const host = parsed.hostname.toLowerCase();
			return host === 'raw.githubusercontent.com' || host === 'github.com';
		} catch {
			return false;
		}
	}

	private async responseTextWithLimit(response: Response, maxBytes: number, label: string): Promise<string> {
		const text = await response.text();
		if (new TextEncoder().encode(text).byteLength > maxBytes) {
			throw new Error(`${label} response is too large`);
		}
		return text;
	}

	private async readExtensionText(relativePath: string): Promise<string> {
		const safePath = relativePath.split('/').filter(segment => segment && segment !== '..');
		const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(this.extensionUri, ...safePath));
		return new TextDecoder().decode(bytes);
	}

	private async readJsonCache(fileName: string): Promise<unknown | null> {
		const text = await this.readTextCache(fileName);
		if (!text) {
			return null;
		}
		try {
			return JSON.parse(text) as unknown;
		} catch {
			return null;
		}
	}

	private async writeJsonCache(fileName: string, value: unknown): Promise<void> {
		await this.writeTextCache(fileName, JSON.stringify(value, null, 2));
	}

	private async readTextCache(fileName: string): Promise<string | null> {
		try {
			const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(this.cacheRoot, fileName));
			return new TextDecoder().decode(bytes);
		} catch {
			return null;
		}
	}

	private async writeTextCache(fileName: string, text: string): Promise<void> {
		await vscode.workspace.fs.createDirectory(this.cacheRoot);
		await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(this.cacheRoot, fileName), new TextEncoder().encode(text));
	}

	private async readCachedEtag(catalogUrl: string): Promise<string | undefined> {
		return await this.readTextCache(this.etagCacheName(catalogUrl)) ?? undefined;
	}

	private etagCacheName(catalogUrl: string): string {
		return `etag-${this.cacheKey(catalogUrl)}.txt`;
	}

	private contentCacheName(contentUrl: string): string {
		return `content-${this.cacheKey(contentUrl)}.md`;
	}

	private cacheKey(value: string): string {
		return createHash('sha256').update(value).digest('hex').slice(0, 32);
	}

	private messageFromError(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}
}
