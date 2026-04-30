import { describe, it, expect } from 'vitest';
import { CachedValuesViewerV2, getClusterCacheKey, mergeCachedDatabaseKeys } from '../../../src/host/cachedValuesViewer';

// ── getClusterCacheKey ───────────────────────────────────────────────────────

describe('getClusterCacheKey', () => {
	it('returns empty string for empty input', () => {
		expect(getClusterCacheKey('')).toBe('');
	});

	it('returns empty string for falsy input', () => {
		expect(getClusterCacheKey(null as any)).toBe('');
		expect(getClusterCacheKey(undefined as any)).toBe('');
	});

	it('extracts hostname from https URL', () => {
		expect(getClusterCacheKey('https://mycluster.kusto.windows.net')).toBe('mycluster.kusto.windows.net');
	});

	it('extracts hostname from http URL', () => {
		expect(getClusterCacheKey('http://mycluster.kusto.windows.net')).toBe('mycluster.kusto.windows.net');
	});

	it('adds https:// prefix when missing and extracts hostname', () => {
		expect(getClusterCacheKey('mycluster.kusto.windows.net')).toBe('mycluster.kusto.windows.net');
	});

	it('lowercases the hostname', () => {
		expect(getClusterCacheKey('https://MyCluster.Kusto.Windows.NET')).toBe('mycluster.kusto.windows.net');
	});

	it('strips path from URL', () => {
		expect(getClusterCacheKey('https://mycluster.kusto.windows.net/some/path')).toBe('mycluster.kusto.windows.net');
	});

	it('handles URL with trailing slash', () => {
		expect(getClusterCacheKey('https://mycluster.kusto.windows.net/')).toBe('mycluster.kusto.windows.net');
	});

	it('handles bare hostname without scheme', () => {
		expect(getClusterCacheKey('help')).toBe('help');
	});

	it('trims whitespace', () => {
		expect(getClusterCacheKey('  https://mycluster.kusto.windows.net  ')).toBe('mycluster.kusto.windows.net');
	});

	it('handles URL with port', () => {
		expect(getClusterCacheKey('https://mycluster.kusto.windows.net:443')).toBe('mycluster.kusto.windows.net');
	});

	it('returns lowercased input for unparseable URL', () => {
		// A single word without dots still gets parsed as hostname by URL constructor
		expect(getClusterCacheKey('localhost')).toBe('localhost');
	});
});

// ── mergeCachedDatabaseKeys ──────────────────────────────────────────────────

describe('mergeCachedDatabaseKeys', () => {
	it('returns empty result for empty input', () => {
		const { next, changed } = mergeCachedDatabaseKeys({}, new Map());
		expect(next).toEqual({});
		expect(changed).toBe(false);
	});

	it('passes through entries already keyed by hostname', () => {
		const { next, changed } = mergeCachedDatabaseKeys(
			{ 'mycluster.kusto.windows.net': ['db1', 'db2'] },
			new Map(),
		);
		expect(next['mycluster.kusto.windows.net']).toEqual(['db1', 'db2']);
		expect(changed).toBe(false);
	});

	it('resolves connection IDs to cluster hostnames via connById', () => {
		const connById = new Map([['conn-1', { clusterUrl: 'https://mycluster.kusto.windows.net' }]]);
		const { next, changed } = mergeCachedDatabaseKeys(
			{ 'conn-1': ['db1'] },
			connById,
		);
		expect(next['mycluster.kusto.windows.net']).toEqual(['db1']);
		expect(changed).toBe(true);
	});

	it('merges databases from duplicate keys', () => {
		const connById = new Map([
			['conn-1', { clusterUrl: 'https://mycluster.kusto.windows.net' }],
			['conn-2', { clusterUrl: 'https://MYCLUSTER.kusto.windows.net' }],
		]);
		const { next } = mergeCachedDatabaseKeys(
			{ 'conn-1': ['db1'], 'conn-2': ['db2'] },
			connById,
		);
		expect(next['mycluster.kusto.windows.net']).toEqual(['db1', 'db2']);
	});

	it('deduplicates databases case-insensitively', () => {
		const { next } = mergeCachedDatabaseKeys(
			{ 'host.kusto.windows.net': ['Db1', 'db1', 'DB1'] },
			new Map(),
		);
		// Keeps first occurrence
		expect(next['host.kusto.windows.net']).toEqual(['Db1']);
	});

	it('skips empty keys and marks changed', () => {
		const { next, changed } = mergeCachedDatabaseKeys(
			{ '': ['db1'], 'host.kusto.windows.net': ['db2'] },
			new Map(),
		);
		expect(next['']).toBeUndefined();
		expect(next['host.kusto.windows.net']).toEqual(['db2']);
		expect(changed).toBe(true);
	});

	it('handles null/undefined raw input gracefully', () => {
		const { next, changed } = mergeCachedDatabaseKeys(null as any, new Map());
		expect(next).toEqual({});
		expect(changed).toBe(false);
	});

	it('filters out empty database names', () => {
		const { next } = mergeCachedDatabaseKeys(
			{ 'host.kusto.windows.net': ['db1', '', '  ', 'db2'] },
			new Map(),
		);
		expect(next['host.kusto.windows.net']).toEqual(['db1', 'db2']);
	});

	it('handles non-array value gracefully', () => {
		const { next } = mergeCachedDatabaseKeys(
			{ 'host.kusto.windows.net': 'not-an-array' as any },
			new Map(),
		);
		expect(next['host.kusto.windows.net']).toEqual([]);
	});
});

// ── HTML shell ───────────────────────────────────────────────────────────────

describe('CachedValuesViewerV2 HTML shell', () => {
	it('opts into the shared page-level overlay scrollbar', () => {
		const webview = {
			cspSource: 'vscode-resource:',
			asWebviewUri: () => ({ toString: () => 'vscode-resource:/asset' }),
		};
		const html = (CachedValuesViewerV2.prototype as any).buildHtml.call({ extensionUri: {} }, webview);

		expect(html).toContain('<body data-kw-page-overlay-scroll="true">');
		expect(html).toContain('html, body { width: 100%; min-height: 100%; margin: 0; }');
		expect(html).toContain('kw-cached-values { display: block; width: 100%; }');
	});
});
