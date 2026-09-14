import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { ConnectionManagerViewerV2 } from '../../../src/host/connectionManagerViewer';
import { getSqlSchemaCacheDirUri, searchCachedSqlSchemas, sqlSchemaPrincipalFingerprint, sqlSchemaTargetSignature, SQL_SCHEMA_CACHE_VERSION } from '../../../src/host/sqlEditorSchema';
import { captureSqlSchemaCacheGeneration } from '../../../src/host/sqlSchemaCacheGeneration';
import * as schemaCache from '../../../src/host/schemaCache';

function createViewerHarness(): ConnectionManagerViewerV2 & Record<string, any> {
	const viewer = Object.create(ConnectionManagerViewerV2.prototype) as ConnectionManagerViewerV2 & Record<string, any>;
	viewer.pendingKustoPublicationAcks = new Map();
	viewer.kustoSearchOwnersByToken = new Map();
	viewer.postKustoPublication = vi.fn(async (message: unknown) => await Promise.resolve(viewer.panel?.webview?.postMessage(message)) !== false);
	return viewer;
}

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>(res => { resolve = res; });
	return { promise, resolve };
}

function installKustoPreviewOwner(viewer: ConnectionManagerViewerV2 & Record<string, any>): void {
	viewer.context ??= { globalStorageUri: vscode.Uri.file('/preview-owner') };
	viewer.connectionCache = { captureGeneration: vi.fn(() => ({ global: 0, connection: 0, partition: 0 })) };
	viewer.authPreferences = {
		getConnectionSessionGeneration: (connectionId: string) => {
			const connection = viewer.connectionManager.getConnections().find((candidate: any) => candidate.id === connectionId);
			return connection ? viewer.kustoClient.getConnectionSessionGeneration(connection) : 0;
		},
		waitForProviderAccountRefresh: vi.fn(async () => undefined),
	};
	const runWithSnapshot = viewer.connectionManager.runWithLeaveNoTraceSnapshotLock
		?? (async (run: (snapshot: any) => unknown) => await run({
			clusterKeys: [], globallyBlocked: false, version: 1, revocationGenerations: {},
		}));
	viewer.connectionManager.runWithLeaveNoTraceSnapshotLock = runWithSnapshot;
	const executeQueryWithIdentity = viewer.kustoClient.executeQueryWithIdentity;
	viewer.kustoClient.executeQueryWithIdentity = vi.fn(async (...args: any[]) => {
		const result = await executeQueryWithIdentity(...args);
		const gate = args[3];
		if (gate) {
			const connection = args[0];
			await runWithSnapshot((policy: any) => gate(
				connection, result.accountPartition, result.dispatchIdentity.authSessionGeneration,
				policy, async () => undefined,
			));
		}
		return result;
	});
}

function createSqlConnectionTestHarness(options: { accountId?: string; authType?: 'aad' | 'sql-login' } = {}) {
	const viewer = createViewerHarness();
	const authType = options.authType ?? 'aad';
	let connection: any = {
		id: 'sql-1', name: 'SQL', dialect: 'mssql', serverUrl: 'server.example', port: 1433,
		database: 'master', authType, ...(authType === 'sql-login' ? { username: 'user' } : {}),
	};
	let accountId = options.accountId;
	let revocationGeneration = 0;
	const cachedDatabases: Record<string, string[]> = {};
	const globalState = {
		get: vi.fn((key: string) => {
			if (key === 'sql.auth.serverAccountMap') return accountId ? { 'server.example': accountId } : {};
			if (key === 'sql.connectionManager.cachedDatabases') return cachedDatabases;
			return undefined;
		}),
		update: vi.fn(async (key: string, value: unknown) => {
			if (key === 'sql.connectionManager.cachedDatabases') {
				for (const existing of Object.keys(cachedDatabases)) delete cachedDatabases[existing];
				Object.assign(cachedDatabases, value);
			}
		}),
	};
	const manager = {
		getConnection: vi.fn(() => connection),
		getConnections: vi.fn(() => connection ? [connection] : []),
		assertConnectionCurrent: vi.fn(async () => undefined),
		setPassword: vi.fn(async () => undefined),
		updateConnectionAndPassword: vi.fn(async (_id: string, updates: Record<string, unknown>) => {
			connection = { ...connection, ...updates };
		}),
	};
	const getDatabases = vi.fn<(...args: any[]) => Promise<string[]>>();
	const executeQuery = vi.fn<(...args: any[]) => Promise<any>>();
	const getDatabaseSchema = vi.fn<(...args: any[]) => Promise<any>>();
	const assertSqlConnectionAllowed = vi.fn(async () => undefined);
	const dispatchSqlConnectionAllowed = vi.fn(async (_connectionId: string, dispatch: () => unknown) => await dispatch());
	const postMessage = vi.fn();
	viewer.context = { globalState };
	viewer.panel = { webview: { postMessage } };
	viewer.sqlDeps = {
		getSqlConnectionManager: () => manager,
		getSqlClient: () => ({ getDatabases, executeQuery, getDatabaseSchema }),
		assertSqlConnectionAllowed,
		dispatchSqlConnectionAllowed,
		dispatchSqlOwnerAllowed: async (captured: any, _principal: string, expectedRevocation: number, dispatch: () => unknown) => {
			if (expectedRevocation !== revocationGeneration) throw new Error('Leave No Trace generation changed');
			return dispatchSqlConnectionAllowed(captured.id, dispatch);
		},
		dispatchSqlOwnerSnapshot: async (dispatch: (snapshot: any) => unknown) => await dispatch({
			policy: { connectionIds: [], version: 1, globallyBlocked: false, revocationGenerations: {} },
			connections: connection ? [connection] : [], connectionVersion: 1,
			accountsByServer: accountId ? { 'server.example': accountId } : {}, principalVersion: 1,
		}),
		dispatchSqlPolicySnapshot: async (dispatch: (policy: any) => unknown) => await dispatch({ connectionIds: [], version: 1, globallyBlocked: false }),
		getSqlRevocationGeneration: () => revocationGeneration,
	};
	viewer._sqlTestConnectionRequestIdByConnectionId = new Map();
	return {
		viewer,
		manager,
		getDatabases,
		executeQuery,
		getDatabaseSchema,
		postMessage,
		globalState,
		cachedDatabases,
		assertSqlConnectionAllowed,
		dispatchSqlConnectionAllowed,
		getConnection: () => connection,
		setConnection: (value: any) => { connection = value; },
		setAccountId: (value: string | undefined) => { accountId = value; },
		setRevocationGeneration: (value: number) => { revocationGeneration = value; },
	};
}

function createKustoSearchTestHarness() {
	const viewer = createViewerHarness();
	const connections = ['a', 'b', 'c'].map(suffix => ({
		id: `cluster-${suffix}`, name: `Cluster ${suffix.toUpperCase()}`,
		clusterUrl: `https://cluster-${suffix}.kusto.windows.net`,
	}));
	const databases: Record<string, string[]> = {
		'cluster-a': ['A1', 'A2'], 'cluster-b': ['B1', 'B2'], 'cluster-c': ['C1'],
	};
	const cachedDatabases: Record<string, string[]> = { 'cluster-a': ['A1'], 'cluster-b': ['B2'] };
	const getDatabases = vi.fn(async (connection: { id: string }) => databases[connection.id]);
	const getDatabaseSchema = vi.fn(async (connection: { id: string }, database: string) => ({
		schema: { tables: [`${database}Events`, 'UnrelatedTable'] },
		accountPartition: `partition-${connection.id}`,
	}));
	const postMessage = vi.fn(async (_message: any) => true);
	viewer.panel = { webview: { postMessage } };
	viewer.context = {
		globalStorageUri: vscode.Uri.file('/selected-kusto-search'),
		globalState: { get: vi.fn(), update: vi.fn(async () => undefined) },
	};
	viewer.connectionManager = {
		getConnections: vi.fn(() => connections),
		getConnectionIncarnation: vi.fn(() => 1),
		runWithLeaveNoTraceSnapshotLock: vi.fn(async (run: (snapshot: any) => unknown) => await run({
			clusterKeys: [], globallyBlocked: false, version: 1,
			revocationGenerations: { 'cluster-a': 0, 'cluster-b': 0, 'cluster-c': 0 },
		})),
	};
	viewer.connectionCache = { captureGeneration: vi.fn(() => ({ global: 0, connection: 0, partition: 0 })) };
	viewer.authPreferences = {
		getConnectionSessionGeneration: vi.fn(() => 0),
		waitForProviderAccountRefresh: vi.fn(async () => undefined),
	};
	viewer.kustoClient = {
		getAccountPartition: vi.fn((connection: { id: string }) => `partition-${connection.id}`),
		getConnectionSessionGeneration: vi.fn(() => 0),
		getDatabases, getDatabaseSchema, isAuthenticationError: vi.fn(() => false),
	};
	viewer.getCachedDatabases = vi.fn(() => cachedDatabases);
	return { viewer, connections, databases, cachedDatabases, getDatabases, getDatabaseSchema, postMessage };
}

function sqlTestMessage(connection: any, password?: string) {
	return {
		type: 'sql.connection.test' as const,
		id: connection.id,
		name: connection.name,
		serverUrl: connection.serverUrl,
		port: connection.port,
		dialect: connection.dialect,
		authType: connection.authType,
		username: connection.username,
		database: connection.database,
		...(password !== undefined ? { password } : {}),
	};
}

