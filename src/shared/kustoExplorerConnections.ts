import { kustoClusterKey, selectBestKustoClusterUrl } from './kustoClusterUrls';

export type KustoExplorerConnection = {
	name: string;
	clusterUrl: string;
	database?: string;
	authorityId?: string;
};

function decodeXml(value: string): string {
	return value
		.replace(/&quot;/gi, '"')
		.replace(/&apos;/gi, "'")
		.replace(/&lt;/gi, '<')
		.replace(/&gt;/gi, '>')
		.replace(/&amp;/gi, '&');
}

function escapeXml(value: unknown): string {
	return String(value ?? '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');
}

function unquote(value: string): string {
	const trimmed = value.trim();
	if (trimmed.length >= 2) {
		const quote = trimmed[0];
		if ((quote === '"' || quote === "'") && trimmed[trimmed.length - 1] === quote) {
			return trimmed.slice(1, -1).replace(new RegExp(`${quote}${quote}`, 'g'), quote);
		}
	}
	return trimmed;
}

function formatConnectionStringValue(value: unknown): string {
	const text = String(value ?? '');
	if (text === text.trim() && !/[;"\r\n]/.test(text)) return text;
	return `"${text.replace(/"/g, '""')}"`;
}

export function parseKustoConnectionString(connectionString: unknown): {
	dataSource: string;
	initialCatalog: string;
	authorityId: string;
} {
	const raw = String(connectionString ?? '');
	const segments: string[] = [];
	let segment = '';
	let quote = '';
	for (let index = 0; index < raw.length; index++) {
		const char = raw[index];
		if (quote) {
			segment += char;
			if (char === quote) {
				if (raw[index + 1] === quote) {
					segment += raw[++index];
				} else {
					quote = '';
				}
			}
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			segment += char;
			continue;
		}
		if (char === ';') {
			if (segment.trim()) segments.push(segment.trim());
			segment = '';
			continue;
		}
		segment += char;
	}
	if (segment.trim()) segments.push(segment.trim());

	const values = new Map<string, string>();
	for (const part of segments) {
		const separator = part.indexOf('=');
		if (separator <= 0) continue;
		const key = part.slice(0, separator).trim().toLowerCase().replace(/\s+/g, ' ');
		values.set(key, unquote(part.slice(separator + 1)));
	}
	return {
		dataSource: values.get('data source') || values.get('datasource') || values.get('server') || values.get('address') || '',
		initialCatalog: values.get('initial catalog') || values.get('database') || '',
		authorityId: values.get('authority id') || values.get('authorityid') || values.get('tenant id') || values.get('tenantid') || '',
	};
}

function childText(parent: string, tagName: string): string {
	const match = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\/${tagName}>`, 'i').exec(parent);
	return match ? decodeXml(match[1].trim()) : '';
}

export function parseKustoExplorerConnectionsXml(xmlText: unknown): KustoExplorerConnection[] {
	const text = String(xmlText ?? '').trim();
	if (!text) return [];
	const results: KustoExplorerConnection[] = [];
	const blocks = /<ServerDescriptionBase[^>]*>([\s\S]*?)<\/ServerDescriptionBase>/gi;
	let block: RegExpExecArray | null;
	while ((block = blocks.exec(text)) !== null) {
		const name = childText(block[1], 'Name');
		const details = childText(block[1], 'Details');
		const parsed = parseKustoConnectionString(childText(block[1], 'ConnectionString'));
		let clusterUrl = selectBestKustoClusterUrl(parsed.dataSource, details).trim();
		if (!clusterUrl) continue;
		if (!/^https?:\/\//i.test(clusterUrl)) clusterUrl = `https://${clusterUrl.replace(/^\/+/, '')}`;
		results.push({
			name: name.trim() || clusterUrl,
			clusterUrl: clusterUrl.trim(),
			...(parsed.initialCatalog.trim() ? { database: parsed.initialCatalog.trim() } : {}),
			...(parsed.authorityId.trim() ? { authorityId: parsed.authorityId.trim() } : {}),
		});
	}
	const seen = new Set<string>();
	return results.filter(connection => {
		const key = `${kustoClusterKey(connection.clusterUrl)}|${String(connection.authorityId || '').trim().toLowerCase()}`;
		if (!key || seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

export function stringifyKustoExplorerConnectionsXml(connections: readonly KustoExplorerConnection[]): string {
	const blocks = connections.map(connection => {
		const clusterUrl = /^https?:\/\//i.test(connection.clusterUrl) ? connection.clusterUrl : `https://${connection.clusterUrl}`;
		const database = connection.database ? `Initial Catalog=${escapeXml(formatConnectionStringValue(connection.database))};` : '';
		const authority = connection.authorityId ? `Authority Id=${escapeXml(formatConnectionStringValue(connection.authorityId))};` : '';
		return `  <ServerDescriptionBase>\n    <Name>${escapeXml(connection.name || clusterUrl)}</Name>\n    <Details>${escapeXml(clusterUrl)}</Details>\n    <ConnectionString>Data Source=${escapeXml(clusterUrl)};${database}${authority}AAD Federated Security=True</ConnectionString>\n  </ServerDescriptionBase>`;
	});
	return `<?xml version="1.0" encoding="utf-8"?>\n<ArrayOfServerDescriptionBase xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">\n${blocks.join('\n')}\n</ArrayOfServerDescriptionBase>\n`;
}