import type { IncomingWebviewMessage } from './queryEditorTypes';

const URL_FETCH_TIMEOUT_MS = 15_000;
const URL_CONTENT_MAX_CHARS = 200_000;
const URL_TEXT_MAX_BYTES = 100 * 1024 * 1024;
const URL_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

type FetchUrlMessage = Extract<IncomingWebviewMessage, { type: 'fetchUrl' }>;

export interface UrlContentApplicationHandler {
	handleMessage(message: IncomingWebviewMessage): Promise<void> | undefined;
	dispose(): void;
}

export type UrlContentApplicationHandlerOptions = {
	postMessage: (message: unknown) => Thenable<boolean>;
	fetchUrl?: typeof fetch;
	timeoutMs?: number;
	maxChars?: number;
	maxTextBytes?: number;
	maxImageBytes?: number;
};

function formatBytes(byteLength: number): string {
	if (!Number.isFinite(byteLength) || byteLength < 0) {
		return '0 B';
	}
	if (byteLength >= 1024 * 1024) {
		return `${(byteLength / (1024 * 1024)).toFixed(1)} MB`;
	}
	if (byteLength >= 1024) {
		return `${Math.round(byteLength / 1024)} KB`;
	}
	return `${byteLength} B`;
}

function getErrorName(error: unknown): string {
	if ((typeof error !== 'object' || error === null) && typeof error !== 'function') return '';
	return String((error as { name?: unknown }).name || '');
}

function getErrorMessage(error: unknown): string | undefined {
	if ((typeof error !== 'object' || error === null) && typeof error !== 'function') return undefined;
	const message = (error as { message?: unknown }).message;
	return typeof message === 'string' ? message : undefined;
}

export class HostUrlContentApplicationHandler implements UrlContentApplicationHandler {
	private readonly activeAbortControllers = new Set<AbortController>();
	private readonly fetchUrl: typeof fetch;
	private readonly timeoutMs: number;
	private readonly maxChars: number;
	private readonly maxTextBytes: number;
	private readonly maxImageBytes: number;
	private disposed = false;

	constructor(private readonly options: UrlContentApplicationHandlerOptions) {
		this.fetchUrl = options.fetchUrl ?? fetch;
		this.timeoutMs = options.timeoutMs ?? URL_FETCH_TIMEOUT_MS;
		this.maxChars = options.maxChars ?? URL_CONTENT_MAX_CHARS;
		this.maxTextBytes = options.maxTextBytes ?? URL_TEXT_MAX_BYTES;
		this.maxImageBytes = options.maxImageBytes ?? URL_IMAGE_MAX_BYTES;
	}