async function flushAsyncDispatch(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

describe('ConnectionManagerViewerV2 schema search mapping', () => {
	it.each([
		{ source: 'cached Kusto', kind: 'kusto', cached: true },
		{ source: 'fresh Kusto', kind: 'kusto', cached: false },
		{ source: 'cached SQL', kind: 'sql', cached: true },
		{ source: 'fresh SQL', kind: 'sql', cached: false },
	] as const)('preserves exact column metadata and navigation identity from $source', ({ kind, cached }) => {
		const viewer = createViewerHarness();
		const connection = {
			id: 'column-source', name: 'Column Source', clusterUrl: 'https://source.kusto.windows.net',
			serverUrl: 'source.example', dialect: 'mssql', authType: 'sql-login', username: 'user',
		};
		viewer.connectionManager = { getConnections: () => [connection] };
		viewer.sqlDeps = { getSqlConnectionManager: () => ({ getConnections: () => [connection] }) };
		const owner = { targetSignature: 'exact-target', principalFingerprint: 'exact-principal', revocationGeneration: 4 };
		const columns = [
			{ name: 'HitColumn', type: 'long', docString: 'Raw count', matchKind: 'column' },
			{ name: 'TypedColumn', type: 'System.Int64', docString: 'Wire type kept verbatim', matchKind: 'columnType' },
			{ name: 'DocumentedColumn', type: 'nvarchar(128)', docString: 'Hit column documentation', matchKind: 'columnDocString' },
			{ name: 'MissingTypeHit', type: undefined, docString: 'MissingTypeHit: long - legacy-looking documentation', matchKind: 'columnDocString' },
			{ name: 'BareHit', type: undefined, docString: undefined, matchKind: 'column' },
			{ name: 'EmptyTypeHit', type: '', docString: undefined, matchKind: 'column' },
		] as const;
		const parents = kind === 'kusto'
			? [{ name: 'Events', kind: 'table' } as const]
			: [{ name: 'dbo.Events', kind: 'table' }, { name: 'report.Events', kind: 'view' }] as const;
		const columnTypes = Object.fromEntries(columns.map(column => [column.name, column.type]));
		const categories = { tables: true, views: true };
		const contentToggles = { tables: true, views: true };
		const database = 'Exact Database';
		const results = kind === 'kusto'
			? cached
				? viewer._mapKustoSchemaMatches(columns.map(column => ({
					connectionId: connection.id, clusterUrl: connection.clusterUrl, database,
					kind: column.matchKind, name: column.name, table: 'Events', type: column.type, docString: column.docString,
				})), categories, contentToggles)
				: viewer._searchSingleKustoSchema({
					tables: ['Events'], columnTypesByTable: { Events: columnTypes },
					columnDocStrings: Object.fromEntries(columns.map(column => [`Events.${column.name}`, column.docString])),
				}, connection.clusterUrl, database, connection, /Hit|System\.Int64/i, categories, contentToggles)
			: cached
				? viewer._mapSqlSchemaMatches(parents.flatMap(parent => columns.map(column => ({
					connectionId: connection.id, serverUrl: connection.serverUrl, database,
					kind: 'column', name: column.name, table: parent.name, parentKind: parent.kind, type: column.type,
				}))), categories, contentToggles)
				: viewer._searchSingleSqlSchema({
					tables: ['dbo.Events'], views: ['report.Events'],
					columnsByTable: Object.fromEntries(parents.map(parent => [parent.name, columnTypes])),
				}, connection, database, owner, /Hit|System\.Int64|nvarchar/i, categories, contentToggles);

		expect(results).toEqual(parents.flatMap(parent => columns.map(column => ({
			category: 'column', kind, connectionId: connection.id, connectionName: connection.name, database,
			name: column.name, parentName: parent.name, parentKind: parent.kind,
			columnType: column.type || undefined,
			matchContext: kind === 'kusto' ? column.docString : undefined,
			...(kind === 'sql' && !cached ? { _sqlOwner: owner } : {}),
		}))));
		if (kind === 'sql' && !cached) {
			for (const result of results) expect(result._sqlOwner).toBe(owner);
		}
	});

	it.each([
		{ names: false, content: false },
		{ names: true, content: false },
		{ names: false, content: true },
		{ names: true, content: true },
	])('searches Kusto names=$names and content=$content independently in cached and fresh schemas', ({ names, content }) => {
		const viewer = createViewerHarness();
		const connection = { id: 'independent', name: 'Cluster', clusterUrl: 'https://independent.kusto.windows.net' };
		viewer.connectionManager = { getConnections: () => [connection] };
		const categories = { tables: names, functions: names };
		const contentToggles = { tables: content, functions: content };
		const schema = {
			tables: ['HitTable'],
			columnTypesByTable: { HitTable: { HitColumn: 'string' } },
			functions: [{ name: 'HitFunction', body: 'print other=1' }, { name: 'BodyOnly', body: 'print Hit=1' }],
		};
		const matches = [
			{ kind: 'table', name: 'HitTable' },
			{ kind: 'column', name: 'HitColumn', table: 'HitTable', type: 'string' },
			{ kind: 'function', name: 'HitFunction' },
			{ kind: 'functionBody', name: 'BodyOnly' },
		].map(match => ({ ...match, connectionId: connection.id, clusterUrl: connection.clusterUrl, database: 'db' }));
		const expected = [
			...(names ? [['table', 'HitTable'], ['function', 'HitFunction']] : []),
			...(content ? [['column', 'HitColumn'], ['function', 'BodyOnly']] : []),
		].sort();
		const fresh = viewer._searchSingleKustoSchema(schema, connection.clusterUrl, 'db', connection, /Hit/i, categories, contentToggles);
		const cached = viewer._mapKustoSchemaMatches(matches, categories, contentToggles);
		for (const results of [fresh, cached]) {
			expect(results.map((result: { category: string; name: string }) => [result.category, result.name]).sort()).toEqual(expected);
		}
	});

	it.each([
		{ pattern: 'Hit', matchKind: 'functionBody', names: ['HitFunction', 'BodyOnly'] },
		{ pattern: '^dynamic$', matchKind: 'functionParameter', names: ['WithParameter'] },
		{ pattern: '^payload$', matchKind: 'functionParameter', names: ['WithParameter'] },
	])('finds body-only cached matches for $pattern without name precedence or limit starvation', async ({ pattern, matchKind, names }) => {
		const entry = {
			version: schemaCache.SCHEMA_CACHE_VERSION, timestamp: Date.now(), connectionId: 'independent',
			accountPartition: 'partition-a', clusterUrl: 'https://independent.kusto.windows.net', database: 'db',
			schema: {
				tables: ['HitTable1', 'HitTable2'],
				functions: [
					{ name: 'HitFunction', body: 'print Hit=1' }, { name: 'BodyOnly', body: 'print Hit=2' },
					{ name: 'WithParameter', body: 'print result=1', parametersText: '(payload: dynamic)', parameters: [{ name: 'payload', type: 'dynamic' }] },
				],
			},
		};
		const originalReadDirectory = vscode.workspace.fs.readDirectory;
		vscode.workspace.fs.readDirectory = vi.fn().mockResolvedValue([['entry.json', 1]]);
		const readFile = vi.spyOn(vscode.workspace.fs, 'readFile').mockResolvedValue(Buffer.from(JSON.stringify(entry)));
		try {
			const matches = await schemaCache.searchCachedSchemas(vscode.Uri.file('/independent-cache-search'), pattern, 2,
				new Set([schemaCache.schemaPrincipalIdentity('independent', 'partition-a')!]),
				{ tableNames: false, tableColumns: false, functionNames: false, functionBody: true });
			expect(matches.map(match => [match.kind, match.name])).toEqual(names.map(name => [matchKind, name]));
			const viewer = createViewerHarness();
			const connection = { id: entry.connectionId, name: 'Cluster', clusterUrl: entry.clusterUrl };
			const fresh = viewer._searchSingleKustoSchema(entry.schema, entry.clusterUrl, entry.database, connection,
				new RegExp(pattern, 'i'), { tables: false, functions: false }, { tables: false, functions: true });
			expect(fresh.map((result: { name: string }) => result.name)).toEqual(names);
		} finally {
			if (originalReadDirectory) vscode.workspace.fs.readDirectory = originalReadDirectory;
			else Reflect.deleteProperty(vscode.workspace.fs, 'readDirectory');
			readFile.mockRestore();
		}
	});

	it.each([
		{ names: false, columns: false, views: false },
		{ names: true, columns: false, views: false },
		{ names: false, columns: true, views: false },
		{ names: true, columns: true, views: false },
		{ names: false, columns: false, views: true },
	])('keeps SQL names=$names, columns=$columns, combined views=$views exact in cached and fresh searches', async ({ names, columns, views }) => {
		const harness = createSqlConnectionTestHarness({ authType: 'sql-login' });
		let persistedState: unknown;
		harness.viewer.getActiveKind = vi.fn(() => 'sql');
		harness.globalState.get.mockImplementation((key: string) => key === 'connectionManager.sqlSearchState' ? persistedState : undefined);
		harness.globalState.update.mockImplementation(async (_key: string, value: unknown) => {
			persistedState = JSON.parse(JSON.stringify(value));
		});
		const storageUri = {
			fsPath: '', path: '/sql-independent-search', toString: () => 'file:///sql-independent-search',
		} as vscode.Uri;
		harness.viewer.context.globalStorageUri = storageUri;
		harness.viewer.getSqlCachedDatabases = vi.fn(async () => ({ 'sql-1': ['DbA'] }));
		const connection = harness.getConnection();
		const owner = {
			principalFingerprint: sqlSchemaPrincipalFingerprint(harness.viewer.context, connection)!,
			targetSignature: sqlSchemaTargetSignature(connection),
		};
		const schema = {
			tables: ['HitTable'], views: ['Reports'],
			columnsByTable: { HitTable: { HitColumn: 'int', OtherColumn: 'HitType' }, Reports: { HitViewColumn: 'nvarchar' } },
			storedProcedures: [{ name: 'HitProcedure', parametersText: '@Hit int', body: 'SELECT Hit = 1' }],
		};
		harness.getDatabaseSchema.mockResolvedValue(schema);
		const entry = {
			version: SQL_SCHEMA_CACHE_VERSION, timestamp: Date.now(), schema, ...owner,
			connectionId: connection.id, serverUrl: connection.serverUrl, database: 'DbA',
			cacheGeneration: await captureSqlSchemaCacheGeneration(storageUri),
		};
		const cacheDirectory = getSqlSchemaCacheDirUri(storageUri);
		const originalReadDirectory = vscode.workspace.fs.readDirectory;
		vscode.workspace.fs.readDirectory = vi.fn().mockResolvedValue([['entry.json', 1]]);
		const readFile = vi.spyOn(vscode.workspace.fs, 'readFile').mockResolvedValue(Buffer.from(JSON.stringify(entry)));
		const categories = { tables: names, views, storedProcedures: false };
		const contentToggles = { tables: columns, views: true, storedProcedures: true };
		const base = { kind: 'sql', connectionId: connection.id, connectionName: connection.name, database: 'DbA' };
		const expected = [
			...(names ? [{ ...base, category: 'table', name: 'HitTable' }] : []),
			...(columns ? [
				{ ...base, category: 'column', name: 'HitColumn', parentName: 'HitTable', parentKind: 'table', columnType: 'int' },
				{ ...base, category: 'column', name: 'OtherColumn', parentName: 'HitTable', parentKind: 'table', columnType: 'HitType' },
			] : []),
			...(views ? [{ ...base, category: 'column', name: 'HitViewColumn', parentName: 'Reports', parentKind: 'view', columnType: 'nvarchar' }] : []),
		];
		const signal = new AbortController().signal;

		try {
			for (const scope of ['cached', 'selected']) {
				const requestId = `sql-independent-${scope}`;
				harness.viewer._activeSearchRequestId = requestId;
				await harness.viewer._executeSearch(
					requestId, 'Hit', scope, 'sql', categories, contentToggles, signal,
					scope === 'selected' ? [{ connectionId: connection.id, database: 'DbA' }] : undefined,
				);
				const publications = harness.postMessage.mock.calls.map(([message]) => message)
					.filter(message => message.type === 'searchResults' && message.requestId === requestId);
				expect(publications.flatMap(message => message.results)).toEqual(expected);
				expect(publications.at(-1)).toEqual({ type: 'searchResults', requestId, results: [], completed: true });
				expect(harness.viewer._activeSearchRequestId).toBeNull();
				const state = {
					query: 'Hit', scope, categories, contentToggles, lastSearchTimestamp: 123,
					lastResults: publications.flatMap(message => message.results),
					futureSearchOptions: { label: '  exact raw option  ', enabled: false, count: 0 },
				};
				await harness.viewer.onMessage({ type: 'search.saveState', kind: 'sql', state });
				const expectedState = { ...state, kind: 'sql', lastResults: [], lastSearchTimestamp: 0 };
				expect(harness.globalState.update).toHaveBeenLastCalledWith('connectionManager.sqlSearchState', expectedState);
				expect(persistedState).toStrictEqual(expectedState);
				expect(harness.viewer.getSearchState()).toStrictEqual(expectedState);
			}
			expect(harness.getDatabaseSchema.mock.calls).toEqual(names || columns || views ? [[connection, 'DbA', { signal }]] : []);
			expect(harness.getDatabases).not.toHaveBeenCalled();
			const allMatches = await searchCachedSqlSchemas(storageUri, 'Hit', 500, new Map([[connection.id, owner]]));
			expect(allMatches.filter(match => match.kind === 'column').map(match => [match.parentKind, match.name])).toEqual([
				['table', 'HitColumn'], ['table', 'OtherColumn'], ['view', 'HitViewColumn'],
			]);
			expect(harness.viewer._mapSqlSchemaMatches(allMatches, categories, contentToggles)).toEqual(expected);
			expect(readFile.mock.calls).toEqual(Array.from({ length: names || columns || views ? 2 : 1 }, () => [
				vscode.Uri.joinPath(cacheDirectory, 'entry.json'),
			]));
		} finally {
			if (originalReadDirectory === undefined) Reflect.deleteProperty(vscode.workspace.fs, 'readDirectory');
			else vscode.workspace.fs.readDirectory = originalReadDirectory;
			readFile.mockRestore();
		}
	});

	it('keeps every Kusto match type enabled for the four-argument scanner call', async () => {
		const base = { connectionId: 'kusto-defaults', clusterUrl: 'https://defaults.kusto.windows.net', database: 'Db' };
		const entry = {
			...base, version: schemaCache.SCHEMA_CACHE_VERSION, timestamp: Date.now(), accountPartition: 'partition-a',
			schema: {
				tables: ['HitTable', 'DocumentedTable', 'FolderTable'],
				tableDocStrings: { DocumentedTable: 'Hit table documentation' }, tableFolders: { FolderTable: 'Hit/Folder' },
				columnTypesByTable: { HitTable: { HitColumn: 'string', TypedColumn: 'HitType', DocumentedColumn: 'string' } },
				columnDocStrings: { 'HitTable.DocumentedColumn': 'Hit column documentation' },
				functions: [
					{ name: 'HitFunction', body: 'print Hit = 1' },
					{ name: 'DocumentedFunction', docString: 'Hit function documentation' },
					{ name: 'FolderFunction', folder: 'Hit/Functions' },
					{ name: 'ParameterFunction', parametersText: 'HitParameter:string' },
					{ name: 'BodyFunction', body: 'print Hit = 2' },
				],
			},
		};
		const originalReadDirectory = vscode.workspace.fs.readDirectory;
		vscode.workspace.fs.readDirectory = vi.fn().mockResolvedValue([['entry.json', 1]]);
		const readFile = vi.spyOn(vscode.workspace.fs, 'readFile').mockResolvedValue(Buffer.from(JSON.stringify(entry)));
		try {
			await expect(schemaCache.searchCachedSchemas(vscode.Uri.file('/kusto-search-defaults'), 'Hit', 50,
				new Set([schemaCache.schemaPrincipalIdentity(base.connectionId, entry.accountPartition)]))).resolves.toEqual([
				{ ...base, kind: 'table', name: 'HitTable' },
				{ ...base, kind: 'tableDocString', name: 'DocumentedTable', docString: 'Hit table documentation' },
				{ ...base, kind: 'tableFolder', name: 'FolderTable' },
				{ ...base, kind: 'column', name: 'HitColumn', table: 'HitTable', type: 'string' },
				{ ...base, kind: 'columnType', name: 'TypedColumn', table: 'HitTable', type: 'HitType' },
				{ ...base, kind: 'columnDocString', name: 'DocumentedColumn', table: 'HitTable', type: 'string', docString: 'Hit column documentation' },
				{ ...base, kind: 'function', name: 'HitFunction' },
				{ ...base, kind: 'functionDocString', name: 'DocumentedFunction', docString: 'Hit function documentation' },
				{ ...base, kind: 'functionFolder', name: 'FolderFunction' },
				{ ...base, kind: 'functionParameter', name: 'ParameterFunction', parametersText: 'HitParameter:string' },
				{ ...base, kind: 'functionBody', name: 'BodyFunction' },
			]);
		} finally {
			if (originalReadDirectory === undefined) Reflect.deleteProperty(vscode.workspace.fs, 'readDirectory');
			else vscode.workspace.fs.readDirectory = originalReadDirectory;
			readFile.mockRestore();
		}
	});

	it.each([
		{ scope: 'cached', columns: true, body: true },
		{ scope: 'selected', columns: true, body: false },
		{ scope: 'everything', columns: false, body: true },
	])('executes content-only Kusto $scope search with columns=$columns and body=$body for the current owner', async ({ scope, columns, body }) => {
		const harness = createKustoSearchTestHarness();
		const storedStateBytes = new Map<string, string>();
		harness.viewer.context.globalState.get.mockImplementation((key: string) => {
			const bytes = storedStateBytes.get(key);
			return bytes === undefined ? undefined : JSON.parse(bytes);
		});
		harness.viewer.context.globalState.update.mockImplementation(async (key: string, value: unknown) => {
			storedStateBytes.set(key, JSON.stringify(value));
		});
		const connection = harness.connections[1];
		const database = 'B1';
		const accountPartition = `partition-${connection.id}`;
		const storageUri = vscode.Uri.file(`/kusto-content-only-${scope}`);
		harness.viewer.context.globalStorageUri = storageUri;
		harness.viewer.authPreferences.getConnectionSessionGeneration.mockReturnValue(7);
		harness.viewer.kustoClient.getConnectionSessionGeneration.mockReturnValue(7);
		harness.viewer.connectionManager.getConnectionIncarnation.mockReturnValue(2);
		if (scope === 'everything') {
			harness.viewer.connectionManager.getConnections.mockReturnValue([connection]);
			harness.getDatabases.mockResolvedValue([database]);
		}
		harness.cachedDatabases[connection.id] = [database];
		const schema = {
			tables: ['HitTable'], columnTypesByTable: { HitTable: { HitColumn: 'System.Int64', OtherColumn: 'int' } },
			columnDocStrings: { 'HitTable.HitColumn': 'Exact Hit column documentation' },
			functions: [
				{ name: 'HitFunction', body: 'print Hit = 1', parametersText: 'value:string' },
				{ name: 'BodyOnly', body: 'print Hit = 2', parametersText: 'value:long' },
				{ name: 'HitNameOnly', body: 'print Other = 1' },
			],
		};
		harness.getDatabaseSchema.mockResolvedValue({ schema, accountPartition });
		const entry = {
			version: schemaCache.SCHEMA_CACHE_VERSION, timestamp: Date.now(), schema,
			connectionId: connection.id, clusterUrl: connection.clusterUrl, database, accountPartition,
		};
		const entries = [entry, { ...entry, accountPartition: 'old-account' }, { ...entry, connectionId: 'removed' }];
		const cacheDirectory = schemaCache.getSchemaCacheDirUri(storageUri);
		const cacheUris = entries.map((_entry, index) => vscode.Uri.joinPath(cacheDirectory, `entry-${index}.json`));
		const files = new Map(cacheUris.map((uri, index) => [uri.toString(), Buffer.from(JSON.stringify(entries[index]))]));
		const originalReadDirectory = vscode.workspace.fs.readDirectory;
		const readDirectory = vi.fn().mockResolvedValue(entries.map((_entry, index) => [`entry-${index}.json`, 1]));
		vscode.workspace.fs.readDirectory = readDirectory;
		const readFile = vi.spyOn(vscode.workspace.fs, 'readFile').mockImplementation(async uri => {
			const bytes = files.get(uri.toString());
			if (!bytes) throw new Error(`Unexpected schema cache read: ${uri.toString()}`);
			return bytes;
		});
		const writeFile = vi.spyOn(vscode.workspace.fs, 'writeFile').mockImplementation(async (uri, bytes) => {
			files.set(uri.toString(), Buffer.from(bytes));
		});
		const createDirectory = vi.spyOn(vscode.workspace.fs, 'createDirectory').mockResolvedValue(undefined);
		const requestId = `kusto-content-only-${scope}`;
		harness.viewer._activeSearchRequestId = requestId;

		try {
			await harness.viewer._executeSearch(
				requestId, 'Hit', scope, 'kusto', { clusters: false, databases: false, tables: false, functions: false },
				{ tables: columns, functions: body }, new AbortController().signal,
				scope === 'selected' ? [{ connectionId: connection.id, database }] : undefined,
			);
			const base = { kind: 'kusto', connectionId: connection.id, connectionName: connection.name, database };
			const publications = harness.postMessage.mock.calls.map(([message]) => message)
				.filter(message => message.type === 'searchResults');
			const rows = publications.flatMap(message => message.results);
			expect(rows.map(({ kustoSearchOwner: _owner, ...row }) => row)).toEqual([
				...(columns ? [{
					...base, category: 'column', name: 'HitColumn', parentName: 'HitTable', parentKind: 'table',
					columnType: 'System.Int64', matchContext: 'Exact Hit column documentation',
				}] : []),
				...(body ? [
					{ ...base, category: 'function', name: 'HitFunction', matchContext: 'value:string' },
					{ ...base, category: 'function', name: 'BodyOnly', matchContext: 'value:long' },
				] : []),
			]);
			for (const row of rows) {
				expect(row.kustoSearchOwner).toEqual(expect.objectContaining({
					accountPartition, connectionIncarnation: 2, authSessionGeneration: 7, leaveNoTraceRevision: 0,
					databaseCacheGeneration: { global: 0, connection: 0, partition: 0 },
					schemaCacheGeneration: { global: 0, connection: 0, partition: 0 },
				}));
			}
			expect(publications.at(-1)).toEqual({
				type: 'searchResults', requestId, results: [], completed: true, kustoSearchOwnerToken: expect.any(String),
			});
			const ownerToken = publications.at(-1)!.kustoSearchOwnerToken;
			const persistedRows = rows.map(row => ({
				...row, futureMetadata: { label: '  exact raw metadata  ', values: [0, false, null] },
			}));
			const state = {
				query: 'Hit', scope, lastSearchTimestamp: 123,
				lastResults: persistedRows.map(row => ({ ...row, kustoSearchOwnerToken: ownerToken })),
				futureSearchOptions: { label: '  exact raw option  ', enabled: false, count: 0 },
			};
			await harness.viewer.onMessage({ type: 'search.saveState', kind: 'kusto', state });
			const expectedState = {
				...state, kind: 'kusto', lastResults: persistedRows, kustoSearchOwnerToken: undefined,
				kustoPrincipalFingerprint: harness.viewer.getKustoSearchPrincipalFingerprint(), kustoPolicyVersion: 1,
			};
			expect(harness.viewer.context.globalState.update).toHaveBeenLastCalledWith('connectionManager.searchState', expectedState);
			const restoredState = JSON.parse(storedStateBytes.get('connectionManager.searchState')!);
			expect(restoredState).toStrictEqual(JSON.parse(JSON.stringify(expectedState)));
			const reopened = createViewerHarness();
			Object.assign(reopened, {
				context: harness.viewer.context, connectionManager: harness.viewer.connectionManager,
				connectionCache: harness.viewer.connectionCache, authPreferences: harness.viewer.authPreferences,
				kustoClient: harness.viewer.kustoClient,
			});
			expect(reopened.kustoSearchOwnersByToken.size).toBe(0);
			expect(reopened.getSearchState()).toStrictEqual(restoredState);
			await reopened.onMessage({ type: 'search.saveState', kind: 'kusto', state: reopened.getSearchState() });
			expect(JSON.parse(storedStateBytes.get('connectionManager.searchState')!)).toStrictEqual(restoredState);
			expect(harness.getDatabases.mock.calls).toEqual(scope === 'everything' ? [[
				connection, true, { traceId: expect.any(String), source: 'connection-manager-search-everything', persistCache: false },
			]] : []);
			expect(harness.getDatabaseSchema.mock.calls).toEqual(scope === 'cached' ? [] : [[
				connection, database, true, { persistCache: false, source: 'connection-manager-search-everything' },
			]]);
			expect(readDirectory.mock.calls).toEqual(scope === 'cached' ? [[cacheDirectory]] : []);
			expect(readFile.mock.calls).toEqual(scope === 'cached' ? cacheUris.map(uri => [uri]) : []);
			expect(createDirectory.mock.calls).toEqual(scope === 'cached' ? [] : [[cacheDirectory]]);
			const cacheKey = schemaCache.schemaCacheKey(connection.clusterUrl, database, connection.id, accountPartition);
			expect(writeFile.mock.calls.map(([uri, bytes]) => [uri, JSON.parse(Buffer.from(bytes).toString('utf8'))])).toEqual(
				scope === 'cached' ? [] : [[schemaCache.getSchemaCacheFileUri(storageUri, cacheKey), { ...entry, timestamp: expect.any(Number) }]],
			);
			if (scope !== 'cached') {
				await expect(schemaCache.readCachedSchemaFromDisk(storageUri, cacheKey)).resolves.toEqual({ ...entry, timestamp: expect.any(Number) });
			}
			expect(harness.viewer.authPreferences.waitForProviderAccountRefresh).toHaveBeenCalled();
			expect(harness.viewer._activeSearchRequestId).toBeNull();
		} finally {
			if (originalReadDirectory === undefined) Reflect.deleteProperty(vscode.workspace.fs, 'readDirectory');
			else vscode.workspace.fs.readDirectory = originalReadDirectory;
			readFile.mockRestore();
			writeFile.mockRestore();
			createDirectory.mockRestore();
		}
	});

	it('searches only explicitly selected SQL databases without server discovery', async () => {
		const harness = createSqlConnectionTestHarness({ accountId: 'account-a' });
		harness.viewer.context.globalStorageUri = vscode.Uri.file('/selected-sql-search');
		harness.getDatabases.mockResolvedValue(['DbA', 'DbB']);
		harness.getDatabaseSchema.mockResolvedValue({ tables: ['Orders'], columnsByTable: {} });
		harness.viewer.getSqlCachedDatabases = vi.fn(async () => ({ 'sql-1': ['DbA', 'DbB'] }));

		await harness.viewer.onMessage({
			type: 'search', requestId: 'selected-database', query: 'Orders|SQL|Db', scope: 'selected', kind: 'sql',
			targets: [{ connectionId: 'sql-1', database: 'DbA' }, { connectionId: 'removed', database: 'DbB' }],
			categories: { servers: true, databases: true, tables: true }, contentToggles: {},
		});
		await vi.waitFor(() => expect(harness.viewer._activeSearchRequestId).toBeNull());

		expect(harness.getDatabases).not.toHaveBeenCalled();
		expect(harness.getDatabaseSchema).toHaveBeenCalledExactlyOnceWith(harness.getConnection(), 'DbA', expect.objectContaining({ signal: expect.any(AbortSignal) }));
		const results = harness.postMessage.mock.calls.map(([message]) => message)
			.filter(message => message.type === 'searchResults').flatMap(message => message.results);
		expect(results.map(result => [result.category, result.connectionId, result.database, result.name])).toEqual([
			['database', 'sql-1', 'DbA', 'DbA'], ['table', 'sql-1', 'DbA', 'Orders'],
		]);
	});

	it.each([
		{
			selection: 'a whole server', targets: [{ connectionId: 'sql-1' }],
			pairs: [['sql-1', 'A1'], ['sql-1', 'A2']],
		},
		{
			selection: 'server A plus database B1, excluding B2 and C',
			targets: [{ connectionId: 'sql-1' }, { connectionId: 'sql-2', database: 'B1' }],
			pairs: [['sql-1', 'A1'], ['sql-1', 'A2'], ['sql-2', 'B1']],
		},
	])('searches selected SQL $selection with exact discovery and schema targets', async ({ targets, pairs }) => {
		const harness = createSqlConnectionTestHarness({ authType: 'sql-login' });
		const connections = ['A', 'B', 'C'].map((suffix, index) => ({
			...harness.getConnection(), id: `sql-${index + 1}`, name: `SQL ${suffix}`, serverUrl: `${suffix.toLowerCase()}.example`,
		}));
		const databases: Record<string, string[]> = { 'sql-1': ['A1', 'A2'], 'sql-2': ['B1', 'B2'], 'sql-3': ['C1'] };
		const manager = {
			...harness.manager,
			getConnection: vi.fn((connectionId: string) => connections.find(connection => connection.id === connectionId)),
			getConnections: vi.fn(() => connections),
		};
		harness.viewer.context.globalStorageUri = {
			fsPath: '', path: '/selected-sql-servers', toString: () => 'file:///selected-sql-servers',
		} as vscode.Uri;
		harness.viewer.sqlDeps.getSqlConnectionManager = () => manager;
		harness.viewer.sqlDeps.dispatchSqlOwnerSnapshot = async (dispatch: (snapshot: any) => unknown) => await dispatch({
			policy: { connectionIds: [], version: 1, globallyBlocked: false, revocationGenerations: { 'sql-1': 0, 'sql-2': 0, 'sql-3': 0 } },
			connections, connectionVersion: 1, accountsByServer: {}, principalVersion: 1,
		});
		harness.viewer.getSqlCachedDatabases = vi.fn(async () => ({ 'sql-1': ['A1'], 'sql-2': ['B2'] }));
		harness.getDatabases.mockImplementation(async connection => databases[connection.id]);
		harness.getDatabaseSchema.mockImplementation(async (_connection, database) => ({
			tables: [`${database}Events`, 'UnrelatedTable'], columnsByTable: {},
		}));
		const requestId = 'selected-sql-servers';
		const signal = new AbortController().signal;
		harness.viewer._activeSearchRequestId = requestId;

		await harness.viewer._executeSearch(
			requestId, '^SQL [ABC]$|^[ABC][12](Events)?$', 'selected', 'sql',
			{ servers: true, databases: true, tables: true }, {}, signal, targets,
		);

		expect(harness.getDatabases.mock.calls).toEqual([[connections[0], { signal }]]);
		expect(harness.getDatabaseSchema.mock.calls).toEqual(pairs.map(([connectionId, database]) => [
			connections.find(connection => connection.id === connectionId), database, { signal },
		]));
		const publications = harness.postMessage.mock.calls.map(([message]) => message)
			.filter(message => message.type === 'searchResults');
		expect(publications.flatMap(message => message.results)).toEqual([
			{ category: 'server', kind: 'sql', connectionId: 'sql-1', connectionName: 'SQL A', name: 'SQL A' },
			...pairs.map(([connectionId, database]) => ({
				category: 'database', kind: 'sql', connectionId,
				connectionName: connections.find(connection => connection.id === connectionId)!.name, database, name: database,
			})),
			...pairs.map(([connectionId, database]) => ({
				category: 'table', kind: 'sql', connectionId,
				connectionName: connections.find(connection => connection.id === connectionId)!.name, database, name: `${database}Events`,
			})),
		]);
		expect(publications.at(-1)).toEqual({ type: 'searchResults', requestId, results: [], completed: true });
		expect(harness.viewer._activeSearchRequestId).toBeNull();
	});

	it.each([
		{
			selection: 'database-only targets',
			targets: [{ connectionId: 'cluster-a', database: 'A2' }, { connectionId: 'cluster-b', database: 'B1' }],
			discoveredConnections: [], clusters: [],
			pairs: [['cluster-a', 'A2'], ['cluster-b', 'B1']],
		},
		{
			selection: 'a whole cluster', targets: [{ connectionId: 'cluster-a' }],
			discoveredConnections: ['cluster-a'], clusters: ['cluster-a'],
			pairs: [['cluster-a', 'A1'], ['cluster-a', 'A2']],
		},
		{
			selection: 'cluster A plus database B1, excluding B2 and C',
			targets: [{ connectionId: 'cluster-a' }, { connectionId: 'cluster-b', database: 'B1' }],
			discoveredConnections: ['cluster-a'], clusters: ['cluster-a'],
			pairs: [['cluster-a', 'A1'], ['cluster-a', 'A2'], ['cluster-b', 'B1']],
		},
	])('searches selected Kusto $selection with exact discovery and schema targets', async ({ targets, discoveredConnections, clusters, pairs }) => {
		const harness = createKustoSearchTestHarness();
		const writeSchema = vi.spyOn(schemaCache, 'writeCachedSchemaToDisk').mockResolvedValue(true);
		const requestId = 'selected-kusto';
		harness.viewer._activeSearchRequestId = requestId;
		const connectionFor = (connectionId: string) => harness.connections.find(connection => connection.id === connectionId)!;

		try {
			await harness.viewer._executeSearch(
				requestId, '^Cluster [ABC]$|^[ABC][12](Events)?$', 'selected', 'kusto',
				{ clusters: true, databases: true, tables: true }, {}, new AbortController().signal, targets,
			);

			expect(harness.getDatabases.mock.calls).toEqual(discoveredConnections.map(connectionId => [
				connectionFor(connectionId), true,
				{ traceId: expect.any(String), source: 'connection-manager-search-everything', persistCache: false },
			]));
			expect(harness.getDatabaseSchema.mock.calls).toEqual(pairs.map(([connectionId, database]) => [
				connectionFor(connectionId), database, true,
				{ persistCache: false, source: 'connection-manager-search-everything' },
			]));
			expect(writeSchema.mock.calls).toEqual(pairs.map(([connectionId, database]) => [
				harness.viewer.context.globalStorageUri,
				schemaCache.schemaCacheKey(connectionFor(connectionId).clusterUrl, database, connectionId, `partition-${connectionId}`),
				{
					schema: { tables: [`${database}Events`, 'UnrelatedTable'] }, timestamp: expect.any(Number),
					version: schemaCache.SCHEMA_CACHE_VERSION, clusterUrl: connectionFor(connectionId).clusterUrl,
					database, connectionId, accountPartition: `partition-${connectionId}`,
				},
				{ global: 0, connection: 0, partition: 0 },
			]));
			const publications = harness.postMessage.mock.calls.map(([message]) => message)
				.filter(message => message.type === 'searchResults');
			const rows = publications.flatMap(message => message.results);
			expect(rows.map(({ kustoSearchOwner: _owner, ...row }) => row)).toEqual([
				...clusters.map(connectionId => ({
					category: 'cluster', kind: 'kusto', connectionId,
					connectionName: connectionFor(connectionId).name, name: connectionFor(connectionId).name,
				})),
				...pairs.map(([connectionId, database]) => ({
					category: 'database', kind: 'kusto', connectionId,
					connectionName: connectionFor(connectionId).name, database, name: database,
				})),
				...pairs.map(([connectionId, database]) => ({
					category: 'table', kind: 'kusto', connectionId,
					connectionName: connectionFor(connectionId).name, database, name: `${database}Events`,
				})),
			]);
			for (const row of rows) {
				expect(row.kustoSearchOwner).toEqual(expect.objectContaining({
					accountPartition: `partition-${row.connectionId}`, connectionIncarnation: 1,
					authSessionGeneration: 0, leaveNoTraceRevision: 0,
				}));
			}
			expect(publications.at(-1)).toEqual({
				type: 'searchResults', requestId, results: [], completed: true, kustoSearchOwnerToken: expect.any(String),
			});
			expect(harness.viewer.authPreferences.waitForProviderAccountRefresh).toHaveBeenCalled();
			expect(harness.viewer._activeSearchRequestId).toBeNull();
		} finally {
			writeSchema.mockRestore();
		}
	});

	it.each(['cached', 'refresh-cached', 'everything'] as const)(
		'keeps Kusto name, schema, and network results exact for %s scope', async scope => {
			const harness = createKustoSearchTestHarness();
			const query = '^Cluster [ABC]$|^[ABC][12](Events)?$';
			const requestId = `kusto-${scope}`;
			harness.viewer._activeSearchRequestId = requestId;
			const cachedPairs = [['cluster-a', 'A1'], ['cluster-b', 'B2']];
			const allPairs = [['cluster-a', 'A1'], ['cluster-a', 'A2'], ['cluster-b', 'B1'], ['cluster-b', 'B2'], ['cluster-c', 'C1']];
			const connectionFor = (connectionId: string) => harness.connections.find(connection => connection.id === connectionId)!;
			const entries = cachedPairs.map(([connectionId, database]) => ({
				version: schemaCache.SCHEMA_CACHE_VERSION, timestamp: Date.now(),
				connectionId, database, clusterUrl: connectionFor(connectionId).clusterUrl,
				accountPartition: `partition-${connectionId}`, schema: { tables: [`${database}Events`, 'UnrelatedTable'] },
			}));
			entries.push(
				{ ...entries[0], accountPartition: 'old-account', database: 'A2', schema: { tables: ['A2Events'] } },
				{ ...entries[0], connectionId: 'removed', accountPartition: 'partition-removed', database: 'C1', schema: { tables: ['C1Events'] } },
			);
			const cacheDirectory = schemaCache.getSchemaCacheDirUri(harness.viewer.context.globalStorageUri);
			const cacheFiles = entries.map((entry, index) => ({
				name: `entry-${index}.json`, uri: vscode.Uri.joinPath(cacheDirectory, `entry-${index}.json`),
				bytes: Buffer.from(JSON.stringify(entry), 'utf8'),
			}));
			const fsApi = vscode.workspace.fs as any;
			const originalReadDirectory = fsApi.readDirectory;
			const readDirectory = vi.fn(async () => cacheFiles.map(file => [file.name, 1]));
			fsApi.readDirectory = readDirectory;
			const readFile = vi.spyOn(vscode.workspace.fs, 'readFile').mockImplementation(async uri => {
				const file = cacheFiles.find(candidate => candidate.uri.toString() === uri.toString());
				if (!file) throw new Error(`Unexpected schema cache read: ${uri.toString()}`);
				return file.bytes;
			});
			const searchCached = vi.spyOn(schemaCache, 'searchCachedSchemas');
			const readCached = vi.spyOn(schemaCache, 'readAllCachedSchemasFromDisk');
			const writeSchema = vi.spyOn(schemaCache, 'writeCachedSchemaToDisk').mockResolvedValue(true);

			try {
				await harness.viewer._executeSearch(
					requestId, query, scope, 'kusto', { clusters: true, databases: true, tables: true }, {},
					new AbortController().signal,
				);

				const allowedIdentities = new Set(harness.connections.map(connection =>
					schemaCache.schemaPrincipalIdentity(connection.id, `partition-${connection.id}`)));
				expect(searchCached.mock.calls).toEqual(scope === 'cached'
					? [[harness.viewer.context.globalStorageUri, query, 500, allowedIdentities,
						{ tableNames: true, tableColumns: false, functionNames: false, functionBody: false }]] : []);
				expect(readCached.mock.calls).toEqual(scope === 'refresh-cached'
					? [[harness.viewer.context.globalStorageUri, undefined, undefined, allowedIdentities]] : []);
				expect(readDirectory.mock.calls).toEqual(scope === 'everything' ? [] : [[cacheDirectory]]);
				expect(readFile.mock.calls).toEqual(scope === 'everything' ? [] : cacheFiles.map(file => [file.uri]));
				expect(harness.getDatabases.mock.calls).toEqual(scope === 'everything' ? harness.connections.map(connection => [
					connection, true, { traceId: expect.any(String), source: 'connection-manager-search-everything', persistCache: false },
				]) : []);
				const searchedPairs = scope === 'everything' ? allPairs : cachedPairs;
				const fetchedPairs = scope === 'cached' ? [] : searchedPairs;
				expect(harness.getDatabaseSchema.mock.calls).toEqual(fetchedPairs.map(([connectionId, database]) => [
					connectionFor(connectionId), database, true,
					{ persistCache: false, source: scope === 'everything' ? 'connection-manager-search-everything' : 'connection-manager-search-refresh' },
				]));
				expect(writeSchema.mock.calls.map(([, , entry]) => [entry.connectionId, entry.database])).toEqual(fetchedPairs);
				const namedConnections = scope === 'cached' ? harness.connections.slice(0, 2) : harness.connections;
				const expectedNames = scope === 'everything'
					? [
						...namedConnections.map(connection => ['cluster', connection.id, undefined, connection.name]),
						...allPairs.map(([connectionId, database]) => ['database', connectionId, database, database]),
					]
					: namedConnections.flatMap(connection => [
						['cluster', connection.id, undefined, connection.name],
						...(harness.cachedDatabases[connection.id] ?? []).map(database => ['database', connection.id, database, database]),
					]);
				const publications = harness.postMessage.mock.calls.map(([message]) => message)
					.filter(message => message.type === 'searchResults');
				expect(publications.flatMap(message => message.results)
					.map(result => [result.category, result.connectionId, result.database, result.name])).toEqual([
					...expectedNames,
					...searchedPairs.map(([connectionId, database]) => ['table', connectionId, database, `${database}Events`]),
				]);
				expect(publications.at(-1)).toEqual({
					type: 'searchResults', requestId, completed: true, results: [], kustoSearchOwnerToken: expect.any(String),
				});
				expect(harness.viewer._activeSearchRequestId).toBeNull();
			} finally {
				if (originalReadDirectory === undefined) delete fsApi.readDirectory;
				else fsApi.readDirectory = originalReadDirectory;
				readFile.mockRestore();
				searchCached.mockRestore();
				readCached.mockRestore();
				writeSchema.mockRestore();
			}
		},
	);

	it.each([
		{ selection: 'missing', targets: undefined },
		{ selection: 'empty', targets: [] },
		{ selection: 'a malformed container', targets: { connectionId: 'cluster-a' } },
		{
			selection: 'malformed entries',
			targets: [null, 'cluster-a', {}, { connectionId: '' }, { connectionId: 42 },
				{ connectionId: 'cluster-a', database: '' }, { connectionId: 'cluster-b', database: 42 },
				{ connectionId: 'cluster-c', database: ' ' }],
		},
		{ selection: 'stale connections', targets: [{ connectionId: 'removed' }, { connectionId: 'removed', database: 'A1' }] },
	])('does no Kusto network work or row publication for $selection selected targets', async ({ targets }) => {
		const harness = createKustoSearchTestHarness();
		const writeSchema = vi.spyOn(schemaCache, 'writeCachedSchemaToDisk').mockResolvedValue(true);
		const requestId = 'invalid-selected-kusto';
		harness.viewer._activeSearchRequestId = requestId;

		try {
			expect((await harness.viewer.captureKustoSearchOwners()).size).toBe(3);
			await harness.viewer._executeSearch(
				requestId, 'Cluster|Events', 'selected', 'kusto', { clusters: true, tables: true }, {},
				new AbortController().signal, targets,
			);

			expect(harness.getDatabases).not.toHaveBeenCalled();
			expect(harness.getDatabaseSchema).not.toHaveBeenCalled();
			expect(writeSchema).not.toHaveBeenCalled();
			expect(harness.postMessage.mock.calls).toEqual([[{
				type: 'searchResults', requestId, results: [], completed: true, kustoSearchOwnerToken: expect.any(String),
			}]]);
			expect(harness.viewer._activeSearchRequestId).toBeNull();
		} finally {
			writeSchema.mockRestore();
		}
	});

	it.each([
		{ phase: 'discovery', retirement: 'cancelled' },
		{ phase: 'schema', retirement: 'cancelled' },
		{ phase: 'discovery', retirement: 'superseded' },
		{ phase: 'schema', retirement: 'superseded' },
	])('discards a late Kusto $phase result after the selected search is $retirement', async ({ phase, retirement }) => {
		const harness = createKustoSearchTestHarness();
		const writeSchema = vi.spyOn(schemaCache, 'writeCachedSchemaToDisk').mockResolvedValue(true);
		const pendingDiscovery = deferred<string[]>();
		const pendingSchema = deferred<Awaited<ReturnType<typeof harness.getDatabaseSchema>>>();
		const currentSchema = deferred<Awaited<ReturnType<typeof harness.getDatabaseSchema>>>();
		const oldResult = { schema: { tables: ['A1Events'] }, accountPartition: 'partition-cluster-a' };
		const currentResult = { schema: { tables: ['B1Events'] }, accountPartition: 'partition-cluster-b' };
		if (phase === 'discovery') harness.getDatabases.mockReturnValueOnce(pendingDiscovery.promise);
		harness.getDatabaseSchema.mockImplementation((_connection, database) =>
			database === 'B1' ? currentSchema.promise : pendingSchema.promise);
		const oldController = new AbortController();
		harness.viewer._activeSearchRequestId = 'old-search';
		harness.viewer._searchAbortController = oldController;
		const oldSearch = harness.viewer._executeSearch(
			'old-search', '^A[12]Events$', 'selected', 'kusto', { tables: true }, {}, oldController.signal,
			[{ connectionId: 'cluster-a' }],
		);

		try {
			await vi.waitFor(() => expect(phase === 'discovery' ? harness.getDatabases : harness.getDatabaseSchema).toHaveBeenCalledOnce());
			if (retirement === 'cancelled') {
				await harness.viewer.onMessage({ type: 'search.cancel', requestId: 'old-search' });
				expect(harness.viewer._activeSearchRequestId).toBeNull();
			}
			await harness.viewer.onMessage({
				type: 'search', requestId: 'current-search', query: '^B1Events$', scope: 'selected', kind: 'kusto',
				categories: { tables: true }, contentToggles: {}, targets: [{ connectionId: 'cluster-b', database: 'B1' }],
			});
			await vi.waitFor(() => expect(harness.getDatabaseSchema).toHaveBeenCalledTimes(phase === 'schema' ? 2 : 1));
			const currentController = harness.viewer._searchAbortController;
			expect(oldController.signal.aborted).toBe(true);
			expect(currentController.signal.aborted).toBe(false);

			pendingDiscovery.resolve(['A1', 'A2']);
			pendingSchema.resolve(oldResult);
			await oldSearch;

			expect(harness.viewer._activeSearchRequestId).toBe('current-search');
			expect(harness.viewer._searchAbortController).toBe(currentController);
			expect(harness.viewer.activeKustoSearchOwners.has('cluster-b')).toBe(true);
			expect(harness.viewer.postKustoPublication).not.toHaveBeenCalled();
			expect(writeSchema).not.toHaveBeenCalled();
			expect(harness.getDatabases.mock.calls).toEqual([[
				harness.connections[0], true,
				{ traceId: expect.any(String), source: 'connection-manager-search-everything', persistCache: false },
			]]);
			expect(harness.getDatabaseSchema.mock.calls).toEqual([
				...(phase === 'schema' ? [[harness.connections[0], 'A1', true, { persistCache: false, source: 'connection-manager-search-everything' }]] : []),
				[harness.connections[1], 'B1', true, { persistCache: false, source: 'connection-manager-search-everything' }],
			]);

			currentSchema.resolve(currentResult);
			await vi.waitFor(() => expect(harness.viewer._activeSearchRequestId).toBeNull());
			const publications = harness.postMessage.mock.calls.map(([message]) => message)
				.filter(message => message.type === 'searchResults');
			expect(publications.map(message => [message.requestId, message.completed, message.results.map(result => [
				result.category, result.connectionId, result.database, result.name,
			])])).toEqual([
				['current-search', false, [['table', 'cluster-b', 'B1', 'B1Events']]],
				['current-search', true, []],
			]);
			expect(writeSchema.mock.calls.map(([, , entry]) => [entry.connectionId, entry.database, entry.schema])).toEqual([
				['cluster-b', 'B1', currentResult.schema],
			]);
		} finally {
			oldController.abort();
			harness.viewer._searchAbortController?.abort();
			pendingDiscovery.resolve(['A1', 'A2']);
			pendingSchema.resolve(oldResult);
			currentSchema.resolve(currentResult);
			await oldSearch;
			await vi.waitFor(() => expect(harness.viewer._activeSearchRequestId).toBeNull());
			writeSchema.mockRestore();
		}
	});

	it('fails a Connection Manager Kusto publication closed when applied and revoke acknowledgements are lost', async () => {
		vi.useFakeTimers();
		try {
			const viewer = Object.create(ConnectionManagerViewerV2.prototype) as ConnectionManagerViewerV2 & Record<string, any>;
			viewer.pendingKustoPublicationAcks = new Map();
			const postMessage = vi.fn(async () => true);
			viewer.panel = { webview: { postMessage } };

			const publishing = viewer.postKustoPublication({ type: 'searchResults', requestId: 'lost-ack', results: [] });
			await vi.waitFor(() => expect(postMessage).toHaveBeenCalledOnce());
			const stage = postMessage.mock.calls[0][0];
			await viewer.onMessage({
				type: 'kustoPublicationAck', publicationId: stage.publicationId, phase: 'staged', accepted: true,
			});
			await vi.waitFor(() => expect(postMessage).toHaveBeenCalledTimes(2));

			await vi.advanceTimersByTimeAsync(6_000);

			await expect(publishing).resolves.toBe(false);
			expect(postMessage).toHaveBeenCalledWith({
				type: 'kustoPublicationRevoke', publicationId: stage.publicationId,
			});
			expect(viewer.pendingKustoPublicationAcks.size).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it('keeps the exact Connection Manager publication waiter live after a malformed matching acknowledgement', async () => {
		vi.useFakeTimers();
		try {
			const viewer = Object.create(ConnectionManagerViewerV2.prototype) as ConnectionManagerViewerV2 & Record<string, any>;
			viewer.pendingKustoPublicationAcks = new Map();
			const postMessage = vi.fn(async () => true);
			viewer.panel = { webview: { postMessage } };
			let settled = false;
			const publishing = viewer.postKustoPublication({ type: 'searchResults', requestId: 'publication-current', results: [] })
				.then((accepted: boolean) => { settled = true; return accepted; });
			await vi.waitFor(() => expect(postMessage).toHaveBeenCalledOnce());
			const stage = postMessage.mock.calls[0][0];
			await viewer.onMessage({
				type: 'kustoPublicationAck', publicationId: stage.publicationId, phase: 'staged', accepted: true,
			});
			await vi.waitFor(() => expect(postMessage).toHaveBeenCalledTimes(2));
			const key = `${stage.publicationId}:applied`;
			const pending = viewer.pendingKustoPublicationAcks.get(key);
			const deadline = pending?.timer;

			await viewer.onMessage({
				type: 'kustoPublicationAck', publicationId: [stage.publicationId], phase: 'applied', accepted: true,
			});

			expect(settled).toBe(false);
			expect(viewer.pendingKustoPublicationAcks.get(key)).toBe(pending);
			expect(viewer.pendingKustoPublicationAcks.get(key)?.timer).toBe(deadline);

			await viewer.onMessage({
				type: 'kustoPublicationAck', publicationId: stage.publicationId, phase: 'applied', accepted: true,
			});
			await expect(publishing).resolves.toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it('rejects old-target SQL preview rows during final canonical admission', async () => {
		const harness = createSqlConnectionTestHarness({ authType: 'sql-login' });
		const result = deferred<any>();
		let targetCurrent = true;
		harness.executeQuery.mockReturnValue(result.promise);
		harness.manager.assertConnectionCurrent.mockImplementation(async () => {
			if (!targetCurrent) throw new Error('SQL connection changed while credentials were being resolved.');
		});

		const pending = harness.viewer.onMessage({
			type: 'sql.table.preview', connectionId: 'sql-1', database: 'Db', tableName: 'dbo.Secret',
		});
		await vi.waitFor(() => expect(harness.executeQuery).toHaveBeenCalledOnce());
		targetCurrent = false;
		result.resolve({ columns: [{ name: 'Secret' }], rows: [['old-target-row']], metadata: {} });
		await pending;

		const terminal = harness.postMessage.mock.calls.map(call => call[0]).filter(message => message.type === 'sql.tablePreviewResult');
		expect(terminal).toEqual([expect.objectContaining({ success: false })]);
		expect(terminal).not.toContainEqual(expect.objectContaining({ success: true, rows: [['old-target-row']] }));
	});

	it('does not publish SQL preview rows when canonical LNT admission rejects', async () => {
		const harness = createSqlConnectionTestHarness({ authType: 'sql-login' });
		harness.executeQuery.mockResolvedValue({ columns: [{ name: 'Secret' }], rows: [['blocked-row']], metadata: {} });
		harness.dispatchSqlConnectionAllowed.mockRejectedValueOnce(new Error('Leave No Trace committed'));

		await harness.viewer.onMessage({
			type: 'sql.table.preview', connectionId: 'sql-1', database: 'Db', tableName: 'dbo.Secret',
		});

		const terminal = harness.postMessage.mock.calls.map(call => call[0]).filter(message => message.type === 'sql.tablePreviewResult');
		expect(terminal).toEqual([expect.objectContaining({ success: false })]);
		expect(terminal).not.toContainEqual(expect.objectContaining({ success: true, rows: [['blocked-row']] }));
	});

	it('does not publish SQL preview rows after an LNT enable-disable interval', async () => {
		const harness = createSqlConnectionTestHarness({ authType: 'sql-login' });
		const result = deferred<any>();
		harness.executeQuery.mockReturnValue(result.promise);

		const pending = harness.viewer.onMessage({
			type: 'sql.table.preview', connectionId: 'sql-1', database: 'Db', tableName: 'dbo.Secret',
		});
		await vi.waitFor(() => expect(harness.executeQuery).toHaveBeenCalledOnce());
		harness.setRevocationGeneration(2);
		result.resolve({ columns: [{ name: 'Secret' }], rows: [['revoked-row']], metadata: {} });
		await pending;

		const terminal = harness.postMessage.mock.calls.map(call => call[0]).filter(message => message.type === 'sql.tablePreviewResult');
		expect(terminal).toEqual([expect.objectContaining({ success: false })]);
		expect(terminal).not.toContainEqual(expect.objectContaining({ success: true, rows: [['revoked-row']] }));
	});
	it('includes Kusto column docstrings in cached schema search result snippets', () => {
		const viewer = createViewerHarness();
		viewer.connectionManager = {
			getConnections: vi.fn(() => [{ id: 'c1', name: 'MyCluster', clusterUrl: 'https://mycluster.kusto.windows.net' }]),
		};

		const results = viewer._mapKustoSchemaMatches([
			{
				clusterUrl: 'https://mycluster.kusto.windows.net',
				database: 'AlphaDb',
				kind: 'columnDocString',
				name: 'alphaCol',
				table: 'AlphaRoot',
				type: 'long',
				docString: 'Primary event count for the current window',
			},
		], { tables: true }, { tables: true });

		expect(results).toEqual([
			expect.objectContaining({
				category: 'column',
				name: 'alphaCol',
				parentName: 'AlphaRoot',
				parentKind: 'table',
				columnType: 'long',
				matchContext: 'Primary event count for the current window',
			}),
		]);
	});

	it('searches Kusto column docstrings in freshly loaded schemas', () => {
		const viewer = createViewerHarness();
		const results = viewer._searchSingleKustoSchema(
			{
				tables: ['AlphaRoot'],
				columnTypesByTable: { AlphaRoot: { alphaCol: 'long' } },
				columnDocStrings: { 'AlphaRoot.alphaCol': 'Primary event count for the current window' },
			},
			'https://mycluster.kusto.windows.net',
			'AlphaDb',
			{ id: 'c1', name: 'MyCluster', clusterUrl: 'https://mycluster.kusto.windows.net' },
			/event count/i,
			{ tables: true },
			{ tables: true },
		);

		expect(results).toEqual([
			expect.objectContaining({
				category: 'column',
				name: 'alphaCol',
				parentName: 'AlphaRoot',
				parentKind: 'table',
				columnType: 'long',
				matchContext: 'Primary event count for the current window',
			}),
		]);
	});
});

describe('ConnectionManagerViewerV2 database refresh', () => {
	it('releases Kusto snapshot admission between contended SQL owner attempts', async () => {
		const viewer = createViewerHarness();
		const retry = deferred<void>();
		const continueRetry = deferred<void>();
		let kustoHeld = false;
		let attempts = 0;
		viewer.snapshotRevision = 0;
		viewer.panel = { webview: { postMessage: vi.fn(async () => true) } };
		viewer.connectionManager = {
			runWithLeaveNoTraceSnapshotLock: vi.fn(async (run: (snapshot: any) => unknown) => {
				expect(kustoHeld).toBe(false);
				kustoHeld = true;
				try { return await run({ clusterKeys: [], globallyBlocked: false, version: 1, revocationGenerations: {} }); }
				finally { kustoHeld = false; }
			}),
		};
		viewer.buildSnapshot = vi.fn(async (revision: number) => ({
			revision, timestamp: Date.now(), activeKind: 'kusto', connections: [], accounts: [], favorites: [],
			cachedDatabases: {}, expandedClusters: [], leaveNoTraceClusters: [], sqlAvailable: true,
			sqlConnections: [], sqlCachedDatabases: {}, sqlExpandedConnections: [], sqlFavorites: [],
			sqlLeaveNoTrace: [], sqlStateVersions: { policy: 1, connections: 1, principals: 1 },
			sqlCacheOwners: {}, sqlDialects: [], searchState: {},
		}));
		viewer.sqlDeps = {
			refreshSqlLeaveNoTracePolicy: vi.fn(async () => undefined),
			getSqlStateVersions: () => ({ policy: 1, connections: 1, principals: 1 }),
			tryDispatchSqlOwnerSnapshot: vi.fn(async (dispatch: (snapshot: any) => unknown) => {
				attempts++;
				if (attempts === 1) return { acquired: false };
				return { acquired: true, value: await dispatch({
					policy: { connectionIds: [], version: 1, globallyBlocked: false },
					connections: [], connectionVersion: 1, accountsByServer: {}, principalVersion: 1,
				}) };
			}),
			retrySqlOwnerSnapshotAcquisition: async (attempt: () => Promise<any>) => {
				const first = await attempt();
				if (first.acquired) return first.value;
				expect(kustoHeld).toBe(false);
				retry.resolve();
				await continueRetry.promise;
				const second = await attempt();
				return second.value;
			},
		};
		viewer.postKustoPublication = vi.fn(async () => true);

		const snapshot = viewer.sendSnapshotToWebview();
		await retry.promise;
		expect(kustoHeld).toBe(false);
		continueRetry.resolve();
		await snapshot;
		expect(attempts).toBe(2);
	});

	it('publishes Kusto state while omitting SQL when SQL policy refresh fails', async () => {
		const viewer = createViewerHarness();
		const postMessage = vi.fn();
		viewer.snapshotRevision = 0;
		viewer.panel = { webview: { postMessage } };
		viewer.sqlDeps = {
			refreshSqlLeaveNoTracePolicy: vi.fn(async () => { throw new Error('SQL policy unavailable'); }),
			getSqlConnectionManager: () => ({ getConnections: () => [{ id: 'sql-secret' }] }),
		};
		viewer.authPreferences = {
			getAccounts: vi.fn(async () => []), getPreference: vi.fn(() => ({ mode: 'automatic' })),
			getPreferredAccountId: vi.fn(() => undefined), getConnectionSessionGeneration: vi.fn(() => 0),
		};
		viewer.connectionManager = {
			getConnections: vi.fn(() => [{ id: 'c1', name: 'Kusto', clusterUrl: 'https://cluster.kusto.windows.net' }]),
			getLeaveNoTraceClusters: vi.fn(() => []),
			runWithLeaveNoTraceSnapshotLock: vi.fn(async (run: (snapshot: any) => unknown) => await run({ clusterKeys: [], globallyBlocked: false })),
		};
		viewer.kustoClient = { getAccountPartition: vi.fn(() => 'partition-a') };
		viewer.getActiveKind = vi.fn(() => 'kusto');
		viewer.getFavorites = vi.fn(() => []);
		viewer.getCachedDatabases = vi.fn(() => ({ c1: ['Db'] }));
		viewer.getExpandedClusters = vi.fn(() => ['c1']);
		viewer.getSearchState = vi.fn(() => ({}));

		await viewer.sendSnapshotToWebview();

		expect(postMessage).toHaveBeenCalledWith({
			type: 'snapshot',
			snapshot: expect.objectContaining({
				sqlAvailable: false,
				connections: [expect.objectContaining({ id: 'c1' })],
				sqlConnections: [], sqlCachedDatabases: {}, sqlFavorites: [],
			}),
		});
	});

	it('replaces populated SQL state when final policy settlement fails', async () => {
		const viewer = createViewerHarness();
		const postMessage = vi.fn();
		const refreshPolicy = vi.fn()
			.mockResolvedValueOnce([])
			.mockRejectedValueOnce(new Error('final policy failure'));
		viewer.snapshotRevision = 0;
		viewer.context = { globalState: { get: vi.fn(() => undefined) } };
		viewer.panel = { webview: { postMessage } };
		viewer.sqlDeps = {
			refreshSqlLeaveNoTracePolicy: refreshPolicy,
			getSqlLeaveNoTraceConnectionIds: () => [],
			getSqlStateVersions: () => ({ policy: 1, principals: 1, connections: 1 }),
			getSqlConnectionManager: () => ({
				getConnections: () => [{ id: 'sql-secret', name: 'Secret', dialect: 'mssql', serverUrl: 'secret.example', authType: 'aad' }],
			}),
		};
		viewer.getSqlCachedDatabases = vi.fn(async () => ({ 'sql-secret': ['SecretDb'] }));
		viewer.getSqlFavorites = vi.fn(() => [{ name: 'Secret', connectionId: 'sql-secret', database: 'SecretDb' }]);
		viewer.getSqlExpandedConnections = vi.fn(() => ['sql-secret']);
		viewer.authPreferences = {
			getAccounts: vi.fn(async () => []), getPreference: vi.fn(() => ({ mode: 'automatic' })),
			getPreferredAccountId: vi.fn(() => undefined), getConnectionSessionGeneration: vi.fn(() => 0),
		};
		viewer.connectionManager = {
			getConnections: vi.fn(() => [{ id: 'c1', name: 'Kusto', clusterUrl: 'https://cluster.kusto.windows.net' }]),
			getLeaveNoTraceClusters: vi.fn(() => []),
			runWithLeaveNoTraceSnapshotLock: vi.fn(async (run: (snapshot: any) => unknown) => await run({ clusterKeys: [], globallyBlocked: false })),
		};
		viewer.kustoClient = { getAccountPartition: vi.fn(() => 'partition-a') };
		viewer.getActiveKind = vi.fn(() => 'kusto');
		viewer.getFavorites = vi.fn(() => []);
		viewer.getCachedDatabases = vi.fn(() => ({ c1: ['Db'] }));
		viewer.getExpandedClusters = vi.fn(() => ['c1']);
		viewer.getSearchState = vi.fn(() => ({}));

		await viewer.sendSnapshotToWebview();

		expect(postMessage).toHaveBeenCalledWith({
			type: 'snapshot',
			snapshot: expect.objectContaining({
				sqlAvailable: false,
				sqlConnections: [], sqlCachedDatabases: {}, sqlFavorites: [],
			}),
		});
	});

	it('keeps the previous cached list when live discovery returns zero databases', async () => {
		const viewer = createViewerHarness();
		const postMessage = vi.fn();
		const connection = { id: 'c1', name: 'MyCluster', clusterUrl: 'https://mycluster.kusto.windows.net' };
		viewer.connectionManager = {
			getConnections: vi.fn(() => [connection]), getConnectionIncarnation: vi.fn(() => 1),
			runWithLeaveNoTraceSnapshotLock: vi.fn(async (run: (snapshot: any) => unknown) => await run({
				clusterKeys: [], globallyBlocked: false, version: 1, revocationGenerations: {},
			})),
		};
		viewer.context = { globalStorageUri: vscode.Uri.file('/database-zero') };
		viewer.connectionCache = {
			captureGeneration: vi.fn(() => ({ global: 0, connection: 0, partition: 0 })),
			setDatabases: vi.fn(async () => true),
		};
		viewer.authPreferences = {
			getConnectionSessionGeneration: vi.fn(() => 0), waitForProviderAccountRefresh: vi.fn(async () => undefined),
		};
		viewer.kustoClient = {
			getAccountPartition: vi.fn(() => 'partition-a'), getConnectionSessionGeneration: vi.fn(() => 0),
			getDatabasesWithIdentity: vi.fn(async () => ({
				databases: [], accountPartition: 'partition-a', fromCache: false,
				cacheGeneration: { global: 0, connection: 0, partition: 0 },
			})),
			isAuthenticationError: vi.fn(() => false),
		};
		viewer.panel = { webview: { postMessage } };
		viewer.getCachedDatabases = vi.fn(() => ({ c1: ['CachedDb'] }));
		viewer.traceDatabaseList = vi.fn();
		const warning = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined as any);

		await viewer.onMessage({ type: 'cluster.refreshDatabases', connectionId: 'c1' });

		expect(postMessage).toHaveBeenNthCalledWith(1, { type: 'loadingDatabases', connectionId: 'c1' });
		expect(postMessage).toHaveBeenNthCalledWith(2, {
			type: 'databasesLoaded',
			connectionId: 'c1',
			databases: ['CachedDb'],
			warning: true,
		});
		expect(warning).toHaveBeenCalledWith("Couldn't refresh the database list (received 0 databases). Keeping the previous cached list.");
	});
});

describe('ConnectionManagerViewerV2 new KQLX files', () => {
	it('serializes the exact connection authority and hint for same-cluster connections', async () => {
		const viewer = createViewerHarness();
		const targetUri = vscode.Uri.file('C:/work/GuestDb.kqlx');
		const writeFile = vi.spyOn(vscode.workspace.fs, 'writeFile').mockResolvedValue(undefined);
		vi.spyOn(vscode.window, 'showSaveDialog').mockResolvedValue(targetUri as any);
		vi.spyOn(vscode.workspace, 'openTextDocument').mockResolvedValue({
			getText: () => new TextDecoder().decode(writeFile.mock.calls.at(-1)?.[1] ?? new Uint8Array()),
			lineCount: 1,
			save: vi.fn(async () => true),
		} as any);
		viewer.connectionManager = {
			getConnections: vi.fn(() => [
				{ id: 'home', name: 'Home', clusterUrl: 'https://shared.kusto.windows.net', authorityId: 'home.onmicrosoft.com' },
				{ id: 'guest', name: 'Guest', clusterUrl: 'shared', authorityId: 'resource.onmicrosoft.com' },
			]),
		};

		await viewer.onMessage({
			type: 'database.openInNewFile',
			connectionId: 'guest',
			clusterUrl: 'https://shared.kusto.windows.net',
			database: 'GuestDb',
		});

		expect(writeFile).toHaveBeenCalledOnce();
		const content = new TextDecoder().decode(writeFile.mock.calls[0][1]);
		const file = JSON.parse(content);
		expect(file.state.sections[0]).toMatchObject({
			type: 'query',
			clusterUrl: 'shared',
			authorityId: 'resource.onmicrosoft.com',
			connectionIdHint: 'guest',
			database: 'GuestDb',
		});
	});

	it('serializes the exact SQL connection owner for same-host connections', async () => {
		const harness = createSqlConnectionTestHarness({ authType: 'sql-login' });
		const guest = {
			id: 'sql-guest', name: 'Guest SQL', dialect: 'mssql', serverUrl: 'server.example', port: 1433,
			database: 'GuestDb', authType: 'sql-login', username: 'GuestUser',
		};
		harness.setConnection(guest);
		const targetUri = vscode.Uri.file('C:/work/GuestDb.sqlx');
		const writeFile = vi.spyOn(vscode.workspace.fs, 'writeFile').mockResolvedValue(undefined);
		writeFile.mockClear();
		vi.spyOn(vscode.window, 'showSaveDialog').mockResolvedValue(targetUri as any);
		vi.spyOn(vscode.workspace, 'openTextDocument').mockResolvedValue({
			getText: () => new TextDecoder().decode(writeFile.mock.calls.at(-1)?.[1] ?? new Uint8Array()),
			lineCount: 1,
			save: vi.fn(async () => true),
		} as any);

		await harness.viewer.onMessage({
			type: 'sql.database.openInNewFile',
			connectionId: guest.id,
			database: guest.database,
		});

		expect(writeFile).toHaveBeenCalledOnce();
		const file = JSON.parse(new TextDecoder().decode(writeFile.mock.calls[0][1]));
		expect(file.state.sections[0]).toMatchObject({
			type: 'sql',
			serverUrl: guest.serverUrl,
			connectionIdHint: guest.id,
			targetSignature: sqlSchemaTargetSignature(guest as any),
			database: guest.database,
		});
		expect(harness.manager.assertConnectionCurrent).toHaveBeenCalledWith(guest);
	});
});

describe('ConnectionManagerViewerV2 mutation completion', () => {
	it('admits each complete webview message through the manager lifecycle', async () => {
		const viewer = createViewerHarness();
		const message = { type: 'requestSnapshot' };
		const onMessage = vi.spyOn(viewer, 'onMessage').mockResolvedValue(undefined);
		viewer.connectionManager = {
			runLifecycleOperation: vi.fn(async (operation: () => Promise<unknown>) => operation()),
		};

		viewer.handleWebviewMessage(message);
		await vi.waitFor(() => expect(onMessage).toHaveBeenCalledWith(message));
		expect(viewer.connectionManager.runLifecycleOperation).toHaveBeenCalledOnce();
	});

	it('posts the final snapshot only after explicit account persistence settles', async () => {
		let settlePreference!: () => void;
		const preferenceGate = new Promise<void>(resolve => { settlePreference = resolve; });
		const events: string[] = [];
		const viewer = createViewerHarness();
		viewer.connectionManager = {
			addConnection: vi.fn(async () => ({ id: 'c1', name: 'Guest', clusterUrl: 'https://cluster.kusto.windows.net' })),
		};
		viewer.authPreferences = {
			getAccounts: vi.fn(async () => [{ id: 'account-1', label: 'Account one' }]),
			setExplicitAccount: vi.fn(async () => {
				await preferenceGate;
				events.push('preference');
			}),
		};
		viewer.sendSnapshotToWebview = vi.fn(async () => { events.push('snapshot'); });
		viewer.panel = { webview: { postMessage: vi.fn((message: { type: string }) => { events.push(message.type); }) } };

		const completion = viewer.onMessage({
			type: 'connection.add',
			name: 'Guest',
			clusterUrl: 'https://cluster.kusto.windows.net',
			authorityId: 'resource.onmicrosoft.com',
			accountId: 'account-1',
		});
		await Promise.resolve();
		expect(events).toEqual([]);

		settlePreference();
		await completion;
		expect(events).toEqual(['preference', 'snapshot', 'connectionMutationComplete']);
	});

	it.each(['add', 'edit', 'test'] as const)('returns terminal failure for malformed Authority during %s', async action => {
		const viewer = createViewerHarness();
		const postMessage = vi.fn();
		viewer.connectionManager = {
			getConnections: vi.fn(() => action === 'edit' ? [{ id: 'c1', name: 'Stored', clusterUrl: 'https://cluster.kusto.windows.net' }] : []),
			addConnection: vi.fn(),
			updateConnection: vi.fn(),
		};
		viewer.sendSnapshotToWebview = vi.fn(async () => undefined);
		viewer.panel = { webview: { postMessage } };
		viewer.traceDatabaseList = vi.fn();

		const authorityId = 'https://login.microsoftonline.com/tenant';
		if (action === 'add') await viewer.onMessage({ type: 'connection.add', name: 'Bad', clusterUrl: 'https://cluster.kusto.windows.net', authorityId });
		if (action === 'edit') await viewer.onMessage({ type: 'connection.edit', id: 'c1', name: 'Bad', clusterUrl: 'https://cluster.kusto.windows.net', authorityId });
		if (action === 'test') await viewer.onMessage({ type: 'connection.test', name: 'Bad', clusterUrl: 'https://cluster.kusto.windows.net', authorityId });

		expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: action === 'test' ? 'testConnectionResult' : 'connectionMutationComplete',
			success: false,
		}));
	});
});

describe('ConnectionManagerViewerV2 table preview identity', () => {
	it('completes a preview when first automatic sign-in establishes the account partition', async () => {
		const viewer = createViewerHarness();
		const postMessage = vi.fn();
		const connection = { id: 'c1', name: 'Cluster', clusterUrl: 'https://cluster.kusto.windows.net' };
		let currentPartition: string | undefined;
		viewer.connectionManager = { getConnections: vi.fn(() => [connection]), getConnectionIncarnation: vi.fn(() => 0) };
		viewer.kustoClient = {
			executeQueryWithIdentity: vi.fn(async () => {
				currentPartition = 'partition-first-sign-in';
				return {
					accountPartition: currentPartition,
					leaveNoTraceRevision: 0,
					dispatchIdentity: {
						dispatchAttempt: 1, connectionRevision: 0, leaveNoTraceRevision: 0,
						connectionIdentityKey: 'cluster|', clusterEndpoint: connection.clusterUrl,
						accountPartition: currentPartition, authSessionGeneration: 0, clientActivityId: 'preview-first-sign-in',
					},
					result: { columns: [{ name: 'value', type: 'string' }], rows: [['ready']], metadata: { executionTime: '0.1s' } },
				};
			}),
			getAccountPartition: vi.fn(() => currentPartition),
			getConnectionSessionGeneration: vi.fn(() => 0),
			waitForProviderAccountRefresh: vi.fn(async () => undefined),
			isAuthenticationError: vi.fn(() => false),
		};
		viewer.connectionManager.admitLeaveNoTraceRevision = vi.fn(async (_clusterUrl: string, _revision: number, admit: () => unknown) => ({ admitted: true, value: await Promise.resolve(admit()) }));
		viewer.sendSnapshotToWebview = vi.fn(async () => undefined);
		viewer.panel = { webview: { postMessage } };
		installKustoPreviewOwner(viewer);

		await viewer.onMessage({ type: 'table.preview', connectionId: 'c1', database: 'Db', tableName: 'Events' });

		expect(postMessage).toHaveBeenNthCalledWith(1, expect.objectContaining({ type: 'tablePreviewLoading', connectionId: 'c1', database: 'Db', tableName: 'Events', requestId: expect.any(String) }));
		expect(postMessage).toHaveBeenNthCalledWith(2, expect.objectContaining({
			type: 'tablePreviewResult',
			connectionId: 'c1',
			accountPartition: 'partition-first-sign-in',
			success: true,
			rows: [['ready']],
		}));
	});

	it('rejects preview rows after the preview cluster policy generation changes', async () => {
		const viewer = createViewerHarness();
		const postMessage = vi.fn(async () => true);
		const connection = { id: 'c1', name: 'Cluster', clusterUrl: 'https://cluster-a.kusto.windows.net' };
		let snapshotCall = 0;
		viewer.connectionManager = {
			getConnections: vi.fn(() => [connection]),
			getConnectionIncarnation: vi.fn(() => 0),
			runWithLeaveNoTraceSnapshotLock: vi.fn(async (run: (snapshot: any) => unknown) => await run({
				clusterKeys: [], globallyBlocked: false, version: ++snapshotCall,
				revocationGenerations: { 'cluster-a': snapshotCall > 1 ? 5 : 4 },
			})),
		};
		viewer.kustoClient = {
			executeQueryWithIdentity: vi.fn(async () => ({
				accountPartition: 'partition-a', leaveNoTraceRevision: 4,
				dispatchIdentity: {
					dispatchAttempt: 1, connectionRevision: 0, leaveNoTraceRevision: 4,
					connectionIdentityKey: 'cluster-a|', clusterEndpoint: connection.clusterUrl,
					accountPartition: 'partition-a', authSessionGeneration: 0, clientActivityId: 'preview-stale-policy',
				},
				result: { columns: ['value'], rows: [['SECRET_ROW']], metadata: {} },
			})),
			getAccountPartition: vi.fn(() => 'partition-a'),
			getConnectionSessionGeneration: vi.fn(() => 0),
			waitForProviderAccountRefresh: vi.fn(async () => undefined),
			isAuthenticationError: vi.fn(() => false),
		};
		viewer.sendSnapshotToWebview = vi.fn(async () => undefined);
		viewer.panel = { webview: { postMessage } };
		installKustoPreviewOwner(viewer);

		await viewer.onMessage({ type: 'table.preview', connectionId: 'c1', database: 'Db', tableName: 'Events' });

		expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ success: true }));
		expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'tablePreviewResult', success: false, error: expect.stringMatching(/Leave no trace|owner changed/i),
		}));
	});

	it('publishes preview rows when only an unrelated cluster generation changes', async () => {
		const viewer = createViewerHarness();
		const postMessage = vi.fn(async () => true);
		const connection = { id: 'c1', name: 'Cluster', clusterUrl: 'https://cluster-a.kusto.windows.net' };
		viewer.connectionManager = {
			getConnections: vi.fn(() => [connection]),
			getConnectionIncarnation: vi.fn(() => 0),
			admitLeaveNoTraceRevision: vi.fn(async (clusterUrl: string, revision: number, admit: () => unknown) => {
				expect(clusterUrl).toBe(connection.clusterUrl);
				expect(revision).toBe(4);
				return { admitted: true, value: await Promise.resolve(admit()) };
			}),
		};
		viewer.kustoClient = {
			executeQueryWithIdentity: vi.fn(async () => ({
				accountPartition: 'partition-a', leaveNoTraceRevision: 4,
				dispatchIdentity: {
					dispatchAttempt: 1, connectionRevision: 0, leaveNoTraceRevision: 4,
					connectionIdentityKey: 'cluster-a|', clusterEndpoint: connection.clusterUrl,
					accountPartition: 'partition-a', authSessionGeneration: 0, clientActivityId: 'preview-current',
				},
				result: { columns: ['value'], rows: [['ready']], metadata: {} },
			})),
			getAccountPartition: vi.fn(() => 'partition-a'),
			getConnectionSessionGeneration: vi.fn(() => 0),
			waitForProviderAccountRefresh: vi.fn(async () => undefined),
			isAuthenticationError: vi.fn(() => false),
		};
		viewer.sendSnapshotToWebview = vi.fn(async () => undefined);
		viewer.panel = { webview: { postMessage } };
		installKustoPreviewOwner(viewer);

		await viewer.onMessage({ type: 'table.preview', connectionId: 'c1', database: 'Db', tableName: 'Events' });

		expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'tablePreviewResult', success: true, rows: [['ready']],
		}));
	});

	it.each([
		['endpoint', { clusterUrl: 'https://cluster-b.kusto.windows.net' }],
		['authority', { authorityId: 'tenant-b.onmicrosoft.com' }],
	] as const)('rejects preview rows after a same-ID %s mutation', async (_label, mutation) => {
		const viewer = createViewerHarness();
		const postMessage = vi.fn(async () => true);
		const original = { id: 'c1', name: 'Cluster', clusterUrl: 'https://cluster-a.kusto.windows.net', authorityId: 'tenant-a.onmicrosoft.com' };
		let current = original;
		viewer.connectionManager = {
			getConnections: vi.fn(() => [current]),
			getConnectionIncarnation: vi.fn(() => 0),
			admitLeaveNoTraceRevision: vi.fn(async (_clusterUrl: string, _revision: number, admit: () => unknown) => ({ admitted: true, value: await Promise.resolve(admit()) })),
		};
		viewer.kustoClient = {
			executeQueryWithIdentity: vi.fn(async () => {
				current = { ...original, ...mutation };
				return {
					accountPartition: 'partition-a', leaveNoTraceRevision: 2,
					dispatchIdentity: {
						dispatchAttempt: 1, connectionRevision: 0, leaveNoTraceRevision: 2,
						connectionIdentityKey: 'cluster-a|tenant-a.onmicrosoft.com', clusterEndpoint: original.clusterUrl,
						authorityId: 'tenant-a.onmicrosoft.com', accountPartition: 'partition-a', authSessionGeneration: 0, clientActivityId: 'preview-old-target',
					},
					result: { columns: ['value'], rows: [['SECRET_A']], metadata: {} },
				};
			}),
			getAccountPartition: vi.fn(() => 'partition-a'),
			getConnectionSessionGeneration: vi.fn(() => 0),
			waitForProviderAccountRefresh: vi.fn(async () => undefined),
			isAuthenticationError: vi.fn(() => false),
		};
		viewer.sendSnapshotToWebview = vi.fn(async () => undefined);
		viewer.panel = { webview: { postMessage } };
		installKustoPreviewOwner(viewer);

		await viewer.onMessage({ type: 'table.preview', connectionId: 'c1', database: 'Db', tableName: 'Events' });

		expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ success: true }));
		expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'tablePreviewResult', success: false, error: expect.stringMatching(/target changed|owner changed/i),
		}));
	});

	it('rejects preview rows after a same-ID target changes A to B and back to A', async () => {
		const viewer = createViewerHarness();
		const postMessage = vi.fn(async () => true);
		const connection = { id: 'c1', name: 'Cluster', clusterUrl: 'https://cluster-a.kusto.windows.net', authorityId: 'common' };
		let incarnation = 1;
		viewer.connectionManager = {
			getConnections: vi.fn(() => [connection]),
			getConnectionIncarnation: vi.fn(() => incarnation),
			admitLeaveNoTraceRevision: vi.fn(async (_clusterUrl: string, _revision: number, admit: () => unknown) => ({ admitted: true, value: await Promise.resolve(admit()) })),
		};
		viewer.kustoClient = {
			executeQueryWithIdentity: vi.fn(async () => {
				incarnation = 3;
				return {
					accountPartition: 'partition-a', leaveNoTraceRevision: 2,
					dispatchIdentity: {
						dispatchAttempt: 1, connectionRevision: 1, leaveNoTraceRevision: 2,
						connectionIdentityKey: 'cluster-a|common', clusterEndpoint: connection.clusterUrl,
						authorityId: 'common', accountPartition: 'partition-a', authSessionGeneration: 0, clientActivityId: 'preview-aba',
					},
					result: { columns: ['value'], rows: [['SECRET_ABA']], metadata: {} },
				};
			}),
			getAccountPartition: vi.fn(() => 'partition-a'),
			getConnectionSessionGeneration: vi.fn(() => 0),
			waitForProviderAccountRefresh: vi.fn(async () => undefined),
			isAuthenticationError: vi.fn(() => false),
		};
		viewer.sendSnapshotToWebview = vi.fn(async () => undefined);
		viewer.panel = { webview: { postMessage } };
		installKustoPreviewOwner(viewer);

		await viewer.onMessage({ type: 'table.preview', connectionId: 'c1', database: 'Db', tableName: 'Events' });

		expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ success: true }));
		expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'tablePreviewResult', success: false, error: expect.stringMatching(/target changed|owner changed/i),
		}));
	});

	it('rejects preview rows after same-account session recreation with unchanged partition', async () => {
		const viewer = createViewerHarness();
		const postMessage = vi.fn(async () => true);
		const connection = { id: 'c1', name: 'Cluster', clusterUrl: 'https://cluster.kusto.windows.net' };
		let authGeneration = 0;
		viewer.connectionManager = {
			getConnections: vi.fn(() => [connection]), getConnectionIncarnation: vi.fn(() => 0),
			admitLeaveNoTraceRevision: vi.fn(async (_cluster: string, _revision: number, admit: () => unknown) => ({ admitted: true, value: await Promise.resolve(admit()) })),
		};
		viewer.kustoClient = {
			executeQueryWithIdentity: vi.fn(async () => {
				authGeneration = 1;
				return {
					accountPartition: 'partition-a', leaveNoTraceRevision: 0,
					dispatchIdentity: {
						dispatchAttempt: 1, connectionRevision: 0, leaveNoTraceRevision: 0,
						connectionIdentityKey: 'cluster|', clusterEndpoint: connection.clusterUrl,
						accountPartition: 'partition-a', authSessionGeneration: 0, clientActivityId: 'preview-old-session',
					},
					result: { columns: ['Secret'], rows: [['OLD_SESSION_ROW']], metadata: {} },
				};
			}),
			getAccountPartition: vi.fn(() => 'partition-a'),
			getConnectionSessionGeneration: vi.fn(() => authGeneration),
			waitForProviderAccountRefresh: vi.fn(async () => undefined),
			isAuthenticationError: vi.fn(() => false),
		};
		viewer.sendSnapshotToWebview = vi.fn(async () => undefined);
		viewer.panel = { webview: { postMessage } };
		installKustoPreviewOwner(viewer);

		await viewer.onMessage({ type: 'table.preview', connectionId: 'c1', database: 'Db', tableName: 'Events' });

		expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ success: true }));
		expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'tablePreviewResult', success: false, error: expect.stringMatching(/Authentication changed|owner changed/i),
		}));
		expect(JSON.stringify(postMessage.mock.calls)).not.toContain('OLD_SESSION_ROW');
	});

	it('waits for queued provider refresh before admitting preview rows', async () => {
		const viewer = createViewerHarness();
		const postMessage = vi.fn(async () => true);
		const connection = { id: 'c1', name: 'Cluster', clusterUrl: 'https://cluster.kusto.windows.net' };
		const refresh = deferred<void>();
		let authGeneration = 0;
		viewer.connectionManager = {
			getConnections: vi.fn(() => [connection]), getConnectionIncarnation: vi.fn(() => 0),
			admitLeaveNoTraceRevision: vi.fn(async (_cluster: string, _revision: number, admit: () => unknown) => ({ admitted: true, value: await Promise.resolve(admit()) })),
		};
		viewer.kustoClient = {
			executeQueryWithIdentity: vi.fn(async () => ({
				accountPartition: 'partition-a', leaveNoTraceRevision: 0,
				dispatchIdentity: {
					dispatchAttempt: 1, connectionRevision: 0, leaveNoTraceRevision: 0,
					connectionIdentityKey: 'cluster|', clusterEndpoint: connection.clusterUrl,
					accountPartition: 'partition-a', authSessionGeneration: 0, clientActivityId: 'preview-queued-session',
				},
				result: { columns: ['Secret'], rows: [['QUEUED_OLD_SESSION_ROW']], metadata: {} },
			})),
			getAccountPartition: vi.fn(() => 'partition-a'),
			getConnectionSessionGeneration: vi.fn(() => authGeneration),
			waitForProviderAccountRefresh: vi.fn(async () => refresh.promise),
			isAuthenticationError: vi.fn(() => false),
		};
		viewer.sendSnapshotToWebview = vi.fn(async () => undefined);
		viewer.panel = { webview: { postMessage } };
		viewer.postKustoPublication = vi.fn(async (message: unknown) => await postMessage(message));
		installKustoPreviewOwner(viewer);

		const preview = viewer.onMessage({ type: 'table.preview', connectionId: 'c1', database: 'Db', tableName: 'Events' });
		await vi.waitFor(() => expect(viewer.kustoClient.waitForProviderAccountRefresh).toHaveBeenCalledOnce());
		expect(viewer.postKustoPublication).not.toHaveBeenCalled();
		authGeneration = 1;
		refresh.resolve();
		await preview;

		expect(viewer.postKustoPublication).not.toHaveBeenCalled();
		expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'tablePreviewResult', success: false, error: expect.stringContaining('Authentication changed'),
		}));
		expect(JSON.stringify(postMessage.mock.calls)).not.toContain('QUEUED_OLD_SESSION_ROW');
	});
});

