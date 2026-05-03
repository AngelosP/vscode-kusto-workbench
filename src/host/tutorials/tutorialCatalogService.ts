import * as vscode from 'vscode';
import { createHash } from 'crypto';
import {
	TUTORIAL_CATALOG_SCHEMA_VERSION,
	TUTORIAL_CONNECTION_REQUIRED_MESSAGE,
	toTutorialViewerCatalog,
	validateTutorialCatalog,
	type TutorialCatalog,
	type TutorialCatalogValidationResult,
	type TutorialItem,
	type TutorialSummaryContent,
	type TutorialViewerStatus,
} from '../../shared/tutorials/tutorialCatalog';

const DEFAULT_CATALOG_URL = 'https://raw.githubusercontent.com/AngelosP/vscode-kusto-workbench/main/media/tutorials/catalog.v1.json';
const CATALOG_CACHE_FILE = 'catalog-cache.v1.json';
const MAX_CATALOG_BYTES = 512 * 1024;
const MAX_MARKDOWN_BYTES = 1024 * 1024;
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 8000;
const DEFAULT_REFRESH_INTERVAL_HOURS = 24;

interface CatalogCacheFile {
	fetchedAt: string;
	updatedAt?: string;
	etag?: string;
	sourceUrl?: string;
	catalog: unknown;
}

interface TutorialSettings {
	enabled: boolean;
	catalogUrl: string;
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
	source: 'remote' | 'cache' | 'localDevelopment' | 'unavailable';
	errors: string[];
}

