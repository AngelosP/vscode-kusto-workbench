import * as assert from 'assert';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readAllCachedSchemasFromDisk, CachedSchemaEntry, SCHEMA_CACHE_VERSION } from '../schemaCache';

suite('readAllCachedSchemasFromDisk', () => {
	let tmpDir: string;
	let cacheDir: string;
	let globalStorageUri: vscode.Uri;

	setup(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-schema-test-'));
		cacheDir = path.join(tmpDir, 'schemaCache');
		fs.mkdirSync(cacheDir, { recursive: true });
		globalStorageUri = vscode.Uri.file(tmpDir);
	});

	teardown(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	function writeCacheFile(fileName: string, content: object): void {
		fs.writeFileSync(path.join(cacheDir, fileName), JSON.stringify(content), 'utf8');
	}

	test('returns schemas from cache files that include clusterUrl and database', async () => {
		const entry: CachedSchemaEntry = {
			schema: {
				tables: ['StormEvents', 'PopulationData'],
				columnTypesByTable: {
					StormEvents: { EventType: 'string', StartTime: 'datetime' },
					PopulationData: { State: 'string', Population: 'long' }
				},
				functions: [{ name: 'MyFunc' } as any],
			},
			timestamp: Date.now(),
			version: SCHEMA_CACHE_VERSION,
			clusterUrl: 'https://help.kusto.windows.net',
			database: 'Samples'
		};
		writeCacheFile('abc123.json', entry);

		const results = await readAllCachedSchemasFromDisk(globalStorageUri);
		assert.strictEqual(results.length, 1);
		assert.strictEqual(results[0].clusterUrl, 'https://help.kusto.windows.net');
		assert.strictEqual(results[0].database, 'Samples');
		assert.deepStrictEqual(results[0].tables, ['StormEvents', 'PopulationData']);
		assert.deepStrictEqual(results[0].functions, ['MyFunc']);
	});

	test('skips cache files without clusterUrl/database metadata (old format)', async () => {
		// Old format: no clusterUrl or database in the file
		const oldEntry = {
			schema: {
				tables: ['SomeTable'],
				columnTypesByTable: { SomeTable: { col: 'string' } },
			},
			timestamp: Date.now(),
			version: SCHEMA_CACHE_VERSION,
		};
		writeCacheFile('oldfile.json', oldEntry);

		const results = await readAllCachedSchemasFromDisk(globalStorageUri);
		assert.strictEqual(results.length, 0, 'Should skip entries without origin metadata');
	});

	test('filters by clusterUrl', async () => {
		writeCacheFile('a.json', {
			schema: { tables: ['T1'], columnTypesByTable: { T1: { c: 'string' } } },
			timestamp: Date.now(), version: SCHEMA_CACHE_VERSION,
			clusterUrl: 'https://cluster-a.kusto.windows.net', database: 'db1'
		});
		writeCacheFile('b.json', {
			schema: { tables: ['T2'], columnTypesByTable: { T2: { c: 'string' } } },
			timestamp: Date.now(), version: SCHEMA_CACHE_VERSION,
			clusterUrl: 'https://cluster-b.kusto.windows.net', database: 'db2'
		});

		const results = await readAllCachedSchemasFromDisk(globalStorageUri, 'https://cluster-a.kusto.windows.net');
		assert.strictEqual(results.length, 1);
		assert.strictEqual(results[0].clusterUrl, 'https://cluster-a.kusto.windows.net');
	});

	test('filters by database', async () => {
		writeCacheFile('a.json', {
			schema: { tables: ['T1'], columnTypesByTable: { T1: { c: 'string' } } },
			timestamp: Date.now(), version: SCHEMA_CACHE_VERSION,
			clusterUrl: 'https://cluster.kusto.windows.net', database: 'Samples'
		});
		writeCacheFile('b.json', {
			schema: { tables: ['T2'], columnTypesByTable: { T2: { c: 'string' } } },
			timestamp: Date.now(), version: SCHEMA_CACHE_VERSION,
			clusterUrl: 'https://cluster.kusto.windows.net', database: 'Logs'
		});

		const results = await readAllCachedSchemasFromDisk(globalStorageUri, undefined, 'Logs');
		assert.strictEqual(results.length, 1);
		assert.strictEqual(results[0].database, 'Logs');
	});

	test('returns empty array when cache directory does not exist', async () => {
		// Point to a non-existent directory
		const noDir = vscode.Uri.file(path.join(tmpDir, 'nonexistent'));
		const results = await readAllCachedSchemasFromDisk(noDir);
		assert.strictEqual(results.length, 0);
	});

	test('returns empty array when cache directory is empty', async () => {
		const results = await readAllCachedSchemasFromDisk(globalStorageUri);
		assert.strictEqual(results.length, 0);
	});

	test('clusterUrl filter is case-insensitive and ignores trailing slashes', async () => {
		writeCacheFile('x.json', {
			schema: { tables: ['T1'], columnTypesByTable: { T1: { c: 'string' } } },
			timestamp: Date.now(), version: SCHEMA_CACHE_VERSION,
			clusterUrl: 'https://Help.Kusto.Windows.Net/', database: 'Samples'
		});

		const results = await readAllCachedSchemasFromDisk(globalStorageUri, 'https://help.kusto.windows.net');
		assert.strictEqual(results.length, 1);
	});

	test('skips non-JSON files in cache directory', async () => {
		fs.writeFileSync(path.join(cacheDir, 'readme.txt'), 'not a cache file', 'utf8');
		writeCacheFile('valid.json', {
			schema: { tables: ['T1'], columnTypesByTable: { T1: { c: 'string' } } },
			timestamp: Date.now(), version: SCHEMA_CACHE_VERSION,
			clusterUrl: 'https://cluster.kusto.windows.net', database: 'db'
		});

		const results = await readAllCachedSchemasFromDisk(globalStorageUri);
		assert.strictEqual(results.length, 1);
	});

	test('skips files with invalid JSON', async () => {
		fs.writeFileSync(path.join(cacheDir, 'bad.json'), '{not valid json', 'utf8');
		writeCacheFile('good.json', {
			schema: { tables: ['T1'], columnTypesByTable: { T1: { c: 'string' } } },
			timestamp: Date.now(), version: SCHEMA_CACHE_VERSION,
			clusterUrl: 'https://cluster.kusto.windows.net', database: 'db'
		});

		const results = await readAllCachedSchemasFromDisk(globalStorageUri);
		assert.strictEqual(results.length, 1);
	});

	test('multiple databases returned for a single cluster', async () => {
		writeCacheFile('s1.json', {
			schema: { tables: ['T1'], columnTypesByTable: { T1: { c: 'string' } } },
			timestamp: Date.now(), version: SCHEMA_CACHE_VERSION,
			clusterUrl: 'https://cluster.kusto.windows.net', database: 'db1'
		});
		writeCacheFile('s2.json', {
			schema: { tables: ['T2'], columnTypesByTable: { T2: { c: 'string' } } },
			timestamp: Date.now(), version: SCHEMA_CACHE_VERSION,
			clusterUrl: 'https://cluster.kusto.windows.net', database: 'db2'
		});
		writeCacheFile('s3.json', {
			schema: { tables: ['T3'], columnTypesByTable: { T3: { c: 'string' } } },
			timestamp: Date.now(), version: SCHEMA_CACHE_VERSION,
			clusterUrl: 'https://other.kusto.windows.net', database: 'db3'
		});

		const all = await readAllCachedSchemasFromDisk(globalStorageUri);
		assert.strictEqual(all.length, 3);

		const forCluster = await readAllCachedSchemasFromDisk(globalStorageUri, 'https://cluster.kusto.windows.net');
		assert.strictEqual(forCluster.length, 2);
	});
});
