import { describe, it, expect } from 'vitest';
import {
	normalizeClusterUrl,
	pruneExpiredFileConnectionsSync,
	normalizeFilePath,
	FILE_CONNECTION_MAX_AGE_MS,
} from '../../../src/host/connectionManager';

// ── normalizeClusterUrl ───────────────────────────────────────────────────────
// This function is used throughout the extension for connection identity comparison.
// Getting it wrong means silently connecting to the wrong cluster or losing cached data.

describe('normalizeClusterUrl', () => {
	it('returns canonical logical key for bare public hostname', () => {
		expect(normalizeClusterUrl('mycluster.kusto.windows.net'))
			.toBe('mycluster');
	});

	it('maps https:// prefix to canonical logical key', () => {
		expect(normalizeClusterUrl('https://mycluster.kusto.windows.net'))
			.toBe('mycluster');
	});

	it('maps http:// prefix to canonical logical key', () => {
		expect(normalizeClusterUrl('http://mycluster.kusto.windows.net'))
			.toBe('mycluster');
	});

	it('lowercases the identity key', () => {
		expect(normalizeClusterUrl('HTTPS://MyCluster.Kusto.Windows.Net'))
			.toBe('mycluster');
	});

	it('strips trailing slashes', () => {
		expect(normalizeClusterUrl('https://mycluster.kusto.windows.net/'))
			.toBe('mycluster');
	});

	it('strips multiple trailing slashes', () => {
		expect(normalizeClusterUrl('https://mycluster.kusto.windows.net///'))
			.toBe('mycluster');
	});

	it('trims whitespace', () => {
		expect(normalizeClusterUrl('  mycluster.kusto.windows.net  '))
			.toBe('mycluster');
	});

	it('returns empty string for empty input', () => {
		expect(normalizeClusterUrl('')).toBe('');
	});

	it('returns empty string for null-ish input', () => {
		expect(normalizeClusterUrl(null as any)).toBe('');
		expect(normalizeClusterUrl(undefined as any)).toBe('');
	});

	it('returns empty string for whitespace-only input', () => {
		expect(normalizeClusterUrl('   ')).toBe('');
	});

	it('handles short public names', () => {
		expect(normalizeClusterUrl('help')).toBe('help');
	});

	it('handles regional cluster names', () => {
		expect(normalizeClusterUrl('mycluster.westus.kusto.windows.net'))
			.toBe('mycluster.westus');
	});

	it('ignores path segments for identity', () => {
		expect(normalizeClusterUrl('https://mycluster.kusto.windows.net/v1'))
			.toBe('mycluster');
	});

	it('handles HTTPS with mixed case', () => {
		expect(normalizeClusterUrl('HTTPS://Help.kusto.windows.net'))
			.toBe('help');
	});

	it('two URLs differing only in case normalize to the same value', () => {
		const a = normalizeClusterUrl('https://MyCluster.Kusto.Windows.Net');
		const b = normalizeClusterUrl('https://mycluster.kusto.windows.net');
		expect(a).toBe(b);
	});

	it('two URLs differing only in trailing slash normalize to the same value', () => {
		const a = normalizeClusterUrl('https://mycluster.kusto.windows.net/');
		const b = normalizeClusterUrl('https://mycluster.kusto.windows.net');
		expect(a).toBe(b);
	});

	it('two URLs where one has scheme and one does not normalize to the same value', () => {
		const a = normalizeClusterUrl('https://mycluster.kusto.windows.net');
		const b = normalizeClusterUrl('mycluster.kusto.windows.net');
		expect(a).toBe(b);
	});

	it('regional short and full forms normalize to the same value', () => {
		const a = normalizeClusterUrl('aoaiagents1.westus');
		const b = normalizeClusterUrl('https://aoaiagents1.westus.kusto.windows.net');
		expect(a).toBe(b);
	});
});

// ── pruneExpiredFileConnectionsSync ──────────────────────────────────────────

