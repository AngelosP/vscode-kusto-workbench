import * as assert from 'assert';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readAllCachedSchemasFromDisk, searchCachedSchemas, writeCachedSchemaToDisk, CachedSchemaEntry, SCHEMA_CACHE_VERSION } from '../../src/host/schemaCache';

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

suite('searchCachedSchemas', () => {
	let tmpDir: string;
	let cacheDir: string;
	let globalStorageUri: vscode.Uri;

	setup(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-schema-search-test-'));
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

	function makeEntry(overrides: Partial<CachedSchemaEntry> & { clusterUrl: string; database: string }): CachedSchemaEntry {
		return {
			schema: {
				tables: [],
				columnTypesByTable: {},
			},
			timestamp: Date.now(),
			version: SCHEMA_CACHE_VERSION,
			...overrides
		};
	}

	test('matches table names by regex', async () => {
		writeCacheFile('a.json', makeEntry({
			clusterUrl: 'https://cluster.kusto.windows.net',
			database: 'Samples',
			schema: {
				tables: ['StormEvents', 'PopulationData', 'ContosoSales'],
				columnTypesByTable: {
					StormEvents: { EventType: 'string' },
					PopulationData: { State: 'string' },
					ContosoSales: { Region: 'string' }
				}
			}
		}));

		const results = await searchCachedSchemas(globalStorageUri, 'storm');
		assert.strictEqual(results.length, 1);
		assert.strictEqual(results[0].kind, 'table');
		assert.strictEqual(results[0].name, 'StormEvents');
	});

	test('matches column names by regex', async () => {
		writeCacheFile('a.json', makeEntry({
			clusterUrl: 'https://cluster.kusto.windows.net',
			database: 'Samples',
			schema: {
				tables: ['StormEvents'],
				columnTypesByTable: {
					StormEvents: { EventType: 'string', StartTime: 'datetime', EndTime: 'datetime' }
				}
			}
		}));

		const results = await searchCachedSchemas(globalStorageUri, 'time$');
		assert.strictEqual(results.length, 2);
		assert.ok(results.every(r => r.kind === 'column'));
		assert.ok(results.some(r => r.name === 'StartTime'));
		assert.ok(results.some(r => r.name === 'EndTime'));
		assert.strictEqual(results[0].table, 'StormEvents');
		assert.strictEqual(results[0].type, 'datetime');
	});

	test('matches function names by regex', async () => {
		writeCacheFile('a.json', makeEntry({
			clusterUrl: 'https://cluster.kusto.windows.net',
			database: 'Samples',
			schema: {
				tables: [],
				columnTypesByTable: {},
				functions: [
					{ name: 'GetRecentErrors', parametersText: '(hours: int)', docString: 'Returns recent errors' },
					{ name: 'ComputeMetrics', parametersText: '()' }
				]
			}
		}));

		const results = await searchCachedSchemas(globalStorageUri, 'recent');
		assert.strictEqual(results.length, 1);
		assert.strictEqual(results[0].kind, 'function');
		assert.strictEqual(results[0].name, 'GetRecentErrors');
		assert.strictEqual(results[0].docString, 'Returns recent errors');
		assert.strictEqual(results[0].parametersText, '(hours: int)');
	});

	test('matches table docstrings when table name does not match', async () => {
		writeCacheFile('a.json', makeEntry({
			clusterUrl: 'https://cluster.kusto.windows.net',
			database: 'Samples',
			schema: {
				tables: ['Events'],
				columnTypesByTable: { Events: { Id: 'long' } },
				tableDocStrings: { Events: 'Weather-related incidents' }
			}
		}));

		const results = await searchCachedSchemas(globalStorageUri, 'weather');
		assert.strictEqual(results.length, 1);
		assert.strictEqual(results[0].kind, 'tableDocString');
		assert.strictEqual(results[0].name, 'Events');
		assert.strictEqual(results[0].docString, 'Weather-related incidents');
	});

	test('avoids duplicate when both table name and docstring match', async () => {
		writeCacheFile('a.json', makeEntry({
			clusterUrl: 'https://cluster.kusto.windows.net',
			database: 'Samples',
			schema: {
				tables: ['WeatherEvents'],
				columnTypesByTable: { WeatherEvents: { Id: 'long' } },
				tableDocStrings: { WeatherEvents: 'Weather-related incidents' }
			}
		}));

		const results = await searchCachedSchemas(globalStorageUri, 'weather');
		// Should have exactly 1 match (the table), not a duplicate for the docstring
		assert.strictEqual(results.length, 1);
		assert.strictEqual(results[0].kind, 'table');
		assert.strictEqual(results[0].docString, 'Weather-related incidents');
	});

	test('matches column docstrings when column name does not match', async () => {
		writeCacheFile('a.json', makeEntry({
			clusterUrl: 'https://cluster.kusto.windows.net',
			database: 'Samples',
			schema: {
				tables: ['Events'],
				columnTypesByTable: { Events: { Code: 'int' } },
				columnDocStrings: { 'Events.Code': 'ISO country code' }
			}
		}));

		const results = await searchCachedSchemas(globalStorageUri, 'country');
		assert.strictEqual(results.length, 1);
		assert.strictEqual(results[0].kind, 'columnDocString');
		assert.strictEqual(results[0].name, 'Code');
		assert.strictEqual(results[0].table, 'Events');
		assert.strictEqual(results[0].docString, 'ISO country code');
	});

	test('matches function docstrings when function name does not match', async () => {
		writeCacheFile('a.json', makeEntry({
			clusterUrl: 'https://cluster.kusto.windows.net',
			database: 'Samples',
			schema: {
				tables: [],
				columnTypesByTable: {},
				functions: [
					{ name: 'fn1', docString: 'Calculates revenue per region' }
				]
			}
		}));

		const results = await searchCachedSchemas(globalStorageUri, 'revenue');
		assert.strictEqual(results.length, 1);
		assert.strictEqual(results[0].kind, 'functionDocString');
		assert.strictEqual(results[0].name, 'fn1');
		assert.strictEqual(results[0].docString, 'Calculates revenue per region');
	});

	test('search is case-insensitive', async () => {
		writeCacheFile('a.json', makeEntry({
			clusterUrl: 'https://cluster.kusto.windows.net',
			database: 'Samples',
			schema: {
				tables: ['StormEvents'],
				columnTypesByTable: { StormEvents: { EventType: 'string' } }
			}
		}));

		const upper = await searchCachedSchemas(globalStorageUri, 'STORM');
		const lower = await searchCachedSchemas(globalStorageUri, 'storm');
		assert.strictEqual(upper.length, 1);
		assert.strictEqual(lower.length, 1);
	});

	test('returns empty array for invalid regex', async () => {
		writeCacheFile('a.json', makeEntry({
			clusterUrl: 'https://cluster.kusto.windows.net',
			database: 'Samples',
			schema: { tables: ['T1'], columnTypesByTable: { T1: { c: 'string' } } }
		}));

		const results = await searchCachedSchemas(globalStorageUri, '[invalid');
		assert.strictEqual(results.length, 0);
	});

	test('returns empty array when no cache files exist', async () => {
		const results = await searchCachedSchemas(globalStorageUri, '.*');
		assert.strictEqual(results.length, 0);
	});

	test('respects maxResults limit', async () => {
		writeCacheFile('a.json', makeEntry({
			clusterUrl: 'https://cluster.kusto.windows.net',
			database: 'Samples',
			schema: {
				tables: ['T1', 'T2', 'T3', 'T4', 'T5'],
				columnTypesByTable: {
					T1: { c: 'string' }, T2: { c: 'string' }, T3: { c: 'string' },
					T4: { c: 'string' }, T5: { c: 'string' }
				}
			}
		}));

		const results = await searchCachedSchemas(globalStorageUri, 'T', 3);
		assert.strictEqual(results.length, 3);
	});

	test('searches across multiple databases', async () => {
		writeCacheFile('a.json', makeEntry({
			clusterUrl: 'https://cluster.kusto.windows.net',
			database: 'db1',
			schema: {
				tables: ['UsersTable'],
				columnTypesByTable: { UsersTable: { UserId: 'string' } }
			}
		}));
		writeCacheFile('b.json', makeEntry({
			clusterUrl: 'https://cluster.kusto.windows.net',
			database: 'db2',
			schema: {
				tables: ['OrdersTable'],
				columnTypesByTable: { OrdersTable: { UserId: 'string' } }
			}
		}));

		const tableResults = await searchCachedSchemas(globalStorageUri, 'users');
		assert.strictEqual(tableResults.length, 1);
		assert.strictEqual(tableResults[0].database, 'db1');

		const colResults = await searchCachedSchemas(globalStorageUri, 'userid');
		assert.strictEqual(colResults.length, 2);
	});

	test('skips cache files without clusterUrl/database', async () => {
		writeCacheFile('old.json', {
			schema: { tables: ['MyTable'], columnTypesByTable: { MyTable: { c: 'string' } } },
			timestamp: Date.now(),
			version: SCHEMA_CACHE_VERSION
		});

		const results = await searchCachedSchemas(globalStorageUri, 'MyTable');
		assert.strictEqual(results.length, 0);
	});

	test('matches table folder paths', async () => {
		writeCacheFile('a.json', makeEntry({
			clusterUrl: 'https://cluster.kusto.windows.net',
			database: 'Samples',
			schema: {
				tables: ['DeviceEvents'],
				columnTypesByTable: { DeviceEvents: { Id: 'long' } },
				tableFolders: { DeviceEvents: 'Telemetry/IoT' }
			}
		}));

		const results = await searchCachedSchemas(globalStorageUri, 'IoT');
		assert.strictEqual(results.length, 1);
		assert.strictEqual(results[0].kind, 'tableFolder');
		assert.strictEqual(results[0].name, 'DeviceEvents');
	});

	test('avoids duplicate when table name already matched (folder also matches)', async () => {
		writeCacheFile('a.json', makeEntry({
			clusterUrl: 'https://cluster.kusto.windows.net',
			database: 'Samples',
			schema: {
				tables: ['IoTEvents'],
				columnTypesByTable: { IoTEvents: { Id: 'long' } },
				tableFolders: { IoTEvents: 'IoT/Telemetry' }
			}
		}));

		const results = await searchCachedSchemas(globalStorageUri, 'IoT');
		assert.strictEqual(results.length, 1);
		assert.strictEqual(results[0].kind, 'table');
	});

	test('matches column types', async () => {
		writeCacheFile('a.json', makeEntry({
			clusterUrl: 'https://cluster.kusto.windows.net',
			database: 'Samples',
			schema: {
				tables: ['Events'],
				columnTypesByTable: { Events: { Id: 'long', Name: 'string', Created: 'datetime' } }
			}
		}));

		const results = await searchCachedSchemas(globalStorageUri, 'datetime');
		assert.strictEqual(results.length, 1);
		assert.strictEqual(results[0].kind, 'columnType');
		assert.strictEqual(results[0].name, 'Created');
		assert.strictEqual(results[0].type, 'datetime');
	});

	test('matches function folder paths', async () => {
		writeCacheFile('a.json', makeEntry({
			clusterUrl: 'https://cluster.kusto.windows.net',
			database: 'Samples',
			schema: {
				tables: [],
				columnTypesByTable: {},
				functions: [
					{ name: 'GetErrors', folder: 'Monitoring/Alerts', parametersText: '()' }
				]
			}
		}));

		const results = await searchCachedSchemas(globalStorageUri, 'Monitoring');
		assert.strictEqual(results.length, 1);
		assert.strictEqual(results[0].kind, 'functionFolder');
		assert.strictEqual(results[0].name, 'GetErrors');
	});

	test('matches function parametersText', async () => {
		writeCacheFile('a.json', makeEntry({
			clusterUrl: 'https://cluster.kusto.windows.net',
			database: 'Samples',
			schema: {
				tables: [],
				columnTypesByTable: {},
				functions: [
					{ name: 'fn1', parametersText: '(deviceId: string, region: string)' }
				]
			}
		}));

		const results = await searchCachedSchemas(globalStorageUri, 'deviceId');
		assert.strictEqual(results.length, 1);
		assert.strictEqual(results[0].kind, 'functionParameter');
		assert.strictEqual(results[0].name, 'fn1');
	});

	test('matches function body', async () => {
		writeCacheFile('a.json', makeEntry({
			clusterUrl: 'https://cluster.kusto.windows.net',
			database: 'Samples',
			schema: {
				tables: [],
				columnTypesByTable: {},
				functions: [
					{ name: 'fn1', body: 'DeviceEvents | where sku == "premium"' }
				]
			}
		}));

		const results = await searchCachedSchemas(globalStorageUri, 'sku');
		assert.strictEqual(results.length, 1);
		assert.strictEqual(results[0].kind, 'functionBody');
		assert.strictEqual(results[0].name, 'fn1');
	});

	test('matches function parameter names from parameters array', async () => {
		writeCacheFile('a.json', makeEntry({
			clusterUrl: 'https://cluster.kusto.windows.net',
			database: 'Samples',
			schema: {
				tables: [],
				columnTypesByTable: {},
				functions: [
					{
						name: 'ComputeMetrics',
						parameters: [
							{ name: 'regionFilter', type: 'string' },
							{ name: 'days', type: 'int' }
						]
					}
				]
			}
		}));

		const results = await searchCachedSchemas(globalStorageUri, 'regionFilter');
		assert.strictEqual(results.length, 1);
		assert.strictEqual(results[0].kind, 'functionParameter');
		assert.strictEqual(results[0].name, 'ComputeMetrics');
	});

	test('matches function parameter types from parameters array', async () => {
		writeCacheFile('a.json', makeEntry({
			clusterUrl: 'https://cluster.kusto.windows.net',
			database: 'Samples',
			schema: {
				tables: [],
				columnTypesByTable: {},
				functions: [
					{
						name: 'MyFunc',
						parameters: [
							{ name: 'input', type: 'dynamic' }
						]
					}
				]
			}
		}));

		const results = await searchCachedSchemas(globalStorageUri, '^dynamic$');
		assert.strictEqual(results.length, 1);
		assert.strictEqual(results[0].kind, 'functionParameter');
		assert.strictEqual(results[0].name, 'MyFunc');
	});

	test('regex alternation searches across tables, columns, functions, and metadata', async () => {
		writeCacheFile('a.json', makeEntry({
			clusterUrl: 'https://cluster.kusto.windows.net',
			database: 'Samples',
			schema: {
				tables: ['DeviceEvents', 'UserSessions'],
				columnTypesByTable: {
					DeviceEvents: { DeviceId: 'string', SKU: 'string', Region: 'string' },
					UserSessions: { SessionId: 'string', Duration: 'long' }
				},
				functions: [
					{ name: 'GetDeviceMetrics', parametersText: '(sku: string)', body: 'DeviceEvents | summarize by Region' }
				]
			}
		}));

		const results = await searchCachedSchemas(globalStorageUri, 'deviceid|sku|region');
		// Should match: DeviceId (column), SKU (column), Region (column)
		// GetDeviceMetrics shouldn't duplicate since it matches via parametersText 'sku' but function name also contains 'device'
		assert.ok(results.length >= 3, `Expected at least 3 matches, got ${results.length}`);
		const columnNames = results.filter(r => r.kind === 'column').map(r => r.name);
		assert.ok(columnNames.includes('DeviceId'), 'Should find DeviceId column');
		assert.ok(columnNames.includes('SKU'), 'Should find SKU column');
		assert.ok(columnNames.includes('Region'), 'Should find Region column');
	});
});

suite('writeCachedSchemaToDisk', () => {
	let tmpDir: string;
	let cacheDir: string;
	let globalStorageUri: vscode.Uri;

	setup(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-schema-write-test-'));
		cacheDir = path.join(tmpDir, 'schemaCache');
		globalStorageUri = vscode.Uri.file(tmpDir);
	});

	teardown(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test('enriches entry with clusterUrl and database from cacheKey', async () => {
		const entry: CachedSchemaEntry = {
			schema: {
				tables: ['T1'],
				columnTypesByTable: { T1: { c: 'string' } }
			},
			timestamp: Date.now(),
			version: SCHEMA_CACHE_VERSION
		};
		const cacheKey = 'https://cluster.kusto.windows.net|Samples';
		await writeCachedSchemaToDisk(globalStorageUri, cacheKey, entry);

		// Read back the file and verify clusterUrl and database were added
		const files = fs.readdirSync(cacheDir).filter(f => f.endsWith('.json'));
		assert.strictEqual(files.length, 1);
		const content = JSON.parse(fs.readFileSync(path.join(cacheDir, files[0]), 'utf8'));
		assert.strictEqual(content.clusterUrl, 'https://cluster.kusto.windows.net');
		assert.strictEqual(content.database, 'Samples');
	});

	test('does not overwrite explicit clusterUrl and database on entry', async () => {
		const entry: CachedSchemaEntry = {
			schema: {
				tables: ['T1'],
				columnTypesByTable: { T1: { c: 'string' } }
			},
			timestamp: Date.now(),
			version: SCHEMA_CACHE_VERSION,
			clusterUrl: 'https://explicit.kusto.windows.net',
			database: 'ExplicitDB'
		};
		const cacheKey = 'https://other.kusto.windows.net|OtherDB';
		await writeCachedSchemaToDisk(globalStorageUri, cacheKey, entry);

		const files = fs.readdirSync(cacheDir).filter(f => f.endsWith('.json'));
		assert.strictEqual(files.length, 1);
		const content = JSON.parse(fs.readFileSync(path.join(cacheDir, files[0]), 'utf8'));
		assert.strictEqual(content.clusterUrl, 'https://explicit.kusto.windows.net');
		assert.strictEqual(content.database, 'ExplicitDB');
	});

	test('written schemas are searchable via searchCachedSchemas', async () => {
		const entry: CachedSchemaEntry = {
			schema: {
				tables: ['DeviceEvents'],
				columnTypesByTable: { DeviceEvents: { DeviceId: 'string', SKU: 'string', Region: 'string' } }
			},
			timestamp: Date.now(),
			version: SCHEMA_CACHE_VERSION
		};
		const cacheKey = 'https://cluster.kusto.windows.net|Samples';
		await writeCachedSchemaToDisk(globalStorageUri, cacheKey, entry);

		const results = await searchCachedSchemas(globalStorageUri, 'deviceid|sku|region');
		assert.ok(results.length >= 3, `Expected at least 3 matches, got ${results.length}`);
		const names = results.map(r => r.name);
		assert.ok(names.includes('DeviceId'));
		assert.ok(names.includes('SKU'));
		assert.ok(names.includes('Region'));
	});
});
