// Pure utility functions for cluster URL parsing, formatting, and favorites.
// Extracted from queryBoxes-connection.ts bridge module for testability.

export {
	canonicalizePowerBiKustoClusterUrl,
	exportAzureDataExplorerClusterPath,
	exportKustoClusterEndpoint,
	exportKustoClusterForKql,
	ensureKustoClusterUrlScheme,
	isCompleteKustoClusterUrl,
	kustoClusterKey,
	kustoDatabaseKey,
	kustoEntityKey,
	parseKustoClusterRef,
	selectBestKustoClusterUrl,
} from '../../shared/kustoClusterUrls.js';
export { parseKustoConnectionString, parseKustoExplorerConnectionsXml } from '../../shared/kustoExplorerConnections.js';

import { kustoClusterKey } from '../../shared/kustoClusterUrls.js';
import { resolveKustoConnection } from '../../shared/kustoAuth.js';

export function formatClusterDisplayName(connection: any): string {
	if (!connection) return '';
	const url = String(connection.clusterUrl || '').trim();
	if (url) {
		try {
			const u = new URL(url);
			const hostname = String(u.hostname || '').trim();
			const lower = hostname.toLowerCase();
			if (lower.endsWith('.kusto.windows.net')) {
				return hostname.slice(0, hostname.length - '.kusto.windows.net'.length);
			}
			return hostname || url;
		} catch { /* fall through */ }
	}
	return String(connection.name || connection.clusterUrl || '').trim();
}

export function normalizeClusterUrlKey(url: any): string {
	try {
		const raw = String(url || '').trim();
		if (!raw) return '';
		const withScheme = /^https?:\/\//i.test(raw) ? raw : ('https://' + raw.replace(/^\/+/, ''));
		const u = new URL(withScheme);
		return (u.origin + u.pathname).replace(/\/+$/, '').toLowerCase();
	} catch {
		return String(url || '').trim().replace(/\/+$/, '').toLowerCase();
	}
}

export function canonicalKustoClusterKey(url: any): string {
	return kustoClusterKey(url);
}

export function formatClusterShortName(clusterUrl: any): string {
	const raw = String(clusterUrl || '').trim();
	if (!raw) return '';
	try {
		const withScheme = /^https?:\/\//i.test(raw) ? raw : ('https://' + raw.replace(/^\/+/, ''));
		const u = new URL(withScheme);
		const host = String(u.hostname || '').trim();
		if (!host) return raw;
		const first = host.split('.')[0];
		return first || host;
	} catch {
		const m = raw.match(/([a-z0-9-]+)(?:\.[a-z0-9.-]+)+/i);
		if (m && m[1]) return m[1];
		return raw;
	}
}

export function clusterShortNameKey(clusterUrl: any): string {
	try {
		return String(formatClusterShortName(clusterUrl) || '').trim().toLowerCase();
	} catch {
		return String(clusterUrl || '').trim().toLowerCase();
	}
}

export function extractClusterUrlsFromQueryText(queryText: any): string[] {
	const text = String(queryText || '');
	if (!text) return [];
	const urls: string[] = [];
	try {
		const re = /\bcluster\s*\(\s*(['"])([^'"\r\n]+?)\1\s*\)/ig;
		let m;
		while ((m = re.exec(text)) !== null) {
			const u = String(m[2] || '').trim();
			if (u) urls.push(u);
		}
	} catch { /* ignore */ }
	const seen = new Set<string>();
	const out: string[] = [];
	for (const u of urls) {
		const key = canonicalKustoClusterKey(u);
		if (!key || seen.has(key)) continue;
		seen.add(key);
		out.push(u);
	}
	return out;
}

export function extractClusterDatabaseHintsFromQueryText(queryText: any): Record<string, string> {
	const text = String(queryText || '');
	const map: Record<string, string> = {};
	if (!text) return map;
	try {
		const re = /\bcluster\s*\(\s*(['"])([^'"\r\n]+?)\1\s*\)\s*\.\s*database\s*\(\s*(['"])([^'"\r\n]+?)\3\s*\)/ig;
		let m;
		while ((m = re.exec(text)) !== null) {
			const clusterUrl = String(m[2] || '').trim();
			const database = String(m[4] || '').trim();
			if (!clusterUrl || !database) continue;
			const key = canonicalKustoClusterKey(clusterUrl);
			if (!key) continue;
			if (!map[key]) map[key] = database;
		}
	} catch { /* ignore */ }
	return map;
}

export function computeMissingClusterUrls(detectedClusterUrls: any[], connections: any[]): string[] {
	const detected = Array.isArray(detectedClusterUrls) ? detectedClusterUrls : [];
	if (!detected.length) return [];
	const existingKeys = new Set<string>();
	for (const c of (connections || [])) {
		if (!c) continue;
		const key = canonicalKustoClusterKey(c.clusterUrl || '');
		if (key) existingKeys.add(key);
	}
	const missing: string[] = [];
	for (const u of detected) {
		const key = canonicalKustoClusterKey(u);
		if (!key) continue;
		if (!existingKeys.has(key)) missing.push(u);
	}
	return missing;
}

export function favoriteKey(connectionId: any, database: any): string {
	const c = String(connectionId || '').trim();
	const d = String(database || '').trim().toLowerCase();
	return c + '|' + d;
}

export function findFavorite(connectionId: any, database: any, favorites: any[]): any {
	const key = favoriteKey(connectionId, database);
	const list = Array.isArray(favorites) ? favorites : [];
	for (const f of list) {
		if (!f) continue;
		const fk = favoriteKey(f.connectionId, f.database);
		if (fk === key) return f;
	}
	return null;
}

export function getFavoritesSorted(favorites: any[]): any[] {
	const list = (Array.isArray(favorites) ? favorites : []).slice();
	list.sort((a: any, b: any) => {
		const an = String((a && a.name) || '').toLowerCase();
		const bn = String((b && b.name) || '').toLowerCase();
		return an.localeCompare(bn);
	});
	return list;
}

export function findConnectionIdForClusterUrl(clusterUrl: any, connections: any[]): string {
	try {
		const resolution = resolveKustoConnection(connections || [], { clusterUrl });
		return resolution.kind === 'matched' ? String(resolution.connection.id || '').trim() : '';
	} catch { /* ignore */ }
	return '';
}
