import { describe, it, expect } from 'vitest';
import {
	formatClusterDisplayName,
	normalizeClusterUrlKey,
	formatClusterShortName,
	clusterShortNameKey,
	extractClusterUrlsFromQueryText,
	extractClusterDatabaseHintsFromQueryText,
	computeMissingClusterUrls,
	favoriteKey,
	findFavorite,
	getFavoritesSorted,
	parseKustoConnectionString,
	findConnectionIdForClusterUrl,
} from '../../src/webview/shared/clusterUtils';

// ── formatClusterDisplayName ──────────────────────────────────────────────

describe('formatClusterDisplayName', () => {
	it('returns empty string for null', () => {
		expect(formatClusterDisplayName(null)).toBe('');
	});

	it('strips .kusto.windows.net suffix', () => {
		expect(formatClusterDisplayName({ clusterUrl: 'https://mycluster.kusto.windows.net' })).toBe('mycluster');
	});

	it('returns hostname for non-Kusto domains', () => {
		expect(formatClusterDisplayName({ clusterUrl: 'https://dataexplorer.example.com' })).toBe('dataexplorer.example.com');
	});

	it('falls back to name', () => {
		expect(formatClusterDisplayName({ name: 'MyCluster' })).toBe('MyCluster');
	});
});

// ── normalizeClusterUrlKey ────────────────────────────────────────────────

describe('normalizeClusterUrlKey', () => {
	it('returns empty for empty input', () => {
		expect(normalizeClusterUrlKey('')).toBe('');
	});

	it('lowercases and removes trailing slashes', () => {
		expect(normalizeClusterUrlKey('https://MyCluster.kusto.windows.net/'))
			.toBe('https://mycluster.kusto.windows.net');
	});

	it('adds https:// if no scheme', () => {
		expect(normalizeClusterUrlKey('mycluster.kusto.windows.net'))
			.toBe('https://mycluster.kusto.windows.net');
	});

	it('strips leading slashes before adding scheme', () => {
		expect(normalizeClusterUrlKey('//mycluster.kusto.windows.net'))
			.toBe('https://mycluster.kusto.windows.net');
	});

	it('preserves paths', () => {
		expect(normalizeClusterUrlKey('https://host.com/path'))
			.toBe('https://host.com/path');
	});
});

// ── formatClusterShortName ────────────────────────────────────────────────

describe('formatClusterShortName', () => {
	it('returns empty for empty input', () => {
		expect(formatClusterShortName('')).toBe('');
	});

	it('returns first host segment', () => {
		expect(formatClusterShortName('https://mycluster.kusto.windows.net')).toBe('mycluster');
	});

	it('handles bare hostnames', () => {
		expect(formatClusterShortName('mycluster.kusto.windows.net')).toBe('mycluster');
	});

	it('handles hyphenated names', () => {
		expect(formatClusterShortName('my-cluster.kusto.windows.net')).toBe('my-cluster');
	});
});

// ── clusterShortNameKey ───────────────────────────────────────────────────

describe('clusterShortNameKey', () => {
	it('lowercases', () => {
		expect(clusterShortNameKey('MyCluster.kusto.windows.net')).toBe('mycluster');
	});

	it('handles empty', () => {
		expect(clusterShortNameKey('')).toBe('');
	});
});

// ── extractClusterUrlsFromQueryText ───────────────────────────────────────

describe('extractClusterUrlsFromQueryText', () => {
	it('returns empty for no clusters', () => {
		expect(extractClusterUrlsFromQueryText('StormEvents | take 10')).toEqual([]);
	});

	it('extracts single-quoted cluster', () => {
		const result = extractClusterUrlsFromQueryText("cluster('https://othercluster.kusto.windows.net').database('mydb').Table1");
		expect(result).toEqual(['https://othercluster.kusto.windows.net']);
	});

	it('extracts double-quoted cluster', () => {
		const result = extractClusterUrlsFromQueryText('cluster("https://othercluster.kusto.windows.net").database("mydb").Table1');
		expect(result).toEqual(['https://othercluster.kusto.windows.net']);
	});

	it('deduplicates by cluster short-name key', () => {
		const query = `
			cluster('https://mycluster.kusto.windows.net').database('db1').T1
			| union cluster('https://MYCLUSTER.kusto.windows.net').database('db2').T2
		`;
		expect(extractClusterUrlsFromQueryText(query).length).toBe(1);
	});

	it('extracts multiple unique clusters', () => {
		const query = `
			cluster('https://clusterA.kusto.windows.net').database('db1').T1
			| union cluster('https://clusterB.kusto.windows.net').database('db2').T2
		`;
		expect(extractClusterUrlsFromQueryText(query).length).toBe(2);
	});
});

// ── extractClusterDatabaseHintsFromQueryText ──────────────────────────────

describe('extractClusterDatabaseHintsFromQueryText', () => {
	it('returns empty for no hints', () => {
		expect(extractClusterDatabaseHintsFromQueryText('')).toEqual({});
	});

	it('extracts cluster+database pairs', () => {
		const query = "cluster('https://mycluster.kusto.windows.net').database('MyDB').Table1";
		const result = extractClusterDatabaseHintsFromQueryText(query);
		expect(result['mycluster']).toBe('MyDB');
	});

	it('keeps first database per cluster', () => {
		const query = `
			cluster('https://mycluster.kusto.windows.net').database('DB1').T1
			| union cluster('https://mycluster.kusto.windows.net').database('DB2').T2
		`;
		const result = extractClusterDatabaseHintsFromQueryText(query);
		expect(result['mycluster']).toBe('DB1');
	});
});

