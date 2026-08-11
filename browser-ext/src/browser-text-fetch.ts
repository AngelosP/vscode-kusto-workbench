const MAX_BROWSER_TEXT_BYTES = 16 * 1024 * 1024;

export class BrowserHttpStatusError extends Error {
	constructor(readonly status: number, statusText: string) {
		super(`HTTP ${status}: ${statusText}`);
	}
}

export async function readBrowserTextBody(
	response: Response,
	maxBytes = MAX_BROWSER_TEXT_BYTES,
): Promise<string> {
	if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('Browser response size limit is invalid.');
	const declaredLength = Number(response.headers.get('content-length'));
	if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
		try { await response.body?.cancel(); } catch { /* ignore */ }
		throw new Error(`Browser response exceeds the ${maxBytes}-byte size limit.`);
	}
	if (!response.body) return '';
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let totalBytes = 0;
	let text = '';
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			totalBytes += value.byteLength;
			if (totalBytes > maxBytes) {
				try { await reader.cancel(); } catch { /* ignore */ }
				throw new Error(`Browser response exceeds the ${maxBytes}-byte size limit.`);
			}
			text += decoder.decode(value, { stream: true });
		}
		return text + decoder.decode();
	} finally {
		reader.releaseLock();
	}
}

export async function fetchBrowserText(url: string, signal: AbortSignal): Promise<string> {
	const response = await fetch(url, {
		signal,
		credentials: 'same-origin',
		redirect: 'follow',
		headers: { 'Accept': 'text/plain, application/json, */*' },
	});
	if (!response.ok) throw new BrowserHttpStatusError(response.status, response.statusText);
	return readBrowserTextBody(response);
}