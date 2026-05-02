const SIMPLE_CLUSTER_HOST_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

function textValue(value: unknown): string {
	return String(value ?? '').trim();
}

function ensureHttpScheme(value: unknown): string {
	const raw = textValue(value);
	if (!raw) return '';
	if (/^https?:\/\//i.test(raw)) return raw;
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return raw;
	if (/^\/\//.test(raw)) return `https://${raw.replace(/^\/+/, '')}`;
	return `https://${raw.replace(/^\/+/, '')}`;
}

function tryParseClusterUrl(value: unknown): URL | null {
	const withScheme = ensureHttpScheme(value);
	if (!withScheme) return null;
	try {
		return new URL(withScheme);
	} catch {
		return null;
	}
}

function hasExplicitPort(value: unknown): boolean {
	const withScheme = ensureHttpScheme(value);
	const withoutScheme = withScheme.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
	const authority = withoutScheme.split(/[/?#]/, 1)[0] ?? '';
	const hostPort = authority.includes('@') ? authority.slice(authority.lastIndexOf('@') + 1) : authority;
	return /^[^:]+:\d+$/.test(hostPort);
}

export function ensureKustoClusterUrlScheme(value: unknown): string {
	return ensureHttpScheme(value);
}

export function isCompleteKustoClusterUrl(value: unknown): boolean {
	const parsed = tryParseClusterUrl(value);
	return !!parsed?.hostname && parsed.hostname.includes('.');
}

export function selectBestKustoClusterUrl(...candidates: unknown[]): string {
	let fallback = '';
	for (const candidate of candidates) {
		const withScheme = ensureHttpScheme(candidate);
		if (!withScheme) continue;
		if (!fallback) fallback = withScheme;
		if (isCompleteKustoClusterUrl(withScheme)) return withScheme;
	}
	return fallback;
}

export function canonicalizePowerBiKustoClusterUrl(value: unknown): string {
	const raw = textValue(value);
	if (!raw) {
		throw new Error('Power BI export requires a Kusto cluster URL.');
	}

	const parsed = tryParseClusterUrl(raw);
	if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
		throw new Error('Power BI export requires a valid HTTPS Kusto cluster URL.');
	}
	if (parsed.username || parsed.password) {
		throw new Error('Power BI export requires a Kusto cluster URL without credentials.');
	}
	if (parsed.port || hasExplicitPort(raw)) {
		throw new Error('Power BI export requires a Kusto cluster URL without a port.');
	}
	if (parsed.search || parsed.hash) {
		throw new Error('Power BI export requires a Kusto cluster URL without query string or fragment.');
	}
	if (parsed.pathname && parsed.pathname !== '/') {
		throw new Error('Power BI export requires the Kusto cluster root URL, not a URL path.');
	}

	const host = parsed.hostname.toLowerCase();
	if (!host) {
		throw new Error('Power BI export requires a Kusto cluster host name.');
	}
	if (host.includes('.')) {
		return `https://${host}`;
	}
	if (!SIMPLE_CLUSTER_HOST_RE.test(host)) {
		throw new Error('Power BI export requires a simple Kusto cluster name or a complete cluster URL.');
	}
	return `https://${host}.kusto.windows.net`;
}
