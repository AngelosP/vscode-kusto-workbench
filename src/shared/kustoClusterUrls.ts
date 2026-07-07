const SIMPLE_CLUSTER_HOST_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const PUBLIC_KUSTO_SUFFIX = '.kusto.windows.net';

// Public ADX short regional names use `<cluster>.<azure-region>` and are
// logically equivalent to `<cluster>.<azure-region>.kusto.windows.net`.
const AZURE_REGION_KEYS = new Set([
	'australiacentral', 'australiacentral2', 'australiaeast', 'australiasoutheast',
	'brazilsouth', 'brazilsoutheast',
	'canadacentral', 'canadaeast',
	'centralindia', 'centralus',
	'eastasia', 'eastus', 'eastus2', 'eastus2euap',
	'francecentral', 'francesouth',
	'germanynorth', 'germanywestcentral',
	'israelcentral', 'italynorth',
	'japaneast', 'japanwest',
	'jioindiacentral', 'jioindiawest',
	'koreacentral', 'koreasouth',
	'mexicocentral',
	'northcentralus', 'northeurope', 'norwayeast', 'norwaywest',
	'polandcentral',
	'qatarcentral',
	'southafricanorth', 'southafricawest', 'southcentralus', 'southeastasia', 'southindia',
	'spaincentral', 'swedencentral', 'swedensouth', 'switzerlandnorth', 'switzerlandwest',
	'uaecentral', 'uaenorth', 'uksouth', 'ukwest',
	'westcentralus', 'westeurope', 'westindia', 'westus', 'westus2', 'westus3',
	'usgovarizona', 'usgoviowa', 'usgovtexas', 'usgovvirginia',
	'chinaeast', 'chinaeast2', 'chinaeast3', 'chinanorth', 'chinanorth2', 'chinanorth3'
]);

export interface KustoClusterRef {
	raw: string;
	/** Normalized input host without scheme, port, path, query, or trailing slash. */
	host: string;
	/** Stable logical identity key for equality and dictionaries. */
	key: string;
	/** Canonical HTTPS endpoint host for SDKs/exporters. */
	endpointHost: string;
	endpointUrl: string;
	/** True when the cluster is a public ADX short/full host. */
	isPublicKusto: boolean;
	isEmpty: boolean;
}

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

function emptyClusterRef(raw: string = ''): KustoClusterRef {
	return { raw, host: '', key: '', endpointHost: '', endpointUrl: '', isPublicKusto: false, isEmpty: true };
}

function publicClusterKeyFromHost(host: string): string {
	return host.toLowerCase().endsWith(PUBLIC_KUSTO_SUFFIX)
		? host.slice(0, -PUBLIC_KUSTO_SUFFIX.length)
		: host;
}

function isPublicRegionalShortHost(host: string): boolean {
	const parts = host.split('.').filter(Boolean);
	return parts.length >= 2 && AZURE_REGION_KEYS.has(parts[parts.length - 1]);
}

function normalizeClusterHost(value: unknown): { raw: string; host: string } {
	const raw = textValue(value);
	if (!raw) return { raw, host: '' };
	const parsed = tryParseClusterUrl(raw);
	if (parsed?.hostname) {
		return { raw, host: parsed.hostname.toLowerCase() };
	}
	return {
		raw,
		host: raw
			.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
			.replace(/^\/+/, '')
			.split(/[/?#]/, 1)[0]
			.replace(/:\d+$/g, '')
			.replace(/\/+$/g, '')
			.toLowerCase()
	};
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

export function parseKustoClusterRef(value: unknown): KustoClusterRef {
	const { raw, host } = normalizeClusterHost(value);
	if (!host) return emptyClusterRef(raw);

	if (host.endsWith(PUBLIC_KUSTO_SUFFIX)) {
		const key = publicClusterKeyFromHost(host);
		return { raw, host, key, endpointHost: host, endpointUrl: `https://${host}`, isPublicKusto: true, isEmpty: false };
	}

	if (host.includes('.kusto.')) {
		return { raw, host, key: host, endpointHost: host, endpointUrl: `https://${host}`, isPublicKusto: false, isEmpty: false };
	}

	if (SIMPLE_CLUSTER_HOST_RE.test(host) || isPublicRegionalShortHost(host)) {
		return {
			raw,
			host,
			key: host,
			endpointHost: `${host}${PUBLIC_KUSTO_SUFFIX}`,
			endpointUrl: `https://${host}${PUBLIC_KUSTO_SUFFIX}`,
			isPublicKusto: true,
			isEmpty: false
		};
	}

	return { raw, host, key: host, endpointHost: host, endpointUrl: `https://${host}`, isPublicKusto: false, isEmpty: false };
}

export function kustoClusterKey(value: unknown): string {
	return parseKustoClusterRef(value).key;
}

export function kustoDatabaseKey(cluster: unknown, database: unknown): string {
	const clusterKey = kustoClusterKey(cluster);
	const databaseKey = textValue(database).toLowerCase();
	return clusterKey && databaseKey ? `${clusterKey}|${databaseKey}` : '';
}

export function kustoEntityKey(cluster: unknown, database: unknown, entity: unknown): string {
	const databaseKey = kustoDatabaseKey(cluster, database);
	const entityKey = textValue(entity).toLowerCase();
	return databaseKey && entityKey ? `${databaseKey}|${entityKey}` : '';
}

export function exportKustoClusterEndpoint(value: unknown): string {
	return parseKustoClusterRef(value).endpointUrl;
}

export function exportKustoClusterForKql(value: unknown): string {
	const parsed = parseKustoClusterRef(value);
	if (parsed.isEmpty) return '';
	return parsed.isPublicKusto ? parsed.key : parsed.endpointHost;
}

export function exportAzureDataExplorerClusterPath(value: unknown): string {
	const parsed = parseKustoClusterRef(value);
	if (parsed.isEmpty) return '';
	return parsed.isPublicKusto ? parsed.key : parsed.endpointHost;
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
	const clusterRef = parseKustoClusterRef(raw);
	if (clusterRef.isEmpty || !clusterRef.endpointUrl) {
		throw new Error('Power BI export requires a simple Kusto cluster name or a complete cluster URL.');
	}
	return clusterRef.endpointUrl;
}