type TutorialContentSource =
	| { kind: 'remote'; url: string }
	| { kind: 'localDevelopment'; uri: vscode.Uri; baseUri: vscode.Uri };

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

	getLocalDevelopmentCatalogUri(): vscode.Uri {
		return vscode.Uri.joinPath(this.context.extensionUri, 'media', 'tutorials', 'catalog.v1.json');
	}

	getSettings(): TutorialSettings {
		const config = vscode.workspace.getConfiguration('kustoWorkbench');
		const enabled = !!config.get('didYouKnow.enabled', true);
		return { enabled, catalogUrl: DEFAULT_CATALOG_URL, refreshIntervalHours: DEFAULT_REFRESH_INTERVAL_HOURS };
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
		const summaryContent = await this.resolveSummaryContent(resolved);
		return {
			catalog: toTutorialViewerCatalog(resolved.catalog, this.installedVersion, summaryContent),
			status: this.toStatus(resolved),
		};
	}

	async getTutorialContent(tutorialId: string, webview: vscode.Webview): Promise<TutorialContentResult> {
		const resolved = this.latestCatalog ?? await this.getCatalog();
		const tutorial = resolved.catalog.content.find(candidate => candidate.id === tutorialId);
		if (!tutorial) {
			return { tutorialId, markdown: '', source: 'unavailable', errors: [`Unknown tutorial '${tutorialId}'.`] };
		}
		const errors: string[] = [];
		const contentSource = this.resolveContentSource(tutorial, resolved);

		if (contentSource?.kind === 'localDevelopment') {
			try {
				const markdown = await this.readLocalDevelopmentText(contentSource.uri, MAX_MARKDOWN_BYTES, 'tutorial');
				return {
					tutorialId,
					markdown: await this.rewriteMarkdownImages(markdown, { kind: 'localDevelopment', baseUri: contentSource.baseUri }, webview, errors),
					source: 'localDevelopment',
					errors,
				};
			} catch (error) {
				errors.push(`Could not load local development tutorial content: ${this.messageFromError(error)}`);
			}
		}

		if (contentSource?.kind === 'remote') {
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
				const cached = await this.readCachedTutorialMarkdown(tutorial.id, contentSource.url);
				if (cached) {
					return {
						tutorialId,
						markdown: await this.rewriteMarkdownImages(cached, { kind: 'remote', baseUrl: contentSource.url }, webview, errors),
						source: 'cache',
						errors,
					};
				}
			}
		} else {
			const cached = await this.readCachedTutorialMarkdown(tutorial.id);
			if (cached) {
				return { tutorialId, markdown: cached, source: 'cache', errors };
			}
		}

		return { tutorialId, markdown: '', source: 'unavailable', errors: [...errors, TUTORIAL_CONNECTION_REQUIRED_MESSAGE] };
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
		if (this.isLocalDevelopmentMode()) {
			return await this.readLocalDevelopmentCatalog();
		}

		const settings = this.getSettings();
		const cached = await this.readCatalogCache(settings.catalogUrl);
		if (!settings.catalogUrl) {
			return cached ?? this.unavailableCatalog(['Tutorial catalog URL is not configured.']);
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
			return this.unavailableCatalog([message], settings.catalogUrl);
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

	private async readLocalDevelopmentCatalog(): Promise<ResolvedTutorialCatalog> {
		const catalogUri = this.getLocalDevelopmentCatalogUri();
		try {
			const text = await this.readLocalDevelopmentText(catalogUri, MAX_CATALOG_BYTES, 'catalog');
			const parsed = JSON.parse(text) as unknown;
			const validation = validateTutorialCatalog(parsed, this.installedVersion);
			if (!validation.catalog) {
				throw new Error(validation.errors.join(' '));
			}
			return {
				catalog: validation.catalog,
				validation,
				source: 'localDevelopment',
				stale: false,
				lastUpdated: new Date().toISOString(),
				catalogUrl: catalogUri.toString(),
				errors: [],
				warnings: validation.warnings,
			};
		} catch (error) {
			const message = `Could not load local development tutorial catalog from ${catalogUri.fsPath || catalogUri.toString()}: ${this.messageFromError(error)}`;
			console.warn(`[Kusto Workbench] ${message}`);
			return this.unavailableCatalog([message], catalogUri.toString());
		}
	}

	private unavailableCatalog(errors: string[] = [], catalogUrl?: string): ResolvedTutorialCatalog {
		const catalog: TutorialCatalog = {
			schemaVersion: TUTORIAL_CATALOG_SCHEMA_VERSION,
			generatedAt: new Date().toISOString(),
			categories: [],
			content: [],
		};
		return {
			catalog,
			validation: { catalog: null, errors: [], warnings: [], incompatibleTutorialIds: [] },
			source: 'unavailable',
			stale: false,
			catalogUrl,
			errors: [TUTORIAL_CONNECTION_REQUIRED_MESSAGE, ...errors],
			warnings: [],
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

	private resolveContentSource(tutorial: TutorialItem, resolved: ResolvedTutorialCatalog): TutorialContentSource | null {
		const contentUrl = tutorial.contentUrl;
		if (resolved.source === 'localDevelopment') {
			if (/^https?:\/\//i.test(contentUrl)) {
				return { kind: 'remote', url: contentUrl };
			}
			const contentUri = this.resolveLocalDevelopmentUri(contentUrl);
			return contentUri ? { kind: 'localDevelopment', uri: contentUri, baseUri: this.parentUri(contentUri) } : null;
		}
		if (/^https?:\/\//i.test(contentUrl)) {
			return { kind: 'remote', url: contentUrl };
		}
		if (resolved.catalogUrl && /^https?:\/\//i.test(resolved.catalogUrl)) {
			return { kind: 'remote', url: new URL(contentUrl, resolved.catalogUrl).toString() };
		}
		return null;
	}

	private async resolveSummaryContent(resolved: ResolvedTutorialCatalog): Promise<Map<string, TutorialSummaryContent>> {
		const summaryContent = new Map<string, TutorialSummaryContent>();
		await Promise.all(resolved.catalog.content.map(async tutorial => {
			const content = await this.readSummaryContent(tutorial, resolved);
			if (content) {
				summaryContent.set(tutorial.id, content);
			}
		}));
		return summaryContent;
	}

	private async readSummaryContent(tutorial: TutorialItem, resolved: ResolvedTutorialCatalog): Promise<TutorialSummaryContent | null> {
		const contentSource = this.resolveContentSource(tutorial, resolved);
		if (!contentSource) {
			return null;
		}
		try {
			let markdown = '';
			if (contentSource.kind === 'localDevelopment') {
				markdown = await this.readLocalDevelopmentText(contentSource.uri, MAX_MARKDOWN_BYTES, 'tutorial');
			} else {
				markdown = await this.readCachedTutorialMarkdown(tutorial.id, contentSource.url)
					?? await this.fetchRemoteMarkdown(contentSource.url, tutorial.id);
			}
			return {
				displayName: this.firstMarkdownHeading(markdown) ?? undefined,
				contentText: this.markdownToSearchText(markdown),
			};
		} catch {
			return null;
		}
	}

	private firstMarkdownHeading(markdown: string): string | null {
		const match = /^#\s+(.+?)\s*#*\s*$/m.exec(markdown);
		return match?.[1]?.trim() || null;
	}

	private markdownToSearchText(markdown: string): string {
		return markdown
			.replace(/^#\s+.+?\s*#*\s*$/m, ' ')
			.replace(/```[\s\S]*?```/g, block => block.replace(/```[^\n]*\n?|```/g, ' '))
			.replace(/`([^`]+)`/g, '$1')
			.replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
			.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
			.replace(/<[^>]+>/g, ' ')
			.replace(/^#{1,6}\s+/gm, ' ')
			.replace(/^[>\-*+\d.)\s]+/gm, ' ')
			.replace(/[\\*_~#>`|\[\](){}\/]/g, ' ')
			.replace(/\s+/g, ' ')
			.trim();
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
		base: { kind: 'remote'; baseUrl: string } | { kind: 'localDevelopment'; baseUri: vscode.Uri },
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
		base: { kind: 'remote'; baseUrl: string } | { kind: 'localDevelopment'; baseUri: vscode.Uri },
		webview: vscode.Webview,
		errors: string[],
	): Promise<string | null> {
		const normalized = source.trim();
		if (!normalized || /^(data|file|command|javascript|vscode|vscode-insiders):/i.test(normalized) || normalized.toLowerCase().includes('.svg')) {
			errors.push(`Blocked tutorial image source '${normalized}'.`);
			return null;
		}
		if (base.kind === 'localDevelopment' && !/^https?:\/\//i.test(normalized)) {
			const imageUri = this.resolveLocalDevelopmentUri(normalized, base.baseUri);
			if (!imageUri) {
				errors.push(`Blocked tutorial image source '${normalized}'.`);
				return null;
			}
			return webview.asWebviewUri(imageUri).toString();
		}

		let imageUrl: string;
		try {
			if (/^https?:\/\//i.test(normalized)) {
				imageUrl = normalized;
			} else if (base.kind === 'remote') {
				imageUrl = new URL(normalized, base.baseUrl).toString();
			} else {
				errors.push(`Blocked tutorial image source '${normalized}'.`);
				return null;
			}
		} catch {
			errors.push(`Blocked tutorial image source '${normalized}'.`);
			return null;
		}
		try {
			return (await this.fetchAndCacheImage(imageUrl, webview))?.toString() ?? null;
		} catch (error) {
			errors.push(`Could not cache tutorial image ${redactTutorialUrl(imageUrl)}: ${this.messageFromError(error)}`);
			return null;
		}
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

	private async readLocalDevelopmentText(uri: vscode.Uri, maxBytes: number, label: string): Promise<string> {
		const bytes = await vscode.workspace.fs.readFile(uri);
		if (bytes.byteLength > maxBytes) {
			throw new Error(`${label} file is too large`);
		}
		return new TextDecoder().decode(bytes);
	}

	private resolveLocalDevelopmentUri(relativePath: string, baseUri = this.localDevelopmentRootUri()): vscode.Uri | null {
		if (relativePath.startsWith('/') || relativePath.startsWith('//') || relativePath.includes('\\') || /^[a-z][a-z0-9+.-]*:/i.test(relativePath)) {
			return null;
		}
		const segments = relativePath.split('/').filter(Boolean);
		if (!segments.length || segments.some(segment => segment === '..')) {
			return null;
		}
		return vscode.Uri.joinPath(baseUri, ...segments);
	}

	private parentUri(uri: vscode.Uri): vscode.Uri {
		const rootPath = this.localDevelopmentRootUri().path.replace(/\\/g, '/');
		const uriPath = uri.path.replace(/\\/g, '/');
		const relativePath = uriPath.startsWith(rootPath) ? uriPath.slice(rootPath.length) : '';
		const relativeSegments = relativePath.split('/').filter(Boolean);
		return vscode.Uri.joinPath(this.localDevelopmentRootUri(), ...relativeSegments.slice(0, -1));
	}

	private localDevelopmentRootUri(): vscode.Uri {
		return vscode.Uri.joinPath(this.context.extensionUri, 'media', 'tutorials');
	}

	private isLocalDevelopmentMode(): boolean {
		return this.context.extensionMode === vscode.ExtensionMode.Development;
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

	private async readCachedTutorialMarkdown(tutorialId: string, contentUrl?: string): Promise<string | null> {
		if (contentUrl) {
			const byUrl = await this.readTextCache(this.contentCacheName(contentUrl));
			if (byUrl) {
				return byUrl;
			}
		}
		return await this.readTextCache(`content-by-id-${this.cacheKey(tutorialId)}.md`);
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