describe('ConnectionManagerViewerV2 persisted search ownership', () => {
	it('preserves the establishing Connection Manager search on first automatic sign-in', () => {
		const viewer = createViewerHarness();
		const abort = vi.fn();
		viewer._searchAbortController = { abort };
		viewer.activeKustoSearchOwners = new Map([['c1', {}]]);
		viewer.sendSnapshotToWebview = vi.fn(async () => undefined);

		viewer.handleKustoAuthPreferenceChange({
			connectionIds: ['c1'], reason: 'success', accountPartition: 'partition-a', firstEstablishment: true,
		});

		expect(abort).not.toHaveBeenCalled();
		expect(viewer.sendSnapshotToWebview).toHaveBeenCalledOnce();
	});

	it('aborts an old-session Connection Manager search after later auth invalidation', () => {
		const viewer = createViewerHarness();
		const abort = vi.fn();
		viewer._searchAbortController = { abort };
		viewer.activeKustoSearchOwners = new Map([['c1', {}]]);
		viewer.sendSnapshotToWebview = vi.fn(async () => undefined);

		viewer.handleKustoAuthPreferenceChange({ connectionIds: ['c1'], reason: 'sessions-changed' });

		expect(abort).toHaveBeenCalledOnce();
	});

	it('strips protected Kusto explorer metadata while retaining the cluster row', async () => {
		const viewer = createViewerHarness();
		const connection = { id: 'secret', name: 'Secret', clusterUrl: 'https://secret.kusto.windows.net' };
		viewer.context = { globalState: { get: vi.fn(), update: vi.fn(async () => undefined) } };
		viewer.connectionManager = { getConnections: vi.fn(() => [connection]), normalizeClusterUrl: (value: string) => value };
		viewer.kustoClient = { getAccountPartition: vi.fn(() => 'partition-a') };
		viewer.authPreferences = {
			getAccounts: vi.fn(async () => []), getPreference: vi.fn(() => ({ mode: 'automatic' })),
			getPreferredAccountId: vi.fn(() => 'account-a'), getConnectionSessionGeneration: vi.fn(() => 0),
		};
		viewer.getFavorites = vi.fn(() => [{ name: 'Secret favorite', connectionId: 'secret', clusterUrl: connection.clusterUrl, database: 'SecretDb' }]);
		viewer.getCachedDatabases = vi.fn(() => ({ secret: ['SecretDb'] }));
		viewer.getExpandedClusters = vi.fn(() => ['secret']);
		viewer.getActiveKind = vi.fn(() => 'kusto');

		const snapshot = await viewer.buildSnapshot(1, true, {
			clusterKeys: ['secret'], globallyBlocked: false, version: 2,
		});

		expect(snapshot.connections).toEqual([expect.objectContaining({ id: 'secret' })]);
		expect(snapshot.cachedDatabases).toEqual({});
		expect(snapshot.favorites).toEqual([]);
		expect(snapshot.expandedClusters).toEqual([]);
	});

	it.each(['cluster.expand', 'cluster.refreshDatabases', 'database.getSchema', 'database.refreshSchema'] as const)(
		'does not invoke Kusto discovery for protected %s',
		async type => {
			const viewer = createViewerHarness();
			const connection = { id: 'secret', name: 'Secret', clusterUrl: 'https://secret.kusto.windows.net' };
			viewer.connectionManager = {
				getConnections: vi.fn(() => [connection]), getConnectionIncarnation: vi.fn(() => 1),
				runWithLeaveNoTraceSnapshotLock: vi.fn(async (run: (snapshot: any) => unknown) => await run({
					clusterKeys: ['secret'], globallyBlocked: false, version: 2, revocationGenerations: { secret: 1 },
				})),
			};
			viewer.connectionCache = { captureGeneration: vi.fn(() => ({ global: 0, connection: 0, partition: 0 })) };
			viewer.context = { globalStorageUri: vscode.Uri.file('/protected-explorer') };
			viewer.authPreferences = {
				getConnectionSessionGeneration: vi.fn(() => 0), waitForProviderAccountRefresh: vi.fn(async () => undefined),
			};
			viewer.kustoClient = {
				getAccountPartition: vi.fn(() => 'partition-a'), getConnectionSessionGeneration: vi.fn(() => 0),
				getDatabasesWithIdentity: vi.fn(), getDatabaseSchema: vi.fn(),
			};
			viewer.panel = { webview: { postMessage: vi.fn(async () => true) } };

			if (type === 'cluster.expand' || type === 'cluster.refreshDatabases') {
				await viewer.onMessage({ type, connectionId: 'secret' });
			} else if (type === 'database.getSchema') {
				await viewer.onMessage({ type, connectionId: 'secret', database: 'SecretDb' });
			} else {
				await viewer.onMessage({ type, connectionId: 'secret', clusterUrl: connection.clusterUrl, database: 'SecretDb' });
			}

			expect(viewer.kustoClient.getDatabasesWithIdentity).not.toHaveBeenCalled();
			expect(viewer.kustoClient.getDatabaseSchema).not.toHaveBeenCalled();
		},
	);

	it.each(['cached', 'refresh-cached', 'everything'] as const)(
		'excludes protected Kusto owners before %s search work begins',
		async scope => {
			const viewer = createViewerHarness();
			const connection = { id: 'protected-1', name: 'Protected', clusterUrl: 'https://protected.kusto.windows.net' };
			const postMessage = vi.fn(async () => true);
			const getDatabases = vi.fn(async () => ['SecretDb']);
			const getDatabaseSchema = vi.fn(async () => ({ schema: { tables: ['SecretTable'] }, accountPartition: 'partition-a' }));
			viewer.panel = { webview: { postMessage } };
			viewer.context = {
				globalStorageUri: { fsPath: '', path: '/protected-search', toString: () => 'file:///protected-search' } as vscode.Uri,
				globalState: { get: vi.fn(), update: vi.fn(async () => undefined) },
			};
			viewer.connectionManager = {
				getConnections: vi.fn(() => [connection]),
				getConnectionIncarnation: vi.fn(() => 1),
				runWithLeaveNoTraceSnapshotLock: vi.fn(async (run: (snapshot: any) => unknown) => await run({
					clusterKeys: ['protected'], globallyBlocked: false,
				})),
			};
			viewer.kustoClient = {
				getAccountPartition: vi.fn(() => 'partition-a'),
				getDatabases,
				getDatabaseSchema,
				isAuthenticationError: vi.fn(() => false),
			};

			await viewer.onMessage({
				type: 'search', requestId: `protected-${scope}`, query: 'Secret', scope, kind: 'kusto',
				categories: { clusters: true, databases: true, tables: true, functions: true },
				contentToggles: { tables: true, functions: true },
			});
			await vi.waitFor(() => expect(viewer._activeSearchRequestId).toBeNull());

			expect(getDatabases).not.toHaveBeenCalled();
			expect(getDatabaseSchema).not.toHaveBeenCalled();
			expect(postMessage.mock.calls.map(call => call[0])).not.toContainEqual(expect.objectContaining({
				type: 'searchResults', results: expect.arrayContaining([expect.objectContaining({ connectionId: connection.id })]),
			}));
		},
	);

	it('drops protected Kusto rows from a late search.saveState publication', async () => {
		const viewer = createViewerHarness();
		const connection = { id: 'protected-1', name: 'Protected', clusterUrl: 'https://protected.kusto.windows.net' };
		let persisted: unknown;
		viewer.context = { globalState: {
			get: vi.fn(),
			update: vi.fn(async (_key: string, value: unknown) => { persisted = value; }),
		} };
		viewer.connectionManager = {
			getConnections: vi.fn(() => [connection]),
			runWithLeaveNoTraceSnapshotLock: vi.fn(async (run: (snapshot: any) => unknown) => await run({
				clusterKeys: ['protected'], globallyBlocked: false,
			})),
		};
		viewer.kustoClient = { getAccountPartition: vi.fn(() => 'partition-a') };

		await viewer.onMessage({
			type: 'search.saveState', kind: 'kusto', state: {
				query: 'Secret', scope: 'everything', lastSearchTimestamp: 123,
				lastResults: [{ kind: 'kusto', connectionId: connection.id, name: 'SecretTable' }],
			},
		});

		expect(persisted).toEqual(expect.objectContaining({ lastResults: [] }));
		expect(JSON.stringify(persisted)).not.toContain('SecretTable');
	});

	it('drops delayed Kusto search rows after the same connection rotates from principal A to B', async () => {
		const viewer = createViewerHarness();
		const connection = { id: 'c1', name: 'Cluster', clusterUrl: 'https://cluster.kusto.windows.net' };
		let partition = 'partition-a';
		let persisted: any;
		viewer.context = { globalState: {
			get: vi.fn(),
			update: vi.fn(async (_key: string, value: unknown) => { persisted = value; }),
		} };
		viewer.connectionManager = {
			getConnections: vi.fn(() => [connection]),
			getConnectionIncarnation: vi.fn(() => 1),
			runWithLeaveNoTraceSnapshotLock: vi.fn(async (run: (snapshot: any) => unknown) => await run({
				clusterKeys: [], globallyBlocked: false, version: 1,
			})),
		};
		viewer.kustoClient = { getAccountPartition: vi.fn(() => partition) };
		const owners = await viewer.captureKustoSearchOwners();
		const ownerToken = viewer.rememberKustoSearchOwners(owners);
		partition = 'partition-b';

		await viewer.onMessage({
			type: 'search.saveState', kind: 'kusto', state: {
				query: 'Secret', scope: 'cached', lastSearchTimestamp: 123,
				lastResults: [{
					kind: 'kusto', connectionId: connection.id, name: 'SecretTable',
					kustoSearchOwnerToken: ownerToken,
				}],
			},
		});

		expect(persisted.lastResults).toEqual([]);
		expect(JSON.stringify(persisted)).not.toContain('SecretTable');
	});

	it('drops delayed Kusto search rows after a policy enable-disable interval', async () => {
		const viewer = createViewerHarness();
		const connection = { id: 'c1', name: 'Cluster', clusterUrl: 'https://cluster.kusto.windows.net' };
		let revocationGeneration = 0;
		let persisted: any;
		viewer.context = { globalState: {
			get: vi.fn(), update: vi.fn(async (_key: string, value: unknown) => { persisted = value; }),
		} };
		viewer.connectionManager = {
			getConnections: vi.fn(() => [connection]), getConnectionIncarnation: vi.fn(() => 1),
			runWithLeaveNoTraceSnapshotLock: vi.fn(async (run: (snapshot: any) => unknown) => await run({
				clusterKeys: [], globallyBlocked: false, version: revocationGeneration + 1,
				revocationGenerations: { cluster: revocationGeneration },
			})),
		};
		viewer.kustoClient = { getAccountPartition: vi.fn(() => 'partition-a') };
		const ownerToken = viewer.rememberKustoSearchOwners(await viewer.captureKustoSearchOwners());
		revocationGeneration = 2;

		await viewer.onMessage({
			type: 'search.saveState', kind: 'kusto', state: {
				query: 'Secret', scope: 'cached', lastSearchTimestamp: 123,
				lastResults: [{
					kind: 'kusto', connectionId: connection.id, name: 'SecretTable', kustoSearchOwnerToken: ownerToken,
				}],
			},
		});

		expect(persisted.lastResults).toEqual([]);
		expect(JSON.stringify(persisted)).not.toContain('SecretTable');
	});

	it('does not publish live Kusto search rows after a policy enable-disable interval', async () => {
		const viewer = createViewerHarness();
		const connection = { id: 'c1', name: 'Cluster', clusterUrl: 'https://cluster.kusto.windows.net' };
		let revocationGeneration = 0;
		const postKustoPublication = vi.fn(async () => true);
		viewer.postKustoPublication = postKustoPublication;
		viewer.context = {
			globalStorageUri: { fsPath: '', path: '/live-policy-interval', toString: () => 'file:///live-policy-interval' } as vscode.Uri,
			globalState: { get: vi.fn(() => ({ c1: ['SecretDb'] })), update: vi.fn(async () => undefined) },
		};
		viewer.connectionManager = {
			getConnections: vi.fn(() => [connection]), getConnectionIncarnation: vi.fn(() => 1),
			runWithLeaveNoTraceSnapshotLock: vi.fn(async (run: (snapshot: any) => unknown) => await run({
				clusterKeys: [], globallyBlocked: false, version: revocationGeneration + 1,
				revocationGenerations: { cluster: revocationGeneration },
			})),
		};
		viewer.kustoClient = { getAccountPartition: vi.fn(() => 'partition-a'), isAuthenticationError: vi.fn(() => false) };

		await viewer.onMessage({
			type: 'search', requestId: 'live-policy-interval', query: 'SecretDb', scope: 'cached', kind: 'kusto',
			categories: { clusters: false, databases: true, tables: false, functions: false }, contentToggles: {},
		});
		revocationGeneration = 2;
		await vi.waitFor(() => expect(viewer._activeSearchRequestId).toBeNull());

		const publishedRows = postKustoPublication.mock.calls
			.map(call => call[0] as any)
			.filter(message => message.type === 'searchResults')
			.flatMap(message => message.results || []);
		expect(publishedRows).toEqual([]);
	});

	it('keeps a Kusto search owner current when only another cluster policy changes', async () => {
		const viewer = createViewerHarness();
		const connection = { id: 'c1', name: 'Cluster', clusterUrl: 'https://cluster.kusto.windows.net' };
		viewer.context = { globalStorageUri: vscode.Uri.file('/search-unrelated-policy') };
		viewer.connectionManager = {
			getConnections: vi.fn(() => [connection]), getConnectionIncarnation: vi.fn(() => 1),
			runWithLeaveNoTraceSnapshotLock: vi.fn(async (run: (snapshot: any) => unknown) => await run({
				clusterKeys: [], globallyBlocked: false, version: 1,
				revocationGenerations: { cluster: 0 },
			})),
		};
		viewer.connectionCache = { captureGeneration: vi.fn(() => ({ global: 0, connection: 0, partition: 0 })) };
		viewer.authPreferences = { getConnectionSessionGeneration: vi.fn(() => 0) };
		viewer.kustoClient = { getAccountPartition: vi.fn(() => 'partition-a') };
		const owner = (await viewer.captureKustoSearchOwners()).get(connection.id);

		expect(viewer.isKustoSearchOwnerCurrent(owner, {
			clusterKeys: ['other'], globallyBlocked: false, version: 2,
			revocationGenerations: { cluster: 0, other: 1 },
		})).toBe(true);
	});

	it('restores an exact Kusto search proof after unrelated account and policy changes', async () => {
		const viewer = createViewerHarness();
		const connection = { id: 'c1', name: 'Cluster', clusterUrl: 'https://cluster.kusto.windows.net' };
		const unrelated = { id: 'c2', name: 'Other', clusterUrl: 'https://other.kusto.windows.net' };
		let persistedState: any;
		viewer.context = {
			globalStorageUri: vscode.Uri.file('/search-proof-reopen'),
			globalState: {
				get: vi.fn((key: string) => key === 'connectionManager.searchState' ? persistedState : undefined),
				update: vi.fn(async () => undefined),
			},
		};
		viewer.connectionManager = {
			getConnections: vi.fn(() => [connection, unrelated]), getConnectionIncarnation: vi.fn(() => 1),
			runWithLeaveNoTraceSnapshotLock: vi.fn(async (run: (snapshot: any) => unknown) => await run({
				clusterKeys: [], globallyBlocked: false, version: 1,
				revocationGenerations: { cluster: 0, other: 0 },
			})),
		};
		viewer.connectionCache = { captureGeneration: vi.fn(() => ({ global: 0, connection: 0, partition: 0 })) };
		viewer.authPreferences = {
			getAccounts: vi.fn(async () => []), getPreference: vi.fn(() => ({ mode: 'automatic' })),
			getPreferredAccountId: vi.fn(() => undefined), getConnectionSessionGeneration: vi.fn(() => 0),
		};
		viewer.kustoClient = {
			getAccountPartition: vi.fn((candidate: any) => candidate.id === 'c1' ? 'partition-a' : 'partition-b'),
		};
		viewer.getActiveKind = vi.fn(() => 'kusto');
		viewer.getFavorites = vi.fn(() => []);
		viewer.getCachedDatabases = vi.fn(() => ({}));
		viewer.getExpandedClusters = vi.fn(() => []);
		const owner = (await viewer.captureKustoSearchOwners()).get(connection.id);
		persistedState = {
			query: 'StillCurrent', scope: 'cached', lastSearchTimestamp: 123,
			kustoPrincipalFingerprint: 'before-unrelated-account-change', kustoPolicyVersion: 1,
			lastResults: [{
				kind: 'kusto', connectionId: connection.id, name: 'StillCurrent',
				kustoSearchOwner: viewer.persistedKustoSearchOwner(owner),
			}],
		};

		const snapshot = await viewer.buildSnapshot(1, false, {
			clusterKeys: ['other'], globallyBlocked: false, version: 2,
			revocationGenerations: { cluster: 0, other: 1 },
		});

		expect(snapshot.searchState.lastResults).toEqual([
			expect.objectContaining({ connectionId: 'c1', name: 'StillCurrent' }),
		]);
	});

	it('drops persisted Kusto search proof after schema cache clear', async () => {
		const viewer = createViewerHarness();
		const connection = { id: 'c1', name: 'Cluster', clusterUrl: 'https://cluster.kusto.windows.net' };
		let schemaGeneration = 0;
		let persisted: any;
		viewer.context = {
			globalStorageUri: vscode.Uri.file('/search-cache-clear'),
			globalState: { update: vi.fn(async (_key: string, value: unknown) => { persisted = value; }) },
		};
		viewer.connectionManager = {
			getConnections: vi.fn(() => [connection]), getConnectionIncarnation: vi.fn(() => 1),
			runWithLeaveNoTraceSnapshotLock: vi.fn(async (run: (snapshot: any) => unknown) => await run({
				clusterKeys: [], globallyBlocked: false, version: 1, revocationGenerations: { cluster: 0 },
			})),
		};
		viewer.connectionCache = { captureGeneration: vi.fn(() => ({ global: 0, connection: 0, partition: 0 })) };
		viewer.authPreferences = { getConnectionSessionGeneration: vi.fn(() => 0) };
		viewer.kustoClient = { getAccountPartition: vi.fn(() => 'partition-a') };
		const owner = (await viewer.captureKustoSearchOwners()).get(connection.id);
		const proof = viewer.persistedKustoSearchOwner(owner);
		schemaGeneration++;
		proof.schemaCacheGeneration = { ...proof.schemaCacheGeneration, global: schemaGeneration };

		await viewer.onMessage({
			type: 'search.saveState', kind: 'kusto', state: {
				query: 'Secret', scope: 'cached', lastSearchTimestamp: 1,
				lastResults: [{ kind: 'kusto', connectionId: connection.id, name: 'Secret', kustoSearchOwner: proof }],
			},
		});

		expect(persisted.lastResults).toEqual([]);
	});

	it('rejects live and persisted Kusto search rows after same-account session recreation', async () => {
		const viewer = createViewerHarness();
		const connection = { id: 'c1', name: 'Cluster', clusterUrl: 'https://cluster.kusto.windows.net' };
		let authGeneration = 0;
		let persisted: any;
		viewer.context = {
			globalStorageUri: { fsPath: '', path: '/search-auth-generation', toString: () => 'file:///search-auth-generation' } as vscode.Uri,
			globalState: {
				get: vi.fn((key: string) => key === 'kusto.cachedDatabases' ? { c1: ['SecretDb'] } : undefined),
				update: vi.fn(async (_key: string, value: unknown) => { persisted = value; }),
			},
		};
		viewer.connectionManager = {
			getConnections: vi.fn(() => [connection]), getConnectionIncarnation: vi.fn(() => 1),
			runWithLeaveNoTraceSnapshotLock: vi.fn(async (run: (snapshot: any) => unknown) => await run({
				clusterKeys: [], globallyBlocked: false, version: 1, revocationGenerations: {},
			})),
		};
		viewer.connectionCache = { captureGeneration: vi.fn(() => ({ global: 0, connection: 0, partition: 0 })) };
		viewer.authPreferences = {
			getConnectionSessionGeneration: vi.fn(() => authGeneration), waitForProviderAccountRefresh: vi.fn(async () => undefined),
		};
		viewer.kustoClient = { getAccountPartition: vi.fn(() => 'partition-a'), isAuthenticationError: vi.fn(() => false) };
		const owners = await viewer.captureKustoSearchOwners();
		const ownerToken = viewer.rememberKustoSearchOwners(owners);
		authGeneration = 1;

		const owner = owners.get(connection.id);
		expect(viewer.isKustoSearchOwnerCurrent(owner, { clusterKeys: [], globallyBlocked: false, version: 1 })).toBe(false);
		await viewer.onMessage({
			type: 'search.saveState', kind: 'kusto', state: {
				query: 'SecretDb', scope: 'cached', lastSearchTimestamp: 123,
				lastResults: [{
					kind: 'kusto', connectionId: connection.id, name: 'SecretDb', kustoSearchOwnerToken: ownerToken,
				}],
			},
		});

		expect(persisted.lastResults).toEqual([]);
		expect(JSON.stringify(persisted.lastResults)).not.toContain('SecretDb');
	});

	it.each([
		[undefined, 0, 1, 'sql'],
		[undefined, 1, 0, 'kusto'],
		[undefined, 1, 1, 'kusto'],
		[undefined, 0, 0, 'kusto'],
		['invalid', 0, 1, 'sql'],
		['invalid', 1, 0, 'kusto'],
		['invalid', 1, 1, 'kusto'],
		['invalid', 0, 0, 'kusto'],
		['kusto', 0, 1, 'kusto'],
		['kusto', 1, 0, 'kusto'],
		['kusto', 1, 1, 'kusto'],
		['kusto', 0, 0, 'kusto'],
		['sql', 0, 1, 'sql'],
		['sql', 1, 0, 'sql'],
		['sql', 1, 1, 'sql'],
		['sql', 0, 0, 'sql'],
	] as const)('resolves raw active kind %s with %i Kusto and %i SQL connections to %s', (raw, kustoCount, sqlCount, expectedKind) => {
		const viewer = createViewerHarness();
		const sqlState = {
			kind: 'sql', query: 'cm-sql-default', scope: 'cached',
			categories: { servers: false, databases: true, tables: false },
			lastResults: [{ kind: 'sql', connectionId: 'sql-1', name: 'SecretProcedure', matchContext: 'secret body' }],
			lastSearchTimestamp: 123,
		};
		const stored = new Map<string, unknown>([
			['connectionManager.activeKind', raw],
			['connectionManager.searchState', { kind: 'kusto', query: 'cm-kusto-default' }],
			['connectionManager.sqlSearchState', sqlState],
		]);
		const globalState = { get: vi.fn((key: string) => stored.get(key)), update: vi.fn() };
		viewer.context = { globalState };
		viewer.connectionManager = { getConnections: vi.fn(() => kustoCount ? [{}] : []) };
		const sqlManager = { getConnections: vi.fn(() => sqlCount ? [{}] : []) };
		viewer.sqlDeps = { getSqlConnectionManager: () => sqlManager };

		expect(viewer.getActiveKind()).toBe(expectedKind);
		if (expectedKind === 'sql') {
			expect(viewer.getSearchState()).toEqual({ ...sqlState, lastResults: [], lastSearchTimestamp: 0 });
		}
		expect(globalState.update).not.toHaveBeenCalled();
	});

	it('publishes restored per-kind search state after the active-kind write and preserves Kusto configuration', async () => {
		const harness = createSqlConnectionTestHarness({ authType: 'sql-login' });
		const { viewer, globalState, postMessage } = harness;
		const kustoState = {
			kind: 'kusto', query: 'cm-kusto-persist-b2', scope: 'selected',
			categories: { clusters: true, databases: false, tables: true },
			lastResults: [], lastSearchTimestamp: 0, kustoPrincipalFingerprint: '',
		};
		const sqlState = {
			kind: 'sql', query: 'cm-sql-persist', scope: 'cached',
			categories: { servers: false, databases: true, tables: false },
			lastResults: [{ kind: 'sql', connectionId: 'sql-1', name: 'SecretProcedure', matchContext: 'secret body' }],
			lastSearchTimestamp: 123,
		};
		const stored = new Map<string, unknown>([
			['connectionManager.activeKind', 'kusto'],
			['connectionManager.searchState', structuredClone(kustoState)],
			['connectionManager.sqlSearchState', structuredClone(sqlState)],
		]);
		const kindWrite = deferred<void>();
		globalState.get.mockImplementation((key: string) => stored.get(key));
		globalState.update.mockImplementation(async (key: string, value: unknown) => {
			await kindWrite.promise;
			stored.set(key, value);
		});
		viewer.snapshotRevision = 0;
		viewer.authPreferences = { getAccounts: vi.fn(async () => []) };
		viewer.connectionManager = {
			getConnections: vi.fn(() => []),
			getLeaveNoTraceClusters: vi.fn(() => []),
			runWithLeaveNoTraceSnapshotLock: vi.fn(async (run: (snapshot: any) => unknown) => await run({
				clusterKeys: [], globallyBlocked: false, version: 1, revocationGenerations: {},
			})),
		};
		viewer.getFavorites = vi.fn(() => []);
		viewer.getCachedDatabases = vi.fn(() => ({}));
		viewer.getExpandedClusters = vi.fn(() => []);
		const publishSnapshot = vi.spyOn(viewer, 'sendSnapshotToWebview');

		const switchToSql = viewer.onMessage({ type: 'setActiveKind', kind: 'sql' });
		await flushAsyncDispatch();
		expect(globalState.update).toHaveBeenCalledExactlyOnceWith('connectionManager.activeKind', 'sql');
		expect(stored.get('connectionManager.activeKind')).toBe('kusto');
		expect(publishSnapshot).not.toHaveBeenCalled();
		expect(postMessage).not.toHaveBeenCalled();

		kindWrite.resolve();
		await switchToSql;

		expect(publishSnapshot).toHaveBeenCalledTimes(1);
		expect(postMessage).toHaveBeenCalledExactlyOnceWith({
			type: 'snapshot', snapshot: expect.objectContaining({
				activeKind: 'sql',
				searchState: { ...sqlState, lastResults: [], lastSearchTimestamp: 0, kustoPolicyVersion: 1 },
			}),
		});

		await viewer.onMessage({ type: 'setActiveKind', kind: 'kusto' });

		expect(publishSnapshot).toHaveBeenCalledTimes(2);
		expect(postMessage).toHaveBeenCalledTimes(2);
		expect(postMessage).toHaveBeenLastCalledWith({
			type: 'snapshot', snapshot: expect.objectContaining({
				activeKind: 'kusto', searchState: { ...kustoState, kustoPolicyVersion: 1 },
			}),
		});
		expect(stored.get('connectionManager.searchState')).toEqual(kustoState);
		expect(stored.get('connectionManager.sqlSearchState')).toEqual(sqlState);
		expect(globalState.update.mock.calls).toEqual([
			['connectionManager.activeKind', 'sql'], ['connectionManager.activeKind', 'kusto'],
		]);

		const writeFailure = new Error('Active kind write failed');
		globalState.update.mockRejectedValueOnce(writeFailure);
		await expect(viewer.onMessage({ type: 'setActiveKind', kind: 'sql' })).rejects.toBe(writeFailure);
		expect(stored.get('connectionManager.activeKind')).toBe('kusto');
		expect(publishSnapshot).toHaveBeenCalledTimes(2);
		expect(postMessage).toHaveBeenCalledTimes(2);
	});

	it('never persists or restores SQL search result rows', async () => {
		const viewer = createViewerHarness();
		let persisted: any = {
			query: 'Secret', scope: 'cached', lastResults: [{ connectionId: 'sql-1', name: 'SecretProcedure', matchContext: 'secret body' }],
			lastSearchTimestamp: 123,
		};
		viewer.context = {
			globalState: {
				get: vi.fn((key: string) => key === 'connectionManager.activeKind' ? 'sql' : persisted),
				update: vi.fn(async (_key: string, value: unknown) => { persisted = value; }),
			},
		};

		expect(viewer.getSearchState()).toEqual(expect.objectContaining({ lastResults: [], lastSearchTimestamp: 0 }));
		await viewer.setSearchState({
			query: 'New', scope: 'everything', lastResults: [{ connectionId: 'sql-1', name: 'NewSecret' }],
			lastSearchTimestamp: 456,
		});
		expect(persisted).toEqual(expect.objectContaining({
			query: 'New', scope: 'everything', lastResults: [], lastSearchTimestamp: 0,
		}));
		viewer.connectionManager = {
			getConnections: vi.fn(() => [{ id: 'kusto-1', name: 'Kusto', clusterUrl: 'https://kusto-1.kusto.windows.net' }]),
			getConnectionIncarnation: vi.fn(() => 1),
			runWithLeaveNoTraceSnapshotLock: vi.fn(async (run: (snapshot: any) => unknown) => await run({
				clusterKeys: [], globallyBlocked: false,
			})),
		};
		viewer.kustoClient = { getAccountPartition: vi.fn(() => 'partition-a') };

		await viewer.setSearchState({
			query: 'Mixed', scope: 'cached',
			lastResults: [
				{ kind: 'sql', connectionId: 'sql-1', name: 'SecretSql', matchContext: 'secret body' },
				{ kind: 'kusto', connectionId: 'kusto-1', name: 'SafeKusto' },
			],
			lastSearchTimestamp: 789,
		}, 'kusto');
		expect(persisted.lastResults).toEqual([]);
		expect(JSON.stringify(persisted)).not.toContain('SecretSql');
	});

	it.each(['target', 'principal'] as const)('drops cached SQL schema matches when the %s changes during disk search', async change => {
		const harness = createSqlConnectionTestHarness({ accountId: 'account-a' });
		const storageUri = { fsPath: '', path: '/cached-search-race', toString: () => 'file:///cached-search-race' } as vscode.Uri;
		harness.viewer.context = { ...harness.viewer.context, globalStorageUri: storageUri };
		harness.viewer._activeSearchRequestId = `cached-${change}`;
		const startingConnection = harness.getConnection();
		const principalFingerprint = sqlSchemaPrincipalFingerprint(harness.viewer.context, startingConnection)!;
		const cacheGeneration = await captureSqlSchemaCacheGeneration(storageUri);
		const entry = {
			version: SQL_SCHEMA_CACHE_VERSION,
			schema: { tables: ['SecretTable'], columnsByTable: {} },
			timestamp: Date.now(),
			serverUrl: startingConnection.serverUrl,
			database: 'DbA',
			connectionId: startingConnection.id,
			cacheGeneration,
			principalFingerprint,
			targetSignature: sqlSchemaTargetSignature(startingConnection),
		};
		const pendingRead = deferred<Uint8Array>();
		const fsApi = vscode.workspace.fs as any;
		const originalReadDirectory = fsApi.readDirectory;
		const originalReadFile = fsApi.readFile;
		fsApi.readDirectory = vi.fn(async () => [['entry.json', 1]]);
		fsApi.readFile = vi.fn(() => pendingRead.promise);
		const sendResults = vi.fn();

		try {
			const search = harness.viewer._searchCachedSchemasForSearch(
				'sql', 'SecretTable', { tables: true }, { tables: true },
				`cached-${change}`, new AbortController().signal, sendResults,
			);
			await vi.waitFor(() => expect(fsApi.readFile).toHaveBeenCalledOnce());
			if (change === 'target') harness.setConnection({ ...startingConnection, port: 1434 });
			else harness.setAccountId('account-b');
			pendingRead.resolve(Buffer.from(JSON.stringify(entry), 'utf8'));
			await search;

			expect(sendResults).not.toHaveBeenCalled();
		} finally {
			if (originalReadDirectory === undefined) delete fsApi.readDirectory;
			else fsApi.readDirectory = originalReadDirectory;
			fsApi.readFile = originalReadFile;
		}
	});

	it('drops live SQL schema matches when the target changes during Search Everything', async () => {
		const harness = createSqlConnectionTestHarness({ accountId: 'account-a' });
		const pendingSchema = deferred<any>();
		harness.getDatabases.mockResolvedValue(['DbA']);
		const getDatabaseSchema = vi.fn(() => pendingSchema.promise);
		harness.viewer.sqlDeps.getSqlClient = () => ({ getDatabases: harness.getDatabases, getDatabaseSchema });
		harness.viewer._activeSearchRequestId = 'search-1';
		const sendResults = vi.fn();
		const signal = new AbortController().signal;

		const search = harness.viewer._refreshSchemasForSearch(
			'sql', 'everything', 'SecretTable', { tables: true }, { tables: true },
			'search-1', signal, sendResults, vi.fn(),
		);
		await vi.waitFor(() => expect(getDatabaseSchema).toHaveBeenCalledOnce());
		harness.setConnection({ ...harness.getConnection(), serverUrl: 'server-b.example' });
		pendingSchema.resolve({ tables: ['SecretTable'], columnsByTable: {} });
		await search;

		expect(sendResults).not.toHaveBeenCalled();
	});

	it('drops live SQL schema matches when the principal changes during Search Everything', async () => {
		const harness = createSqlConnectionTestHarness({ accountId: 'account-a' });
		const pendingSchema = deferred<any>();
		harness.getDatabases.mockResolvedValue(['DbA']);
		const getDatabaseSchema = vi.fn(() => pendingSchema.promise);
		harness.viewer.sqlDeps.getSqlClient = () => ({ getDatabases: harness.getDatabases, getDatabaseSchema });
		harness.viewer._activeSearchRequestId = 'search-2';
		const sendResults = vi.fn();

		const search = harness.viewer._refreshSchemasForSearch(
			'sql', 'everything', 'SecretTable', { tables: true }, { tables: true },
			'search-2', new AbortController().signal, sendResults, vi.fn(),
		);
		await vi.waitFor(() => expect(getDatabaseSchema).toHaveBeenCalledOnce());
		harness.setAccountId('account-b');
		pendingSchema.resolve({ tables: ['SecretTable'], columnsByTable: {} });
		await search;

		expect(sendResults).not.toHaveBeenCalled();
	});

	it('drops Kusto search results when reopening under a different principal fingerprint', () => {
		const viewer = createViewerHarness();
		viewer.context = { globalState: { get: vi.fn(() => ({
			query: 'SecretA', scope: 'cached', lastResults: [{ name: 'SecretA' }],
			kustoPrincipalFingerprint: 'conn-a|partition-a',
		})) } };
		viewer.getActiveKind = vi.fn(() => 'kusto');
		viewer.getKustoSearchPrincipalFingerprint = vi.fn(() => 'conn-a|partition-b');

		expect(viewer.getSearchState()).toEqual(expect.objectContaining({ lastResults: [], lastSearchTimestamp: 0 }));
	});

	it('drops legacy SQL search rows even under a valid Kusto search fingerprint', () => {
		const viewer = createViewerHarness();
		viewer.getKustoSearchPrincipalFingerprint = vi.fn(() => 'conn-a|partition-a');
		viewer.context = { globalState: { get: vi.fn((key: string) => key === 'connectionManager.activeKind' ? 'kusto' : ({
			query: 'Mixed', scope: 'cached', kustoPrincipalFingerprint: 'conn-a|partition-a',
			lastResults: [
				{ kind: 'sql', connectionId: 'sql-a', name: 'SecretProcedure', matchContext: 'secret body' },
				{ kind: 'kusto', connectionId: 'conn-a', name: 'SafeTable' },
			],
			lastSearchTimestamp: 123,
		})) } };

		expect(viewer.getSearchState()).toEqual(expect.objectContaining({
			lastResults: [{ kind: 'kusto', connectionId: 'conn-a', name: 'SafeTable' }],
			lastSearchTimestamp: 0,
		}));
	});
});