// ── computeMissingClusterUrls ─────────────────────────────────────────────

describe('computeMissingClusterUrls', () => {
	it('returns empty for no detected clusters', () => {
		expect(computeMissingClusterUrls([], [])).toEqual([]);
	});

	it('returns all detected if no connections', () => {
		const result = computeMissingClusterUrls(['https://newcluster.kusto.windows.net'], []);
		expect(result).toEqual(['https://newcluster.kusto.windows.net']);
	});

	it('filters out existing connections', () => {
		const detected = ['https://existing.kusto.windows.net', 'https://new.kusto.windows.net'];
		const connections = [{ clusterUrl: 'https://existing.kusto.windows.net' }];
		const result = computeMissingClusterUrls(detected, connections);
		expect(result).toEqual(['https://new.kusto.windows.net']);
	});

	it('matches case-insensitively', () => {
		const detected = ['https://MyCluster.kusto.windows.net'];
		const connections = [{ clusterUrl: 'https://mycluster.kusto.windows.net' }];
		expect(computeMissingClusterUrls(detected, connections)).toEqual([]);
	});
});

// ── favoriteKey ───────────────────────────────────────────────────────────

describe('favoriteKey', () => {
	it('normalizes cluster URL and lowercases database', () => {
		const key = favoriteKey('https://MyCluster.kusto.windows.net/', 'MyDB');
		expect(key).toContain('mycluster');
		expect(key).toContain('mydb');
	});

	it('handles empty inputs', () => {
		expect(favoriteKey('', '')).toBe('|');
	});
});

// ── findFavorite ──────────────────────────────────────────────────────────

describe('findFavorite', () => {
	const favorites = [
		{ clusterUrl: 'https://clusterA.kusto.windows.net', database: 'db1', name: 'fav1' },
		{ clusterUrl: 'https://clusterB.kusto.windows.net', database: 'db2', name: 'fav2' },
	];

	it('finds matching favorite', () => {
		const result = findFavorite('https://clusterA.kusto.windows.net', 'db1', favorites);
		expect(result).toEqual(favorites[0]);
	});

	it('returns null when not found', () => {
		expect(findFavorite('https://noexist.kusto.windows.net', 'db1', favorites)).toBeNull();
	});

	it('matches case-insensitively', () => {
		const result = findFavorite('https://CLUSTERA.kusto.windows.net', 'DB1', favorites);
		expect(result).toEqual(favorites[0]);
	});

	it('handles empty favorites list', () => {
		expect(findFavorite('https://x.kusto.windows.net', 'db', [])).toBeNull();
	});
});

// ── getFavoritesSorted ────────────────────────────────────────────────────

describe('getFavoritesSorted', () => {
	it('sorts by name', () => {
		const favs = [
			{ name: 'Zulu', clusterUrl: 'z' },
			{ name: 'Alpha', clusterUrl: 'a' },
			{ name: 'Mike', clusterUrl: 'm' },
		];
		const result = getFavoritesSorted(favs);
		expect(result.map((f: any) => f.name)).toEqual(['Alpha', 'Mike', 'Zulu']);
	});

	it('handles empty list', () => {
		expect(getFavoritesSorted([])).toEqual([]);
	});

	it('does not mutate input', () => {
		const favs = [{ name: 'B' }, { name: 'A' }];
		getFavoritesSorted(favs);
		expect(favs[0].name).toBe('B');
	});
});

// ── parseKustoConnectionString ────────────────────────────────────────────

describe('parseKustoConnectionString', () => {
	it('parses Data Source and Initial Catalog', () => {
		const result = parseKustoConnectionString('Data Source=https://mycluster.kusto.windows.net;Initial Catalog=MyDB');
		expect(result.dataSource).toBe('https://mycluster.kusto.windows.net');
		expect(result.initialCatalog).toBe('MyDB');
	});

	it('handles "datasource" key', () => {
		const result = parseKustoConnectionString('datasource=https://host;Database=db');
		expect(result.dataSource).toBe('https://host');
		expect(result.initialCatalog).toBe('db');
	});

	it('returns empty for empty string', () => {
		const result = parseKustoConnectionString('');
		expect(result.dataSource).toBe('');
		expect(result.initialCatalog).toBe('');
	});

	it('handles server key', () => {
		const result = parseKustoConnectionString('Server=https://example.com');
		expect(result.dataSource).toBe('https://example.com');
	});
});

// ── findConnectionIdForClusterUrl ─────────────────────────────────────────

describe('findConnectionIdForClusterUrl', () => {
	const connections = [
		{ id: 'conn1', clusterUrl: 'https://clusterA.kusto.windows.net' },
		{ id: 'conn2', clusterUrl: 'https://clusterB.kusto.windows.net' },
	];

	it('finds matching connection', () => {
		expect(findConnectionIdForClusterUrl('https://clusterA.kusto.windows.net', connections)).toBe('conn1');
	});

	it('matches case-insensitively', () => {
		expect(findConnectionIdForClusterUrl('https://CLUSTERA.kusto.windows.net', connections)).toBe('conn1');
	});

	it('returns empty for no match', () => {
		expect(findConnectionIdForClusterUrl('https://noexist.kusto.windows.net', connections)).toBe('');
	});

	it('returns empty for empty URL', () => {
		expect(findConnectionIdForClusterUrl('', connections)).toBe('');
	});
});
