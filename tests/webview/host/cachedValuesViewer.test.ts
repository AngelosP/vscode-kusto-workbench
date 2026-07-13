import { afterEach, describe, it, expect, vi } from 'vitest';
import * as vscode from 'vscode';
import { CachedValuesViewerV2, getClusterCacheKey, mergeCachedDatabaseKeys } from '../../../src/host/cachedValuesViewer';
import { captureSchemaCacheGeneration, clearCachedSchemas, deleteCachedSchemasForAccountPartitions, deleteCachedSchemasForConnections, SCHEMA_CACHE_VERSION, schemaCacheKey, writeCachedSchemaToDisk } from '../../../src/host/schemaCache';

afterEach(() => {
	vi.restoreAllMocks();
});

function createViewerHarness(): CachedValuesViewerV2 & Record<string, any> {
	return Object.create(CachedValuesViewerV2.prototype) as CachedValuesViewerV2 & Record<string, any>;
}

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
		expect(getClusterCacheKey('https://mycluster.kusto.windows.net')).toBe('mycluster');
	});

	it('extracts hostname from http URL', () => {
		expect(getClusterCacheKey('http://mycluster.kusto.windows.net')).toBe('mycluster');
	});

	it('adds https:// prefix when missing and extracts hostname', () => {
		expect(getClusterCacheKey('mycluster.kusto.windows.net')).toBe('mycluster');
	});

	it('lowercases the hostname', () => {
		expect(getClusterCacheKey('https://MyCluster.Kusto.Windows.NET')).toBe('mycluster');
	});

	it('strips path from URL', () => {
		expect(getClusterCacheKey('https://mycluster.kusto.windows.net/some/path')).toBe('mycluster');
	});

	it('handles URL with trailing slash', () => {
		expect(getClusterCacheKey('https://mycluster.kusto.windows.net/')).toBe('mycluster');
	});

	it('handles public short cluster without scheme', () => {
		expect(getClusterCacheKey('help')).toBe('help');
	});

	it('handles regional public short and full forms', () => {
		expect(getClusterCacheKey('aoaiagents1.westus')).toBe('aoaiagents1.westus');
		expect(getClusterCacheKey('https://aoaiagents1.westus.kusto.windows.net')).toBe('aoaiagents1.westus');
	});

	it('trims whitespace', () => {
		expect(getClusterCacheKey('  https://mycluster.kusto.windows.net  ')).toBe('mycluster');
	});

	it('handles URL with port', () => {
		expect(getClusterCacheKey('https://mycluster.kusto.windows.net:443')).toBe('mycluster');
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

	it('canonicalizes entries keyed by hostname', () => {
		const { next, changed } = mergeCachedDatabaseKeys(
			{ 'mycluster.kusto.windows.net': ['db1', 'db2'] },
			new Map(),
		);
		expect(next['mycluster']).toEqual(['db1', 'db2']);
		expect(changed).toBe(true);
	});

	it('resolves connection IDs to cluster hostnames via connById', () => {
		const connById = new Map([['conn-1', { clusterUrl: 'https://mycluster.kusto.windows.net' }]]);
		const { next, changed } = mergeCachedDatabaseKeys(
			{ 'conn-1': ['db1'] },
			connById,
		);
		expect(next['mycluster']).toEqual(['db1']);
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
		expect(next['mycluster']).toEqual(['db1', 'db2']);
	});

	it('deduplicates databases case-insensitively', () => {
		const { next } = mergeCachedDatabaseKeys(
			{ 'host.kusto.windows.net': ['Db1', 'db1', 'DB1'] },
			new Map(),
		);
		// Keeps first occurrence
		expect(next['host']).toEqual(['Db1']);
	});

	it('skips empty keys and marks changed', () => {
		const { next, changed } = mergeCachedDatabaseKeys(
			{ '': ['db1'], 'host.kusto.windows.net': ['db2'] },
			new Map(),
		);
		expect(next['']).toBeUndefined();
		expect(next['host']).toEqual(['db2']);
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
		expect(next['host']).toEqual(['db1', 'db2']);
	});

	it('handles non-array value gracefully', () => {
		const { next } = mergeCachedDatabaseKeys(
			{ 'host.kusto.windows.net': 'not-an-array' as any },
			new Map(),
		);
		expect(next['host']).toEqual([]);
	});
});

describe('deleteCachedSchemasForAccountPartitions', () => {
	it('deletes only schema files owned by the forgotten account partitions', async () => {
		const files = new Map<string, string>([
			['forgotten.json', JSON.stringify({ accountPartition: 'forgotten-partition' })],
			['retained.json', JSON.stringify({ accountPartition: 'retained-partition' })],
			['malformed.json', '{not json'],
		]);
		const deleted: string[] = [];
		const fsApi = vscode.workspace.fs as any;
		const originalReadDirectory = fsApi.readDirectory;
		const originalReadFile = fsApi.readFile;
		const originalDelete = fsApi.delete;
		fsApi.readDirectory = vi.fn(async () => [...files.keys()].map(fileName => [fileName, 1]));
		fsApi.readFile = vi.fn(async (uri: vscode.Uri) => {
			const fileName = uri.toString().split('/').pop() || '';
			return Buffer.from(files.get(fileName) || '', 'utf8');
		});
		fsApi.delete = vi.fn(async (uri: vscode.Uri) => {
			deleted.push(uri.toString().split('/').pop() || '');
		});

		try {
			const count = await deleteCachedSchemasForAccountPartitions(
				vscode.Uri.file('/global-storage'),
				new Set(['forgotten-partition']),
			);

			expect(count).toBe(1);
			expect(deleted).toEqual(['forgotten.json']);
		} finally {
			if (originalReadDirectory === undefined) delete fsApi.readDirectory;
			else fsApi.readDirectory = originalReadDirectory;
			fsApi.readFile = originalReadFile;
			if (originalDelete === undefined) delete fsApi.delete;
			else fsApi.delete = originalDelete;
		}
	});
});