describe('ConnectionManagerViewerV2 favorite prompt ownership', () => {
	it.each(['add', 'rename'] as const)('does not commit an A favorite %s after rotation to B', async action => {
		const viewer = createViewerHarness();
		const connection = { id: 'c1', name: 'Cluster', clusterUrl: 'https://cluster.kusto.windows.net' };
		let partition = 'partition-a';
		const picked = deferred<string | undefined>();
		vi.spyOn(vscode.window, 'showInputBox').mockReturnValue(picked.promise as any);
		viewer.connectionManager = { getConnections: vi.fn(() => [connection]) };
		viewer.kustoClient = { getAccountPartition: vi.fn(() => partition) };
		viewer.getFavorites = vi.fn(() => action === 'rename' ? [{
			name: 'A favorite', connectionId: 'c1', clusterUrl: connection.clusterUrl, database: 'SecretA',
		}] : []);
		viewer.setFavorites = vi.fn(async () => undefined);
		viewer.sendSnapshotToWebview = vi.fn(async () => undefined);

		const prompt = action === 'add'
			? viewer.promptAddFavorite('c1', 'SecretA')
			: viewer.promptRenameFavorite('c1', 'SecretA');
		await Promise.resolve();
		partition = 'partition-b';
		picked.resolve('Changed favorite');
		await prompt;

		expect(viewer.setFavorites).not.toHaveBeenCalled();
	});
});

