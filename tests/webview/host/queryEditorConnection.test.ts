import { describe, it, expect } from 'vitest';
import {
	ensureHttpsUrl,
	getDefaultConnectionName,
	getClusterShortName,
	getClusterShortNameKey,
	getClusterCacheKey,
	normalizeFavoriteClusterUrl
} from '../../../src/host/queryEditorConnection';

describe('ensureHttpsUrl', () => {
	it('empty string → empty string', () => {
		expect(ensureHttpsUrl('')).toBe('');
	});

	it('bare hostname → https:// prepended', () => {
		expect(ensureHttpsUrl('mycluster.kusto.windows.net')).toBe('https://mycluster.kusto.windows.net');
	});

	it('http:// prefix is kept', () => {
		expect(ensureHttpsUrl('http://mycluster.kusto.windows.net')).toBe('http://mycluster.kusto.windows.net');
	});

	it('https:// prefix is kept unchanged', () => {
		expect(ensureHttpsUrl('https://mycluster.kusto.windows.net')).toBe('https://mycluster.kusto.windows.net');
	});

	it('whitespace is trimmed before adding scheme', () => {
		expect(ensureHttpsUrl('  mycluster  ')).toBe('https://mycluster');
	});

	it('preserves original casing when scheme is present', () => {
		expect(ensureHttpsUrl('HTTPS://MyCluster')).toBe('HTTPS://MyCluster');
	});

	it('leading slashes are stripped before prepending scheme', () => {
		expect(ensureHttpsUrl('///mycluster')).toBe('https://mycluster');
	});
});

describe('getDefaultConnectionName', () => {
	it('returns hostname for standard cluster URL', () => {
		expect(getDefaultConnectionName('https://mycluster.kusto.windows.net')).toBe('mycluster.kusto.windows.net');
	});

	it('empty string → fallback "Kusto Cluster"', () => {
		expect(getDefaultConnectionName('')).toBe('Kusto Cluster');
	});

	it('bare hostname → adds https:// then extracts hostname', () => {
		expect(getDefaultConnectionName('mycluster.kusto.windows.net')).toBe('mycluster.kusto.windows.net');
	});

	it('URL with path → returns only hostname', () => {
		expect(getDefaultConnectionName('https://mycluster.kusto.windows.net/some/path')).toBe('mycluster.kusto.windows.net');
	});
});

describe('getClusterShortName', () => {
	it('standard cluster URL → first hostname part', () => {
		expect(getClusterShortName('https://mycluster.kusto.windows.net')).toBe('mycluster');
	});

	it('multi-part hostname → first part only', () => {
		expect(getClusterShortName('https://mycluster.eastus2.kusto.windows.net')).toBe('mycluster');
	});

	it('bare hostname → first part', () => {
		expect(getClusterShortName('mycluster.kusto.windows.net')).toBe('mycluster');
	});

	it('single-word (no dots) → returned as-is', () => {
		expect(getClusterShortName('mycluster')).toBe('mycluster');
	});
});

describe('getClusterShortNameKey', () => {
	it('lowercases the short name', () => {
		expect(getClusterShortNameKey('https://MyCluster.kusto.windows.net')).toBe('mycluster');
	});

	it('already lowercase → unchanged', () => {
		expect(getClusterShortNameKey('https://mycluster.kusto.windows.net')).toBe('mycluster');
	});

	it('empty input → empty string', () => {
		expect(getClusterShortNameKey('')).toBe('');
	});

	it('bare hostname with mixed case → lowercased first part', () => {
		expect(getClusterShortNameKey('MyCluster.kusto.windows.net')).toBe('mycluster');
	});
});

describe('getClusterCacheKey', () => {
	it('standard URL → lowercase hostname', () => {
		expect(getClusterCacheKey('https://mycluster.kusto.windows.net')).toBe('mycluster.kusto.windows.net');
	});

	it('mixed case + trailing slash → normalized', () => {
		expect(getClusterCacheKey('HTTPS://MyCluster.KUSTO.Windows.NET/')).toBe('mycluster.kusto.windows.net');
	});

	it('no scheme → adds https:// first, then normalizes', () => {
		expect(getClusterCacheKey('mycluster.kusto.windows.net')).toBe('mycluster.kusto.windows.net');
	});

	it('empty input → empty string', () => {
		expect(getClusterCacheKey('')).toBe('');
	});

	it('whitespace → trimmed to empty', () => {
		expect(getClusterCacheKey('   ')).toBe('');
	});
});

describe('normalizeFavoriteClusterUrl', () => {
	it('bare hostname → https:// prepended', () => {
		expect(normalizeFavoriteClusterUrl('mycluster.kusto.windows.net')).toBe('https://mycluster.kusto.windows.net');
	});

	it('trailing slash is removed', () => {
		expect(normalizeFavoriteClusterUrl('https://mycluster.kusto.windows.net/')).toBe('https://mycluster.kusto.windows.net');
	});

	it('whitespace is trimmed', () => {
		expect(normalizeFavoriteClusterUrl('  https://mycluster  ')).toBe('https://mycluster');
	});

	it('empty input → empty string', () => {
		expect(normalizeFavoriteClusterUrl('')).toBe('');
	});

	it('multiple trailing slashes are removed', () => {
		expect(normalizeFavoriteClusterUrl('https://mycluster///')).toBe('https://mycluster');
	});
});
