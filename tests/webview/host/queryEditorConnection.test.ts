import { describe, it, expect } from 'vitest';
import {
	ensureHttpsUrl,
	getDefaultConnectionName,
	getClusterShortName,
	getClusterShortNameKey,
	getClusterCacheKey,
	normalizeFavoriteClusterUrl,
	ConnectionService
} from '../../../src/host/queryEditorConnection';
import { STORAGE_KEYS } from '../../../src/host/queryEditorTypes';

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

// ── ConnectionService ─────────────────────────────────────────────────────────

function makeMockHost(overrides: Partial<Record<string, any>> = {}) {
	const globalState = new Map<string, any>();
	return {
		connectionManager: {
			getConnections: () => overrides.connections ?? [],
			getLeaveNoTraceClusters: () => [],
		},
		context: {
			globalState: {
				get: <T>(key: string, fallback?: T) => globalState.has(key) ? globalState.get(key) : fallback,
				update: async (key: string, value: any) => { globalState.set(key, value); },
			},
		},
		kustoClient: {
			getDatabases: async () => [],
			isAuthenticationError: () => false,
		},
		output: { appendLine: () => {} },
		postMessage: overrides.postMessage ?? (() => {}),
		formatQueryExecutionErrorForUser: () => 'error',
		normalizeClusterUrlKey: (url: string) => url.toLowerCase(),
		getCachedSchemaFromDisk: async () => undefined,
		_globalState: globalState,
	};
}

describe('ConnectionService — saveLastSelection & getters', () => {
	it('saves and retrieves lastConnectionId', async () => {
		const host = makeMockHost();
		const svc = new ConnectionService(host as any);
		await svc.saveLastSelection('conn-123', 'mydb');
		expect(svc.getLastConnectionId()).toBe('conn-123');
		expect(svc.getLastDatabase()).toBe('mydb');
	});

	it('getLastConnectionId returns undefined before any selection', () => {
		const host = makeMockHost();
		const svc = new ConnectionService(host as any);
		expect(svc.getLastConnectionId()).toBeUndefined();
	});

	it('getLastDatabase returns undefined before any selection', () => {
		const host = makeMockHost();
		const svc = new ConnectionService(host as any);
		expect(svc.getLastDatabase()).toBeUndefined();
	});

	it('persists to globalState', async () => {
		const host = makeMockHost();
		const svc = new ConnectionService(host as any);
		await svc.saveLastSelection('conn-456', 'db2');
		expect(host._globalState.get(STORAGE_KEYS.lastConnectionId)).toBe('conn-456');
		expect(host._globalState.get(STORAGE_KEYS.lastDatabase)).toBe('db2');
	});
});

describe('ConnectionService — findConnection', () => {
	it('finds connection by id', () => {
		const conn = { id: 'c1', name: 'Test', clusterUrl: 'https://test.kusto.windows.net' };
		const host = makeMockHost({ connections: [conn] });
		const svc = new ConnectionService(host as any);
		expect(svc.findConnection('c1')).toBe(conn);
	});

	it('returns undefined for unknown id', () => {
		const host = makeMockHost({ connections: [] });
		const svc = new ConnectionService(host as any);
		expect(svc.findConnection('nonexistent')).toBeUndefined();
	});
});

describe('ConnectionService — getFavorites', () => {
	it('returns empty array when no favorites stored', () => {
		const host = makeMockHost();
		const svc = new ConnectionService(host as any);
		expect(svc.getFavorites()).toEqual([]);
	});

	it('returns valid favorites from storage', async () => {
		const host = makeMockHost();
		const favs = [{ name: 'My Fav', clusterUrl: 'https://test', database: 'db1' }];
		await host.context.globalState.update(STORAGE_KEYS.favorites, favs);
		const svc = new ConnectionService(host as any);
		const result = svc.getFavorites();
		expect(result).toHaveLength(1);
		expect(result[0].name).toBe('My Fav');
	});

	it('skips invalid favorites (missing fields)', async () => {
		const host = makeMockHost();
		const favs = [
			{ name: 'Good', clusterUrl: 'https://test', database: 'db1' },
			{ name: '', clusterUrl: 'https://test', database: 'db1' }, // empty name
			{ clusterUrl: 'https://test', database: 'db1' }, // missing name
			null,
			42,
		];
		await host.context.globalState.update(STORAGE_KEYS.favorites, favs);
		const svc = new ConnectionService(host as any);
		const result = svc.getFavorites();
		expect(result).toHaveLength(1);
		expect(result[0].name).toBe('Good');
	});
});

describe('ConnectionService — getCachedDatabases', () => {
	it('returns empty object when nothing cached', () => {
		const host = makeMockHost();
		const svc = new ConnectionService(host as any);
		expect(svc.getCachedDatabases()).toEqual({});
	});

	it('returns cached databases', async () => {
		const host = makeMockHost();
		await host.context.globalState.update(STORAGE_KEYS.cachedDatabases, {
			'test.kusto.windows.net': ['db1', 'db2'],
		});
		const svc = new ConnectionService(host as any);
		const result = svc.getCachedDatabases();
		expect(result['test.kusto.windows.net']).toEqual(['db1', 'db2']);
	});
});

describe('ConnectionService — removeFavorite', () => {
	it('removes matching favorite', async () => {
		const postMessage = () => {};
		const host = makeMockHost({ postMessage });
		const favs = [
			{ name: 'Keep', clusterUrl: 'https://keep', database: 'db' },
			{ name: 'Remove', clusterUrl: 'https://remove', database: 'db' },
		];
		await host.context.globalState.update(STORAGE_KEYS.favorites, favs);
		const svc = new ConnectionService(host as any);
		await svc.removeFavorite('https://remove', 'db');
		const result = svc.getFavorites();
		expect(result).toHaveLength(1);
		expect(result[0].name).toBe('Keep');
	});

	it('does nothing when clusterUrl is empty', async () => {
		const host = makeMockHost();
		const svc = new ConnectionService(host as any);
		await svc.removeFavorite('', 'db'); // should not throw
	});

	it('does nothing when database is empty', async () => {
		const host = makeMockHost();
		const svc = new ConnectionService(host as any);
		await svc.removeFavorite('https://test', ''); // should not throw
	});
});