describe('schema cache clear durability', () => {
	it('does not allow a paused old-generation write to recreate schema after Clear All', async () => {
		const storageUri = vscode.Uri.file('/schema-clear-race');
		const cacheKey = schemaCacheKey('https://cluster.kusto.windows.net', 'Db', 'connection-1', 'account-partition');
		const oldGeneration = captureSchemaCacheGeneration(storageUri);
		let releaseDirectory!: () => void;
		const directoryGate = new Promise<void>(resolve => { releaseDirectory = resolve; });
		const createDirectory = vi.spyOn(vscode.workspace.fs, 'createDirectory').mockImplementation(async () => {
			await directoryGate;
		});
		const writeFile = vi.spyOn(vscode.workspace.fs, 'writeFile').mockResolvedValue(undefined);
		const fsApi = vscode.workspace.fs as any;
		const originalDelete = fsApi.delete;
		const deletePath = vi.fn(async () => undefined);
		fsApi.delete = deletePath;
		const entry = {
			schema: { tables: ['LateTable'], columnTypesByTable: {}, functions: [] },
			timestamp: Date.now(),
			version: SCHEMA_CACHE_VERSION,
			clusterUrl: 'https://cluster.kusto.windows.net',
			database: 'Db',
			connectionId: 'connection-1',
			accountPartition: 'account-partition',
		};

		try {
			const oldWrite = writeCachedSchemaToDisk(storageUri, cacheKey, entry, oldGeneration);
			await vi.waitFor(() => expect(createDirectory).toHaveBeenCalledOnce());
			const clear = clearCachedSchemas(storageUri);
			releaseDirectory();
			await Promise.all([oldWrite, clear]);

			expect(writeFile).not.toHaveBeenCalled();
			expect(deletePath).toHaveBeenCalledWith(expect.anything(), { recursive: true, useTrash: false });
		} finally {
			if (originalDelete === undefined) delete fsApi.delete;
			else fsApi.delete = originalDelete;
		}
	});

	it('does not invalidate a connection A schema write when connection B schemas are deleted', async () => {
		const storageUri = vscode.Uri.file('/schema-connection-isolation');
		const cacheKey = schemaCacheKey('https://a.kusto.windows.net', 'DbA', 'connection-a', 'partition-a');
		const generationA = captureSchemaCacheGeneration(storageUri, 'connection-a', 'partition-a');
		const fsApi = vscode.workspace.fs as any;
		const originalReadDirectory = fsApi.readDirectory;
		const originalCreateDirectory = fsApi.createDirectory;
		const originalWriteFile = fsApi.writeFile;
		fsApi.readDirectory = vi.fn(async () => []);
		fsApi.createDirectory = vi.fn(async () => undefined);
		fsApi.writeFile = vi.fn(async () => undefined);

		try {
			await deleteCachedSchemasForConnections(storageUri, new Set(['connection-b']));
			await writeCachedSchemaToDisk(storageUri, cacheKey, {
				schema: { tables: ['TableA'], columnTypesByTable: {}, functions: [] },
				timestamp: Date.now(), version: SCHEMA_CACHE_VERSION,
				clusterUrl: 'https://a.kusto.windows.net', database: 'DbA', connectionId: 'connection-a', accountPartition: 'partition-a',
			}, generationA);

			expect(fsApi.writeFile).toHaveBeenCalledOnce();
		} finally {
			fsApi.readDirectory = originalReadDirectory;
			fsApi.createDirectory = originalCreateDirectory;
			fsApi.writeFile = originalWriteFile;
		}
	});
});

describe('CachedValuesViewerV2 Kusto mutation completion', () => {
	it('posts the refreshed snapshot only after an account preference mutation settles', async () => {
		let settleMutation!: () => void;
		const mutationGate = new Promise<void>(resolve => { settleMutation = resolve; });
		const events: string[] = [];
		const viewer = createViewerHarness();
		viewer.authPreferences = {
			getAccounts: vi.fn(async () => [{ id: 'account-1', label: 'Account one' }]),
			setExplicitAccount: vi.fn(async () => {
				await mutationGate;
				events.push('mutation');
			}),
		};
		viewer.sendSnapshotToWebview = vi.fn(async () => { events.push('snapshot'); });
		viewer.panel = { webview: { postMessage: vi.fn(async (message: { type: string }) => { events.push(message.type); }) } };

		const completion = viewer.onMessage({ type: 'connectionPreference.set', connectionId: 'connection-1', accountId: 'account-1' });
		await Promise.resolve();
		expect(events).toEqual([]);

		settleMutation();
		await completion;
		expect(events).toEqual(['mutation', 'snapshot', 'kustoMutationComplete']);
	});

	it('refreshes and completes when Forget Account is cancelled', async () => {
		vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined as any);
		const viewer = createViewerHarness();
		viewer.clearKustoAccountCachedData = vi.fn();
		viewer.authPreferences = { forgetAccount: vi.fn() };
		viewer.sendSnapshotToWebview = vi.fn(async () => undefined);
		viewer.panel = { webview: { postMessage: vi.fn(async () => true) } };

		await viewer.onMessage({ type: 'auth.forgetAccount', accountId: 'account-1' });

		expect(viewer.clearKustoAccountCachedData).not.toHaveBeenCalled();
		expect(viewer.authPreferences.forgetAccount).not.toHaveBeenCalled();
		expect(viewer.sendSnapshotToWebview).toHaveBeenCalledOnce();
		expect(viewer.panel.webview.postMessage).toHaveBeenCalledWith({ type: 'kustoMutationComplete' });
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