	handleMessage(message: IncomingWebviewMessage): Promise<void> | undefined {
		if (message.type !== 'fetchUrl') return undefined;
		return this.fetchUrlContent(message);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const abortController of this.activeAbortControllers) abortController.abort();
		this.activeAbortControllers.clear();
	}

	private postMessage(message: unknown): void {
		if (this.disposed) return;
		this.options.postMessage(message);
	}

	private async fetchUrlContent(message: FetchUrlMessage): Promise<void> {
		if (this.disposed) return;
		const boxId = String(message.boxId || '').trim();
		const rawUrl = String(message.url || '').trim();
		const requestId = String(message.requestId || '').trim();
		if (!boxId) return;
		const responseIdentity = { boxId, requestId, requestedUrl: rawUrl };

		let url: URL;
		try {
			url = new URL(rawUrl);
		} catch {
			this.postMessage({ type: 'urlError', ...responseIdentity, error: 'Invalid URL.' });
			return;
		}
		if (url.protocol !== 'http:' && url.protocol !== 'https:') {
			this.postMessage({ type: 'urlError', ...responseIdentity, error: 'Only http/https URLs are supported.' });
			return;
		}

		const abortController = new AbortController();
		this.activeAbortControllers.add(abortController);
		const timer = setTimeout(() => abortController.abort(), this.timeoutMs);
		try {
			const response = await this.fetchUrl(url.toString(), {
				redirect: 'follow',
				signal: abortController.signal,
			});
			if (this.disposed) return;
			const contentType = response.headers.get('content-type') || '';
			const contentTypeLower = contentType.toLowerCase();
			const finalUrl = response.url || url.toString();

			const pathLower = (() => {
				try {
					return new URL(finalUrl).pathname.toLowerCase();
				} catch {
					return '';
				}
			})();

			const looksLikeCsv = contentTypeLower.includes('text/csv')
				|| contentTypeLower.includes('application/csv')
				|| pathLower.endsWith('.csv');
			const looksLikeHtml = contentTypeLower.includes('text/html')
				|| pathLower.endsWith('.html')
				|| pathLower.endsWith('.htm');
			const looksLikeImage = contentTypeLower.startsWith('image/');
			const looksLikeText = contentTypeLower.startsWith('text/')
				|| contentTypeLower.includes('json')
				|| contentTypeLower.includes('xml')
				|| contentTypeLower.includes('yaml');

			const maxBytes = looksLikeImage ? this.maxImageBytes : this.maxTextBytes;
			const arrayBuffer = await response.arrayBuffer();
			if (this.disposed) return;
			const bytes = Buffer.from(arrayBuffer);
			if (bytes.byteLength > maxBytes) {
				this.postMessage({
					type: 'urlError',
					...responseIdentity,
					error: `Response too large (${formatBytes(bytes.byteLength)}). Max is ${formatBytes(maxBytes)}.`,
				});
				return;
			}

			if (!response.ok) {
				const status = response.status;
				const statusText = (response.statusText || '').trim();
				const hint = (() => {
					if (contentTypeLower.includes('text/html') && pathLower.endsWith('.csv')) {
						return ' The server returned HTML, not CSV. Try using a raw download link.';
					}
					return '';
				})();
				this.postMessage({
					type: 'urlError',
					...responseIdentity,
					error: `HTTP ${status}${statusText ? ' ' + statusText : ''}.${hint}`,
				});
				return;
			}

			if (looksLikeImage) {
				const mime = contentType.split(';')[0].trim() || 'image/*';
				const base64 = bytes.toString('base64');
				const dataUri = `data:${mime};base64,${base64}`;
				this.postMessage({
					type: 'urlContent',
					...responseIdentity,
					url: finalUrl,
					contentType,
					status: response.status,
					kind: 'image',
					dataUri,
					byteLength: bytes.byteLength,
				});
				return;
			}

			let body = bytes.toString('utf8');
			let truncated = false;
			if (body.length > this.maxChars) {
				body = body.slice(0, this.maxChars);
				truncated = true;
			}

			const sniff = body.slice(0, 4096).trimStart().toLowerCase();
			const looksLikeHtmlByBody = sniff.startsWith('<!doctype html')
				|| sniff.startsWith('<html')
				|| sniff.startsWith('<head');

			const isCsvByType = contentTypeLower.includes('text/csv')
				|| contentTypeLower.includes('application/csv');
			const isHtmlByType = contentTypeLower.includes('text/html');
			const isCsvByExt = pathLower.endsWith('.csv') && !isHtmlByType && !looksLikeHtmlByBody;
			const kind = (isCsvByType || isCsvByExt)
				? 'csv'
				: ((looksLikeHtml || isHtmlByType || looksLikeHtmlByBody)
					? 'html'
					: (looksLikeText ? 'text' : 'text'));

			this.postMessage({
				type: 'urlContent',
				...responseIdentity,
				url: finalUrl,
				contentType,
				status: response.status,
				kind,
				body,
				truncated,
				byteLength: bytes.byteLength,
			});
		} catch (error) {
			if (this.disposed) return;
			const errorMessage = getErrorName(error) === 'AbortError'
				? `Timed out after ${Math.round(this.timeoutMs / 1000)}s.`
				: (getErrorMessage(error) ?? 'Failed to fetch URL.');
			this.postMessage({ type: 'urlError', ...responseIdentity, error: errorMessage });
		} finally {
			clearTimeout(timer);
			this.activeAbortControllers.delete(abortController);
		}
	}
}