describe('ConnectionManagerViewerV2 SQL connection test ownership', () => {
	it('returns a terminal failure when Leave No Trace blocks connection testing', async () => {
		const harness = createSqlConnectionTestHarness({ authType: 'sql-login' });
		harness.assertSqlConnectionAllowed.mockRejectedValueOnce(new Error('Leave No Trace blocked'));

		await harness.viewer.onMessage(sqlTestMessage(harness.getConnection()));

		const started = harness.postMessage.mock.calls.map(call => call[0]).find(message => message.type === 'sql.testConnectionStarted');
		expect(started).toBeTruthy();
		expect(harness.postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'sql.testConnectionResult', requestId: started.requestId, success: false,
			message: expect.stringContaining('Leave No Trace'),
		}));
		expect(harness.getDatabases).not.toHaveBeenCalled();
	});

	it.each(['sql.cluster.expand', 'sql.cluster.refreshDatabases'] as const)('allows first AAD identity establishment during %s', async type => {
		const harness = createSqlConnectionTestHarness();
		harness.getDatabases.mockImplementation(async () => {
			harness.setAccountId('account-a');
			return ['DbA'];
		});

		await harness.viewer.onMessage({ type, connectionId: 'sql-1' });

		expect((harness.cachedDatabases as any).entries['sql-1']).toEqual(expect.objectContaining({ databases: ['DbA'] }));
		expect(harness.postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'sql.databasesLoaded', connectionId: 'sql-1', databases: ['DbA'],
		}));
	});

	it('keeps the newest ordinary refresh when responses complete in reverse order', async () => {
		const harness = createSqlConnectionTestHarness({ accountId: 'account-a' });
		const older = deferred<string[]>();
		const newer = deferred<string[]>();
		let invocation = 0;
		harness.getDatabases.mockImplementation(() => (++invocation === 1 ? older.promise : newer.promise));

		const olderRun = harness.viewer.onMessage({ type: 'sql.cluster.refreshDatabases', connectionId: 'sql-1' });
		await vi.waitFor(() => expect(harness.getDatabases).toHaveBeenCalledTimes(1));
		const newerRun = harness.viewer.onMessage({ type: 'sql.cluster.refreshDatabases', connectionId: 'sql-1' });
		await vi.waitFor(() => expect(harness.getDatabases).toHaveBeenCalledTimes(2));
		newer.resolve(['CurrentDb']);
		await newerRun;
		older.resolve(['OldDb']);
		await olderRun;

		expect((harness.cachedDatabases as any).entries['sql-1']).toEqual(expect.objectContaining({ databases: ['CurrentDb'] }));
	});

	it('does not resurrect a deleted cache after pending refresh completes', async () => {
		const harness = createSqlConnectionTestHarness({ accountId: 'account-a' });
		const pending = deferred<string[]>();
		harness.getDatabases.mockReturnValue(pending.promise);

		const refresh = harness.viewer.onMessage({ type: 'sql.cluster.refreshDatabases', connectionId: 'sql-1' });
		await vi.waitFor(() => expect(harness.getDatabases).toHaveBeenCalledOnce());
		await harness.viewer.onMessage({ type: 'sql.cluster.collapse', connectionId: 'sql-1' });
		const { deleteSqlDatabaseCacheEntry } = await import('../../../src/host/sqlDatabaseCache');
		await deleteSqlDatabaseCacheEntry(harness.viewer.context, 'sql.connectionManager.cachedDatabases', 'sql-1');
		pending.resolve(['StaleDb']);
		await refresh;

		expect((harness.cachedDatabases as any).entries).toEqual({});
	});

	it('allows a first AAD test to establish its principal before admitting metadata', async () => {
		const harness = createSqlConnectionTestHarness();
		harness.getDatabases.mockImplementation(async () => {
			harness.setAccountId('account-a');
			return ['DbA'];
		});

		await harness.viewer.onMessage(sqlTestMessage(harness.getConnection()));

		expect((harness.cachedDatabases as any).entries['sql-1']).toEqual(expect.objectContaining({
			version: 1,
			connectionId: 'sql-1',
			databases: ['DbA'],
			principalFingerprint: expect.any(String),
			targetSignature: expect.stringMatching(/^v2:[0-9a-f]{64}$/),
		}));
		expect(harness.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({
			type: 'sql.testConnectionResult', connectionId: 'sql-1', success: true,
		}));
	});

	it('uses a draft SQL Login password only for the test operation', async () => {
		const harness = createSqlConnectionTestHarness({ authType: 'sql-login' });
		harness.getDatabases.mockResolvedValue(['Db']);

		await harness.viewer.onMessage(sqlTestMessage(harness.getConnection(), 'draft-password'));

		expect(harness.manager.setPassword).not.toHaveBeenCalled();
		expect(harness.getDatabases).toHaveBeenCalledWith(
			expect.objectContaining(harness.getConnection()),
			{ passwordOverride: 'draft-password', allowUncommittedTarget: false },
		);
	});

	it('correlates a changed SQL Login target failure when no replacement password is supplied', async () => {
		const harness = createSqlConnectionTestHarness({ authType: 'sql-login' });
		await harness.viewer.onMessage(sqlTestMessage({ ...harness.getConnection(), serverUrl: 'changed.example' }));

		const started = harness.postMessage.mock.calls.map(call => call[0]).find(message => message.type === 'sql.testConnectionStarted');
		expect(started).toBeTruthy();
		expect(harness.postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'sql.testConnectionResult', requestId: started.requestId, success: false,
			message: expect.stringContaining('password'),
		}));
		expect(harness.getDatabases).not.toHaveBeenCalled();
	});

	it('uses the stored password when testing an unchanged revisioned SQL Login', async () => {
		const harness = createSqlConnectionTestHarness({ authType: 'sql-login' });
		harness.setConnection({ ...harness.getConnection(), credentialRevision: 1 });
		harness.getDatabases.mockResolvedValue(['Db']);

		await harness.viewer.onMessage(sqlTestMessage(harness.getConnection()));

		expect(harness.getDatabases).toHaveBeenCalledWith(
			expect.objectContaining({ id: 'sql-1', credentialRevision: 1 }),
			{ passwordOverride: undefined, allowUncommittedTarget: false },
		);
		expect(harness.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({
			type: 'sql.testConnectionResult', connectionId: 'sql-1', success: true,
		}));
	});

	it('tests every draft target field without publishing databases to the saved owner cache', async () => {
		const harness = createSqlConnectionTestHarness({ authType: 'sql-login' });
		harness.getDatabases.mockResolvedValue(['DraftDb']);
		const draft = {
			...harness.getConnection(),
			name: 'Draft SQL', serverUrl: 'draft.example', port: 1444,
			username: 'DraftUser', database: 'DraftDb',
		};

		await harness.viewer.onMessage(sqlTestMessage(draft, 'draft-password'));

		expect(harness.getDatabases).toHaveBeenCalledWith(
			expect.objectContaining({
				id: 'sql-1', name: 'Draft SQL', serverUrl: 'draft.example', port: 1444,
				username: 'DraftUser', database: 'DraftDb',
			}),
			{ passwordOverride: 'draft-password', allowUncommittedTarget: true },
		);
		expect((harness.cachedDatabases as any).entries).toBeUndefined();
	});

	it('admits only the newest overlapping test for an unchanged target', async () => {
		const harness = createSqlConnectionTestHarness({ accountId: 'account-a' });
		const first = deferred<string[]>();
		const second = deferred<string[]>();
		let invocation = 0;
		harness.getDatabases.mockImplementation(() => (++invocation === 1 ? first.promise : second.promise));

		const firstRun = harness.viewer.onMessage(sqlTestMessage(harness.getConnection()));
		await vi.waitFor(() => expect(harness.getDatabases).toHaveBeenCalledTimes(1));
		const secondRun = harness.viewer.onMessage(sqlTestMessage(harness.getConnection()));
		await vi.waitFor(() => expect(harness.getDatabases).toHaveBeenCalledTimes(2));
		first.resolve(['OldDb']);
		await firstRun;

		expect((harness.cachedDatabases as any).entries).toEqual({});
		expect(harness.postMessage.mock.calls.map(call => call[0]).filter(message => message.type === 'sql.testConnectionResult')).toEqual([]);

		second.resolve(['CurrentDb']);
		await secondRun;
		const started = harness.postMessage.mock.calls.map(call => call[0]).filter(message => message.type === 'sql.testConnectionStarted');
		const terminal = harness.postMessage.mock.calls.map(call => call[0]).filter(message => message.type === 'sql.testConnectionResult');
		expect(started).toHaveLength(2);
		expect(terminal).toEqual([expect.objectContaining({ requestId: started[1].requestId, success: true })]);
		expect((harness.cachedDatabases as any).entries['sql-1']).toEqual(expect.objectContaining({ databases: ['CurrentDb'] }));
	});

	it('invalidates an owned cache before editing the same connection ID to a new target', async () => {
		const harness = createSqlConnectionTestHarness({ accountId: 'account-a' });
		harness.getDatabases.mockResolvedValue(['DbA']);
		await harness.viewer.onMessage(sqlTestMessage(harness.getConnection()));
		expect((harness.cachedDatabases as any).entries['sql-1']).toEqual(expect.objectContaining({ databases: ['DbA'] }));

		harness.manager.updateConnectionAndPassword = vi.fn(async (_id: string, updates: Record<string, unknown>) => {
			harness.setConnection({ ...harness.getConnection(), ...updates });
		});
		harness.viewer.sendSnapshotToWebview = vi.fn(async () => undefined);
		await harness.viewer.onMessage({
			type: 'sql.connection.edit', id: 'sql-1', name: 'SQL B', serverUrl: 'server-b.example',
			dialect: 'mssql', authType: 'aad', database: 'master',
		});

		expect((harness.cachedDatabases as any).entries['sql-1']).toBeUndefined();
		expect(await harness.viewer.getSqlCachedDatabases()).toEqual({});
		expect(harness.manager.updateConnectionAndPassword).toHaveBeenCalledWith('sql-1', expect.objectContaining({ serverUrl: 'server-b.example' }), undefined);
	});

	it('unblocks database discovery when an in-place edit fails and the old record survives', async () => {
		const harness = createSqlConnectionTestHarness({ accountId: 'account-a' });
		harness.manager.updateConnectionAndPassword = vi.fn(async () => { throw new Error('save failed'); });
		harness.viewer.sendSnapshotToWebview = vi.fn(async () => undefined);

		await harness.viewer.onMessage({
			type: 'sql.connection.edit', id: 'sql-1', name: 'SQL B', serverUrl: 'server-b.example',
			dialect: 'mssql', authType: 'aad', database: 'master',
		});

		const { beginSqlDatabaseCacheRequest } = await import('../../../src/host/sqlDatabaseCache');
		await expect(beginSqlDatabaseCacheRequest(harness.viewer.context, 'sql.connectionManager.cachedDatabases', harness.getConnection()))
			.resolves.toEqual(expect.objectContaining({ connectionId: 'sql-1' }));
	});

	it.each(['legacy-array', 'principal-rotated', 'target-edited'] as const)('does not expose a %s database cache', async change => {
		const harness = createSqlConnectionTestHarness({ accountId: 'account-a' });
		if (change === 'legacy-array') {
			(harness.cachedDatabases as any)['sql-1'] = ['LegacyDb'];
		} else {
			harness.getDatabases.mockResolvedValue(['AccountADb']);
			await harness.viewer.onMessage(sqlTestMessage(harness.getConnection()));
			if (change === 'principal-rotated') harness.setAccountId('account-b');
			if (change === 'target-edited') harness.setConnection({ ...harness.getConnection(), serverUrl: 'server-b.example' });
		}

		expect(await harness.viewer.getSqlCachedDatabases()).toEqual({});
	});

	it.each(['edited', 'deleted', 'principal-rotated'] as const)('drops a pending test when its owner is %s', async change => {
		const harness = createSqlConnectionTestHarness({ accountId: 'account-a' });
		const pending = deferred<string[]>();
		harness.getDatabases.mockReturnValue(pending.promise);

		const run = harness.viewer.onMessage(sqlTestMessage(harness.getConnection()));
		await vi.waitFor(() => expect(harness.getDatabases).toHaveBeenCalledOnce());
		if (change === 'edited') harness.setConnection({ ...harness.getConnection(), database: 'OtherDb' });
		if (change === 'deleted') harness.setConnection(undefined);
		if (change === 'principal-rotated') harness.setAccountId('account-b');
		pending.resolve(['StaleDb']);
		await run;

		expect((harness.cachedDatabases as any).entries).toEqual({});
		expect(harness.postMessage.mock.calls.map(call => call[0]).filter(message => message.type === 'sql.testConnectionResult')).toEqual([]);
	});
});