describe('pruneExpiredFileConnectionsSync', () => {
	const entry = (lastAccessedAt: number) => ({
		clusterUrl: 'https://c.kusto.windows.net',
		database: 'db',
		lastAccessedAt,
	});

	it('removes entries older than maxAge', () => {
		const now = Date.now();
		const cache: any = {
			fresh: entry(now - 1000),
			expired: entry(now - FILE_CONNECTION_MAX_AGE_MS - 1),
		};
		pruneExpiredFileConnectionsSync(cache, now);
		expect(cache).toHaveProperty('fresh');
		expect(cache).not.toHaveProperty('expired');
	});

	it('removes entries with missing lastAccessedAt', () => {
		const now = Date.now();
		const cache: any = {
			noTimestamp: { clusterUrl: 'https://x', database: 'db' },
		};
		pruneExpiredFileConnectionsSync(cache, now);
		expect(cache).not.toHaveProperty('noTimestamp');
	});

	it('removes null entries', () => {
		const now = Date.now();
		const cache: any = { bad: null };
		pruneExpiredFileConnectionsSync(cache, now);
		expect(cache).not.toHaveProperty('bad');
	});

	it('keeps entries exactly at the boundary', () => {
		const now = Date.now();
		const cache: any = {
			boundary: entry(now - FILE_CONNECTION_MAX_AGE_MS),
		};
		pruneExpiredFileConnectionsSync(cache, now);
		expect(cache).toHaveProperty('boundary');
	});

	it('removes entries 1ms past the boundary', () => {
		const now = Date.now();
		const cache: any = {
			justPast: entry(now - FILE_CONNECTION_MAX_AGE_MS - 1),
		};
		pruneExpiredFileConnectionsSync(cache, now);
		expect(cache).not.toHaveProperty('justPast');
	});

	it('handles empty cache', () => {
		const cache: any = {};
		pruneExpiredFileConnectionsSync(cache, Date.now());
		expect(Object.keys(cache)).toHaveLength(0);
	});

	it('keeps all fresh entries', () => {
		const now = Date.now();
		const cache: any = {
			a: entry(now),
			b: entry(now - 1000),
			c: entry(now - 86400000),
		};
		pruneExpiredFileConnectionsSync(cache, now);
		expect(Object.keys(cache)).toHaveLength(3);
	});

	it('works with custom maxAgeMs', () => {
		const now = Date.now();
		const cache: any = {
			recent: entry(now - 500),
			old: entry(now - 2000),
		};
		pruneExpiredFileConnectionsSync(cache, now, 1000);
		expect(cache).toHaveProperty('recent');
		expect(cache).not.toHaveProperty('old');
	});
});

// ── normalizeFilePath ────────────────────────────────────────────────────────

describe('normalizeFilePath', () => {
	it('returns empty string for empty input', () => {
		expect(normalizeFilePath('')).toBe('');
	});

	it('returns empty string for null/undefined', () => {
		expect(normalizeFilePath(null as any)).toBe('');
		expect(normalizeFilePath(undefined as any)).toBe('');
	});

	it('trims whitespace', () => {
		expect(normalizeFilePath('  /path/to/file  ', false)).toBe('/path/to/file');
	});

	it('lowercases on Windows', () => {
		expect(normalizeFilePath('C:\\Users\\Test\\File.kql', true)).toBe('c:\\users\\test\\file.kql');
	});

	it('preserves case on non-Windows', () => {
		expect(normalizeFilePath('/Users/Test/File.kql', false)).toBe('/Users/Test/File.kql');
	});

	it('handles UNC paths on Windows', () => {
		expect(normalizeFilePath('\\\\Server\\Share\\File.kql', true)).toBe('\\\\server\\share\\file.kql');
	});

	it('handles forward slashes on Windows', () => {
		expect(normalizeFilePath('C:/Users/Test/File.kql', true)).toBe('c:/users/test/file.kql');
	});
});
