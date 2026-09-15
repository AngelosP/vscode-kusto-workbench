import { readFileSync } from 'fs';
import { dirname, isAbsolute, join } from 'path';
import { runInNewContext } from 'vm';
import * as ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import {
	createKqlxOrMdxFileWithDefaultSection, parseKqlxText, stringifyKqlxFile,
} from '../../../src/host/kqlxFormat';
import { extractSchemaFromJson } from '../../../src/host/kustoClientUtils';
import { SCHEMA_CACHE_VERSION, schemaCacheKey, type CachedSchemaEntry } from '../../../src/host/schemaCache';

const root = process.cwd();
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
	activationEvents: string[];
	scripts: { package: string };
	dependencies: Record<string, string>;
	contributes: {
		commands: Array<{ command: string }>;
		configuration: { properties: Record<string, { scope?: string }> };
	};
};
const extensionSource = readFileSync(join(root, 'src', 'host', 'extension.ts'), 'utf8');
const remoteSource = readFileSync(join(root, 'src', 'host', 'remoteFileOpener.ts'), 'utf8');
const queryToolbarSource = readFileSync(join(root, 'src', 'webview', 'sections', 'kw-query-toolbar.ts'), 'utf8');
const testHelpersSource = readFileSync(join(root, 'src', 'webview', 'core', 'test-helpers.ts'), 'utf8');
const esbuildSource = readFileSync(join(root, 'esbuild.js'), 'utf8');
const sizeReportSource = readFileSync(join(root, 'scripts', 'bundle-size.mjs'), 'utf8');
const sizeGateSource = readFileSync(join(root, 'scripts', 'bundle-size-gate.mjs'), 'utf8');

const extensionGatedCommands = [
	'kusto.openQueryEditor',
	'kusto.openTutorials',
	'kusto.manageConnections',
	'kusto.deleteAllConnections',
	'kusto.openKqlxFile',
	'kusto.openMdxFile',
	'kusto.saveKqlxAs',
	'kusto.seeCachedValues',
	'kusto.showDevelopmentNotes',
	'kusto.resetCopilotModelSelection',
	'kusto.openCustomAgent',
	'kusto.exportSkill',
];

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>(resolvePromise => { resolve = resolvePromise; });
	return { promise, resolve };
}

function extensionCommandCallback(commandId: string): string {
	const sourceFile = ts.createSourceFile('extension.ts', extensionSource, ts.ScriptTarget.Latest, true);
	const initializers = new Map<string, ts.Expression>();
	let callback: ts.Expression | undefined;
	const visit = (node: ts.Node): void => {
		if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
			initializers.set(node.name.text, node.initializer);
		}
		if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
			&& node.expression.name.text === 'registerCommand'
			&& node.arguments[0] && ts.isStringLiteral(node.arguments[0])
			&& node.arguments[0].text === commandId) {
			callback = node.arguments[1];
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	const callbackSource = (callback && ts.isIdentifier(callback) ? initializers.get(callback.text) : callback)?.getText(sourceFile);
	expect(callbackSource, commandId).toBeDefined();
	return callbackSource!;
}

describe('persisted-result offline fixture', () => {
	function fixture(holdAssertion = false) {
		const account = { id: 'kusto-workbench-persisted-result-test-account', label: 'Kusto Workbench persisted-result test account' };
		const clusterUrl = 'https://persisted-results-e2e.kusto.windows.net';
		const database = 'PersistedDb';
		type Connection = { id: string; name: string; clusterUrl: string; database: string; authorityId: string };
		const connection: Connection = {
			id: 'fixture-connection', name: 'E2E Persisted Result Fixture Kusto', clusterUrl, database, authorityId: 'organizations',
		};
		const accountPartition = `${connection.authorityId}/${account.id}`;
		const connections = new Map<string, Connection>();
		const preferences = new Map<string, string>();
		const databases = new Map<string, string[]>();
		const schemas = new Map<string, CachedSchemaEntry>();
		const files = new Map<string, string>();
		const initialCachesReady = deferred();
		const assertionHeld = deferred();
		if (!holdAssertion) assertionHeld.resolve();
		let authTail = Promise.resolve();
		let lifecycleTail = Promise.resolve();
		const clearCaches = vi.fn(() => { databases.clear(); schemas.clear(); });
		const auth = {
			waitForProviderAccountRefresh: vi.fn().mockResolvedValue(undefined),
			getPreferredAccountId: vi.fn((connectionId: string) => preferences.get(connectionId)),
			getAccountPartition: (authorityId: string, accountId: string) => `${authorityId}/${accountId}`,
			setExplicitAccount: vi.fn(async (connectionId: string, selected: typeof account) => { preferences.set(connectionId, selected.id); }),
			setTokenOverride: vi.fn(async () => {
				authTail = authTail.then(() => { lifecycleTail = lifecycleTail.then(() => { clearCaches(); }); });
			}),
			waitForWriteSettlement: vi.fn(async () => { await authTail; }),
		};
		const snapshot = { globallyBlocked: false, clusterKeys: [] as string[], revocationGenerations: {} as Record<string, number> };
		const connectionManager = {
			getConnections: () => [...connections.values()],
			addConnection: vi.fn(async () => { connections.set(connection.id, connection); return connection; }),
			getConnectionIncarnation: vi.fn(() => 1),
			getLeaveNoTraceRevision: () => 0,
			waitForSettlement: vi.fn(async () => {
				await lifecycleTail;
				if (schemas.size) { initialCachesReady.resolve(); await assertionHeld.promise; }
			}),
			runWithLeaveNoTraceSnapshotLock: async (action: (current: typeof snapshot) => Promise<void>) => action(snapshot),
		};
		const cacheKey = (connectionId: string, partition: string) => JSON.stringify([connectionId, partition]);
		const cache = {
			getDatabases: vi.fn((connectionId: string, partition: string) => databases.get(cacheKey(connectionId, partition)) ?? []),
			setDatabases: vi.fn(async (connectionId: string, partition: string, values: string[]) => {
				databases.set(cacheKey(connectionId, partition), values);
				return true;
			}),
		};
		const writeSchema = vi.fn(async (_storage: unknown, key: string, entry: CachedSchemaEntry) => {
			schemas.set(key, entry);
			return true;
		});
		const readSchema = vi.fn(async (_storage: unknown, cluster: string, target: string, connectionId: string, partition: string) =>
			schemas.get(schemaCacheKey(cluster, target, connectionId, partition)));
		const template = { version: 1, state: { sections: [{
			id: 'query_fixture', type: 'query', query: 'PersistedFixture', connectionIdHint: 'old-connection',
			kustoAccountPartition: 'old-partition', kustoLeaveNoTraceRevision: 9,
			resultJson: JSON.stringify({ columns: ['RowId'], rows: [[7]], metadata: { preserved: true } }),
		}] } };
		type Uri = { fsPath: string };
		const writeFile = vi.fn(async (uri: Uri, bytes: Uint8Array) => { files.set(uri.fsPath, Buffer.from(bytes).toString('utf8')); });
		const context = { extensionPath: root, globalStorageUri: { fsPath: join(root, 'fixture-storage') } };
		const prepare = runInNewContext(ts.transpileModule(`(${extensionCommandCallback('kustoWorkbench.test.preparePersistedResultFixture')});`, {
			compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
		}).outputText, {
			Buffer, path: { dirname, isAbsolute, join }, context,
			vscode: {
				Uri: { file: (fsPath: string) => ({ fsPath }), joinPath: (uri: Uri, name: string) => ({ fsPath: join(uri.fsPath, name) }) },
				workspace: { fs: {
					readFile: vi.fn(async () => Buffer.from(JSON.stringify(template))),
					createDirectory: vi.fn().mockResolvedValue(undefined), writeFile,
					delete: vi.fn(async (uri: Uri) => { files.delete(uri.fsPath); }),
				} },
			},
			persistedResultFixtureStartupCleanup: Promise.resolve(), cleanupPersistedResultFixtureState: vi.fn().mockResolvedValue(undefined),
			persistedResultFixturePrefix: 'E2E Persisted Result Fixture', persistedResultKustoCluster: clusterUrl,
			persistedResultKustoDatabase: database, persistedResultAuthAccount: account,
			testAuthPreferences: auth, testConnectionCache: cache, connectionManager,
			SCHEMA_CACHE_VERSION, schemaCacheKey, writeCachedSchemaToDisk: writeSchema, readCachedSchemaFromDiskByCluster: readSchema,
			getKustoConnectionIdentityKey: (cluster: string, authority: string) => JSON.stringify([cluster, authority]),
			kustoClusterKey: (cluster: string) => cluster,
		}) as (request: { engine: string; templatePath: string; outputPath: string; legacyKusto?: boolean }) => Promise<{ outputPath: string; connectionId: string }>;
		const request = { engine: 'kusto', templatePath: 'template.kqlx', outputPath: 'output.kqlx', legacyKusto: true };
		return {
			prepare, request, connection, account, accountPartition, connections, preferences, databases, schemas, files,
			auth, cache, writeSchema, readSchema, writeFile, clearCaches, connectionManager, snapshot, initialCachesReady, assertionHeld,
		};
	}

	function expectPublishedFixture(setup: ReturnType<typeof fixture>, legacyKusto: boolean) {
		expect(setup.cache.getDatabases(setup.connection.id, setup.accountPartition)).toEqual(['PersistedDb']);
		expect([...setup.schemas.values()]).toEqual([expect.objectContaining({
			connectionId: setup.connection.id, accountPartition: setup.accountPartition,
			database: 'PersistedDb', clusterUrl: setup.connection.clusterUrl, version: SCHEMA_CACHE_VERSION,
			schema: { tables: ['PersistedFixture'], columnTypesByTable: { PersistedFixture: { RowId: 'long' } } },
		})]);
		expect(setup.files.size).toBe(1);
		expect(setup.writeFile).toHaveBeenCalledTimes(1);
		expect(setup.files.get(join(root, 'output.kqlx'))).toBe(`${JSON.stringify({ version: 1, state: { sections: [{
			id: 'query_fixture', type: 'query', query: 'PersistedFixture',
			...(legacyKusto ? {} : { kustoAccountPartition: setup.accountPartition, kustoLeaveNoTraceRevision: 0 }),
			resultJson: JSON.stringify({ columns: ['RowId'], rows: [[7]], metadata: {
				preserved: true, cluster: setup.connection.clusterUrl, database: 'PersistedDb',
			} }),
			clusterUrl: setup.connection.clusterUrl, authorityId: 'organizations', database: 'PersistedDb',
		}] } }, null, 2)}\n`);
	}

	it.each([true, false])('preserves exact output without synthetic artifact privileges (legacyKusto=%s)', async legacyKusto => {
		const setup = fixture();
		await expect(setup.prepare({ ...setup.request, legacyKusto })).resolves.toEqual({
			outputPath: join(root, 'output.kqlx'), connectionId: setup.connection.id,
		});
		expect(setup.auth.setTokenOverride).toHaveBeenCalledTimes(1);
		expect(setup.cache.setDatabases).toHaveBeenCalledTimes(1);
		expect(setup.writeSchema).toHaveBeenCalledTimes(1);
		expectPublishedFixture(setup, legacyKusto);
	});

	it.each([undefined, 'previous-account'])('recovers both caches after preference loss (%s) before publication', async previousAccount => {
		const setup = fixture(true);
		const authStarted = deferred();
		const authHeld = deferred();
		const lifecycleStarted = deferred();
		const lifecycleHeld = deferred();
		const preparing = setup.prepare(setup.request);
		try {
			await Promise.race([preparing, setup.initialCachesReady.promise]);
			expect(setup.databases.size).toBe(1);
			expect(setup.schemas.size).toBe(1);
			expect(setup.writeFile).not.toHaveBeenCalled();
			if (previousAccount) setup.preferences.set(setup.connection.id, previousAccount);
			else setup.preferences.delete(setup.connection.id);
			const settleAuth = setup.auth.waitForWriteSettlement.getMockImplementation()!;
			const settleLifecycle = setup.connectionManager.waitForSettlement.getMockImplementation()!;
			setup.auth.waitForWriteSettlement.mockImplementationOnce(async () => {
				authStarted.resolve(); await authHeld.promise; await settleAuth();
			});
			setup.connectionManager.waitForSettlement.mockImplementationOnce(async () => {
				lifecycleStarted.resolve(); await lifecycleHeld.promise; await settleLifecycle();
			});
			setup.assertionHeld.resolve();
			await Promise.race([preparing, authStarted.promise]);
			expect(setup.cache.setDatabases).toHaveBeenCalledTimes(1);
			expect(setup.writeSchema).toHaveBeenCalledTimes(1);
			expect(setup.writeFile).not.toHaveBeenCalled();
			authHeld.resolve();
			await Promise.race([preparing, lifecycleStarted.promise]);
			expect(setup.cache.setDatabases).toHaveBeenCalledTimes(1);
			expect(setup.writeSchema).toHaveBeenCalledTimes(1);
			expect(setup.writeFile).not.toHaveBeenCalled();
		} finally {
			setup.assertionHeld.resolve(); authHeld.resolve(); lifecycleHeld.resolve();
		}
		await expect(preparing).resolves.toEqual({ outputPath: join(root, 'output.kqlx'), connectionId: setup.connection.id });
		expect(setup.auth.setTokenOverride).toHaveBeenCalledTimes(2);
		expect(setup.clearCaches).toHaveBeenCalledTimes(2);
		expect(setup.cache.setDatabases).toHaveBeenCalledTimes(2);
		expect(setup.writeSchema).toHaveBeenCalledTimes(2);
		expect(setup.preferences.get(setup.connection.id)).toBe(setup.account.id);
		expectPublishedFixture(setup, true);
	});

	it.each([
		['database', '"cachedDatabases":[]'],
		['schema', '"hasCachedSchema":false'],
		['duplicate owner', '"matchingOwnerIds":["fixture-connection","duplicate"]'],
		['incarnation', '"connectionIncarnationMatches":false'],
		['policy revision', '"leaveNoTraceRevision":1'],
		['protected cluster', '"protectedResult":true'],
		['late preference loss', '"partitionMatches":false'],
	])('rejects %s drift without read-miss repairs or publication', async (drift, detail) => {
		const setup = fixture(true);
		const preparing = setup.prepare(setup.request);
		try {
			await Promise.race([preparing, setup.initialCachesReady.promise]);
			switch (drift) {
				case 'database': setup.databases.clear(); break;
				case 'schema': setup.schemas.clear(); break;
				case 'duplicate owner': setup.connections.set('duplicate', { ...setup.connection, id: 'duplicate' }); break;
				case 'incarnation': setup.connectionManager.getConnectionIncarnation.mockReturnValue(2); break;
				case 'policy revision': setup.snapshot.revocationGenerations[setup.connection.clusterUrl] = 1; break;
				case 'protected cluster': setup.snapshot.clusterKeys.push(setup.connection.clusterUrl); break;
				case 'late preference loss': {
					const readSchema = setup.readSchema.getMockImplementation()!;
					setup.readSchema.mockImplementationOnce(async (...args) => {
						setup.preferences.delete(setup.connection.id);
						await setup.auth.setTokenOverride();
						await setup.auth.waitForWriteSettlement();
						await setup.connectionManager.waitForSettlement();
						return readSchema(...args);
					});
					break;
				}
			}
		} finally {
			setup.assertionHeld.resolve();
		}
		await expect(preparing).rejects.toMatchObject({ message: expect.stringContaining(detail) });
		expect(setup.auth.setTokenOverride).toHaveBeenCalledTimes(drift === 'late preference loss' ? 2 : 1);
		expect(setup.cache.setDatabases).toHaveBeenCalledTimes(1);
		expect(setup.writeSchema).toHaveBeenCalledTimes(1);
		expect(setup.writeFile).not.toHaveBeenCalled();
		expect(setup.files.size).toBe(0);
	});

	it.each([
		['initial', 'database', false], ['initial', 'schema', false],
		['recovery', 'database', false], ['recovery', 'schema', false],
		['recovery', 'database', true], ['recovery', 'schema', true],
	] as const)('rejects a %s %s cache write (throws=%s) without publishing', async (phase, failedWrite, throws) => {
		const setup = fixture(phase === 'recovery');
		const failure = new Error(`${failedWrite} storage failure`);
		const writer = failedWrite === 'database' ? setup.cache.setDatabases : setup.writeSchema;
		const rejectWrite = () => throws ? writer.mockRejectedValueOnce(failure) : writer.mockResolvedValueOnce(false);
		if (phase === 'initial') rejectWrite();
		const preparing = setup.prepare(setup.request);
		if (phase === 'recovery') {
			try {
				await Promise.race([preparing, setup.initialCachesReady.promise]);
				setup.preferences.delete(setup.connection.id);
				rejectWrite();
			} finally {
				setup.assertionHeld.resolve();
			}
		}
		if (throws) {
			await expect(preparing).rejects.toBe(failure);
		} else {
			await expect(preparing).rejects.toMatchObject({
				message: `Persisted-result Kusto fixture ${failedWrite} cache write was superseded.`,
			});
		}
		if (failedWrite === 'database') expect(setup.writeSchema).toHaveBeenCalledTimes(phase === 'initial' ? 0 : 1);
		expect(setup.writeFile).not.toHaveBeenCalled();
		expect(setup.files.size).toBe(0);
	});
});

describe('Copilot clarification offline fixture', () => {
	function fixture(holdSideEffects = false, failedWrite?: 'database' | 'schema') {
		const account = { id: 'kusto-copilot-clarification-e2e-account', label: 'Kusto Copilot clarification E2E account' };
		const clusterUrl = 'https://copilot-clarification-e2e.invalid';
		type Connection = { id: string; name: string; clusterUrl: string; database: string; authorityId: string };
		const userConnection: Connection = {
			id: 'user-connection', name: 'User Connection', clusterUrl, database: 'UserDb', authorityId: 'organizations',
		};
		const connections = new Map<string, Connection>([[userConnection.id, userConnection]]);
		const preferences = new Map([[userConnection.id, 'user-account']]);
		const tokens = new Map([['organizations/user-account', 'user-token']]);
		const databases = new Map([[userConnection.id, { accountPartition: 'organizations/user-account', databases: ['UserDb'] }]]);
		const schemas = new Map<string, CachedSchemaEntry>([['user-schema', {
			connectionId: userConnection.id, accountPartition: 'organizations/user-account',
			schema: { tables: ['UserTable'], columnTypesByTable: {} }, version: SCHEMA_CACHE_VERSION, timestamp: 1,
		}]]);
		const originalUserSchema = schemas.get('user-schema');
		const authHeld = deferred();
		const lifecycleHeld = deferred();
		const authStarted = deferred();
		const lifecycleStarted = deferred();
		if (!holdSideEffects) { authHeld.resolve(); lifecycleHeld.resolve(); }
		let authTail = Promise.resolve();
		let lifecycleTail = Promise.resolve();
		const clearCaches = (connectionId: string) => {
			databases.delete(connectionId);
			for (const [cacheKey, entry] of schemas) if (entry.connectionId === connectionId) schemas.delete(cacheKey);
		};
		const queueAuthChange = (connectionId: string) => {
			authTail = authTail.then(async () => {
				await authHeld.promise;
				lifecycleTail = lifecycleTail.then(async () => { await lifecycleHeld.promise; clearCaches(connectionId); });
			});
		};
		const auth = {
			waitForProviderAccountRefresh: vi.fn().mockResolvedValue(undefined),
			waitForWriteSettlement: vi.fn(async () => { authStarted.resolve(); await authTail; }),
			getAccountPartition: (authorityId: string, accountId: string) => `${authorityId}/${accountId}`,
			setExplicitAccount: async (connectionId: string, selected: typeof account) => {
				preferences.set(connectionId, selected.id); queueAuthChange(connectionId);
			},
			setTokenOverride: async (authorityId: string, accountId: string, token: string, connectionIds: string[]) => {
				tokens.set(`${authorityId}/${accountId}`, token);
				for (const connectionId of connectionIds) queueAuthChange(connectionId);
			},
			clearTokenOverride: vi.fn(async (authorityId: string, accountId: string, connectionIds: string[]) => {
				tokens.delete(`${authorityId}/${accountId}`);
				for (const connectionId of connectionIds) queueAuthChange(connectionId);
			}),
			removeConnection: async (connectionId: string) => { preferences.delete(connectionId); queueAuthChange(connectionId); },
		};
		let nextConnectionId = 0;
		const connectionManager = {
			getConnections: () => [...connections.values()],
			addConnection: async (configuration: Omit<Connection, 'id' | 'authorityId'>) => {
				const connection = { ...configuration, id: `fixture-${++nextConnectionId}`, authorityId: 'organizations' };
				connections.set(connection.id, connection);
				return connection;
			},
			removeConnection: async (connectionId: string) => { connections.delete(connectionId); },
			waitForSettlement: vi.fn(async () => { lifecycleStarted.resolve(); await lifecycleTail; }),
		};
		const cache = {
			setDatabases: vi.fn(async (connectionId: string, accountPartition: string, values: string[]) => {
				if (failedWrite === 'database') return false;
				databases.set(connectionId, { accountPartition, databases: values });
				return true;
			}),
			clearConnection: vi.fn(async (connectionId: string) => { databases.delete(connectionId); }),
		};
		const writeSchema = vi.fn(async (_storage: string, cacheKey: string, entry: CachedSchemaEntry) => {
			if (failedWrite === 'schema') return false;
			schemas.set(cacheKey, entry);
			return true;
		});
		const deleteSchemas = vi.fn(async (_storage: string, connectionIds: ReadonlySet<string>) => {
			for (const [cacheKey, entry] of schemas) if (connectionIds.has(entry.connectionId!)) schemas.delete(cacheKey);
		});
		const post = vi.fn(async (message: { type: string; connection: Connection; database: string }) => {
			const partition = auth.getAccountPartition(message.connection.authorityId, account.id);
			return {
				database: databases.get(message.connection.id),
				schema: schemas.get(schemaCacheKey(clusterUrl, message.database, message.connection.id, partition)),
			};
		});
		const callbacks = ['seedCopilotClarificationConnection', 'removeCopilotClarificationConnection']
			.map(command => extensionCommandCallback(`kustoWorkbench.test.${command}`));
		const [seed, remove] = runInNewContext(ts.transpileModule(`[${callbacks.join(',')}];`, {
			compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
		}).outputText, {
			copilotClarificationConnectionName: 'Kusto Copilot Clarification E2E',
			copilotClarificationCluster: clusterUrl, copilotClarificationAccount: account, copilotClarificationAuth: auth,
			connectionManager, testConnectionCache: cache, context: { globalStorageUri: 'fixture-storage' },
			SCHEMA_CACHE_VERSION, schemaCacheKey, writeCachedSchemaToDisk: writeSchema,
			deleteCachedSchemasForConnections: deleteSchemas, toolOrchestrator: { postToAllWebviews: post },
		}) as [() => Promise<Connection>, () => Promise<void>];
		const assertUserUntouched = () => {
			expect(connections.get(userConnection.id)).toEqual(userConnection);
			expect(preferences.get(userConnection.id)).toBe('user-account');
			expect(tokens.get('organizations/user-account')).toBe('user-token');
			expect(databases.get(userConnection.id)?.databases).toEqual(['UserDb']);
			expect(schemas.get('user-schema')).toBe(originalUserSchema);
		};
		return {
			seed, remove, post, auth, cache, writeSchema, deleteSchemas, connectionManager,
			connections, preferences, tokens, databases, schemas, assertUserUntouched,
			authHeld, lifecycleHeld, authStarted, lifecycleStarted,
		};
	}

	it('publishes only after delayed auth clears settle and both offline caches exist', async () => {
		const setup = fixture(true);
		const seeding = setup.seed();
		try {
			await Promise.race([seeding, setup.authStarted.promise]);
			expect(setup.post).not.toHaveBeenCalled();
			expect(setup.cache.setDatabases).not.toHaveBeenCalled();
			setup.authHeld.resolve();
			await Promise.race([seeding, setup.lifecycleStarted.promise]);
			expect(setup.post).not.toHaveBeenCalled();
			expect(setup.writeSchema).not.toHaveBeenCalled();
		} finally {
			setup.authHeld.resolve(); setup.lifecycleHeld.resolve();
			await seeding;
		}
		const connection = await seeding;
		expect(setup.post).toHaveBeenCalledExactlyOnceWith({ type: 'e2eCopilotClarificationConnection', connection, database: 'ChecklistDb' });
		const published = await setup.post.mock.results[0].value;
		expect(published.database).toEqual({ accountPartition: 'organizations/kusto-copilot-clarification-e2e-account', databases: ['ChecklistDb'] });
		expect(published.schema).toMatchObject({
			connectionId: connection.id, database: 'ChecklistDb', clusterUrl: connection.clusterUrl,
			accountPartition: published.database!.accountPartition, version: SCHEMA_CACHE_VERSION,
			schema: { tables: ['events'], columnTypesByTable: { events: { Timestamp: 'datetime' } } },
		});
		const raw = published.schema!.schema.rawSchemaJson as { Databases: { ChecklistDb: { Tables: { events: { OrderedColumns: unknown } } } } };
		expect(Array.isArray(raw.Databases.ChecklistDb.Tables.events.OrderedColumns)).toBe(true);
		const parsedColumns: Record<string, Record<string, string>> = {};
		extractSchemaFromJson(raw, parsedColumns);
		expect(parsedColumns).toEqual({ events: { Timestamp: 'System.DateTime' } });
		setup.assertUserUntouched();
	});

	it.each(['database', 'schema'] as const)('rejects a superseded %s write without publishing', async failedWrite => {
		const setup = fixture(false, failedWrite);
		await expect(setup.seed()).rejects.toThrow(new RegExp(`${failedWrite} cache write`, 'i'));
		expect(setup.post).not.toHaveBeenCalled();
		if (failedWrite === 'database') expect(setup.writeSchema).not.toHaveBeenCalled();
		await setup.remove();
		expect([...setup.connections.keys()]).toEqual(['user-connection']);
		expect([...setup.databases.keys()]).toEqual(['user-connection']);
		expect([...setup.schemas.keys()]).toEqual(['user-schema']);
		setup.assertUserUntouched();
	});

	it('reseeds and removes only fixture state with awaited cleanup', async () => {
		const setup = fixture();
		const first = await setup.seed();
		const second = await setup.seed();
		expect(second.id).not.toBe(first.id);
		expect(setup.preferences.has(first.id)).toBe(false);
		expect(setup.databases.has(first.id)).toBe(false);
		expect([...setup.schemas.values()].some(entry => entry.connectionId === first.id)).toBe(false);
		setup.auth.waitForWriteSettlement.mockClear();
		setup.connectionManager.waitForSettlement.mockClear();
		await setup.remove();
		expect(setup.auth.waitForWriteSettlement).toHaveBeenCalled();
		expect(setup.connectionManager.waitForSettlement).toHaveBeenCalled();
		expect(setup.cache.clearConnection).toHaveBeenCalledWith(second.id);
		expect(setup.deleteSchemas.mock.calls.at(-1)?.[0]).toBe('fixture-storage');
		expect([...setup.deleteSchemas.mock.calls.at(-1)![1]]).toEqual([second.id]);
		expect([...setup.connections.keys()]).toEqual(['user-connection']);
		expect([...setup.preferences.keys()]).toEqual(['user-connection']);
		expect([...setup.tokens.keys()]).toEqual(['organizations/user-account']);
		expect([...setup.databases.keys()]).toEqual(['user-connection']);
		expect([...setup.schemas.keys()]).toEqual(['user-schema']);
		await setup.remove();
		setup.assertUserUntouched();
	});
});

describe('first-launch integration inventory', () => {
	it('activates for every supported cold-open language and extension URI', () => {
		for (const event of ['onLanguage:kql', 'onLanguage:kqlx', 'onLanguage:sqlx', 'onLanguage:sql', 'onLanguage:markdown', 'onUri']) {
			expect(packageJson.activationEvents).toContain(event);
		}
	});

	it('activates identity fixture setup before opening an editor', () => {
		for (const command of [
			'cleanupKustoIdentityChecklist',
			'prepareKustoIdentitySelectionBaseline',
			'seedKustoIdentityChecklist',
		]) {
			expect(packageJson.activationEvents).toContain(`onCommand:kustoWorkbench.test.${command}`);
		}
	});

	it('settles identity cleanup and structure before assigning fixture principals', () => {
		const cleanup = extensionSource.slice(
			extensionSource.indexOf('const cleanupIdentityChecklistState'),
			extensionSource.indexOf('context.subscriptions.push(', extensionSource.indexOf('const cleanupIdentityChecklistState')),
		);
		const removeConnection = cleanup.indexOf('await connectionManager.removeConnection(connection.id)');
		const removePreference = cleanup.indexOf('await testAuthPreferences.removeConnection(connection.id)');
		expect(removeConnection).toBeGreaterThanOrEqual(0);
		expect(removePreference).toBeGreaterThanOrEqual(0);
		expect(removeConnection).toBeLessThan(removePreference);

		const seed = extensionSource.slice(
			extensionSource.indexOf("registerCommand('kustoWorkbench.test.seedKustoIdentityChecklist'"),
			extensionSource.indexOf("registerCommand('kustoWorkbench.test.assertClipboardContains'"),
		);
		const addConnection = seed.indexOf('await connectionManager.addConnection(');
		const addLeaveNoTrace = seed.indexOf('await connectionManager.addLeaveNoTrace(');
		const setExplicitAccount = seed.indexOf('testAuthPreferences.setExplicitAccounts(');
		const persistFavorites = seed.indexOf('await context.globalState.update(STORAGE_KEYS.favorites, favorites)');
		const setTokenOverride = seed.indexOf('await testAuthPreferences.setTokenOverride(');
		const setDatabases = seed.indexOf('await testConnectionCache.setDatabases(');
		const setClipboardSentinel = seed.indexOf('await vscode.env.clipboard.writeText(identityClipboardSentinel)');
		for (const marker of [addConnection, addLeaveNoTrace, setExplicitAccount, persistFavorites, setTokenOverride, setDatabases, setClipboardSentinel]) {
			expect(marker).toBeGreaterThanOrEqual(0);
		}
		expect(addConnection).toBeLessThan(addLeaveNoTrace);
		expect(addLeaveNoTrace).toBeLessThan(setExplicitAccount);
		expect(seed).toContain('added.map(connection => connection.id)');
		expect(setExplicitAccount).toBeLessThan(persistFavorites);
		expect(persistFavorites).toBeLessThan(setTokenOverride);
		expect(setTokenOverride).toBeLessThan(setDatabases);
		expect(seed).toContain('if (!schemaWritten)');
		expect(extensionSource).toContain('Clipboard assertion requires non-empty text.');
		expect(extensionSource).toContain('selection.lastConnectionIdPresent');
		expect(extensionSource).toContain('selection.lastDatabasePresent');
		expect(extensionSource).toContain('identityChecklistPreviousSelection = captureIdentitySelection();');
		expect(extensionSource).toContain("registerCommand('kustoWorkbench.test.assertAndCleanupKustoIdentitySelectionBaseline'");
		expect(extensionSource).toContain('if (previousSelection) await restoreIdentitySelection(previousSelection)');
		const baseline = extensionSource.slice(
			extensionSource.indexOf("registerCommand('kustoWorkbench.test.prepareKustoIdentitySelectionBaseline'"),
			extensionSource.indexOf("registerCommand('kustoWorkbench.test.assertAndCleanupKustoIdentitySelectionBaseline'"),
		);
		expect(baseline.indexOf('await supplementalStartupCleanup'))
			.toBeLessThan(baseline.indexOf('await cleanupIdentityChecklistState()'));
		expect(baseline.indexOf('await cleanupIdentityChecklistState()'))
			.toBeLessThan(baseline.indexOf('identitySelectionBaselinePreviousSelection = captureIdentitySelection()'));
		expect(extensionSource).toContain("rawSchemaJson: {");
		expect(extensionSource).toContain('setExplicitAccounts(');
		expect(testHelpersSource).toContain('admitKustoPublicationHostMessage(event.data)');
		expect(testHelpersSource).toContain("message.payload.policyRequestId === policyRequestId");
		expect(testHelpersSource).toContain("message.type !== 'kustoPublicationCommit'");
		expect(testHelpersSource).toContain("const shortConnection = { ...regional, clusterUrl: E2E_KUSTO_IDENTITY_CHECKLIST.regionalKey }");
		expect(testHelpersSource).toContain('shortSectionClusterUrl: shortConfigured.clusterUrl');
	});

	it('keeps the text-diagnostics seed selected after deferred supplemental startup cleanup', async () => {
		const cleanupWriteStarted = deferred();
		const releaseCleanup = deferred();
		const startupAwaited = deferred();
		const storageKeys = {
			lastConnectionId: 'kusto.lastConnectionId',
			lastDatabase: 'kusto.lastDatabase',
			cachedDatabases: 'kusto.cachedDatabases',
		};
		const previousSelectionKey = 'kusto.test.supplementalPreviousSelection';
		const state = new Map<string, unknown>([
			[storageKeys.lastConnectionId, 'user-connection'],
			[storageKeys.lastDatabase, 'UserDb'],
			[storageKeys.cachedDatabases, {}],
			['kusto.fileConnectionCache', {}],
		]);
		type FixtureConnection = { id: string; name: string; clusterUrl: string; database: string; authorityId: string };
		type SeedResult = { connectionId: string; clusterUrl: string; database: string };
		type SeedSchema = {
			connectionId: string;
			database: string;
			accountPartition: string;
			schema: { tables: string[]; columnTypesByTable: Record<string, Record<string, string>> };
		};
		const userConnection: FixtureConnection = {
			id: 'user-connection', name: 'User Connection', clusterUrl: 'https://user.kusto.windows.net',
			database: 'UserDb', authorityId: 'organizations',
		};
		const connections = new Map<string, FixtureConnection>([
			[userConnection.id, userConnection],
			['supplemental-connection', {
				id: 'supplemental-connection', name: 'E2E Supplemental Schema Interrupted',
				clusterUrl: 'https://supplemental-remote.westus.kusto.windows.net',
				database: 'TelemetryDb', authorityId: 'organizations',
			}],
		]);
		const preferences = new Map<string, { id: string; label: string }>();
		const databases = new Map<string, { accountPartition: string; databases: string[] }>();
		const schemas = new Map<string, SeedSchema>();
		const commands = new Map<string, () => Promise<SeedResult>>();
		const getConnections = vi.fn(() => [...connections.values()]);
		const warn = vi.fn();
		const schemaCacheKey = (clusterUrl: string, database: string, connectionId: string, accountPartition: string) =>
			JSON.stringify([clusterUrl, database, connectionId, accountPartition]);
		const seedCommandId = 'kustoWorkbench.test.seedKustoTextDiagnosticsState';
		const declarationNames = [
			'textDiagnosticsTestName', 'textDiagnosticsTestCluster', 'textDiagnosticsTestDatabase',
			'supplementalTestPrefix', 'supplementalCurrentCluster', 'supplementalRemoteCluster',
			'supplementalDatabase', 'supplementalPreviousSelectionKey', 'supplementalClusterKeys', 'testAuthAccount',
			'isSupplementalConnection', 'cleanupSupplementalSchemaDiagnosticsState',
			'hasSupplementalStartupResidue', 'supplementalStartupCleanup',
		];
		const declarations = new Map<string, string>();
		let seedRegistration: string | undefined;
		const sourceFile = ts.createSourceFile('extension.ts', extensionSource, ts.ScriptTarget.Latest, true);
		const visit = (node: ts.Node): void => {
			if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && declarationNames.includes(node.name.text)) {
				declarations.set(node.name.text, `const ${node.getText(sourceFile)};`);
			}
			if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
				&& node.expression.name.text === 'registerCommand'
				&& node.arguments[0] && ts.isStringLiteral(node.arguments[0])
				&& node.arguments[0].text === seedCommandId) {
				seedRegistration = node.getText(sourceFile);
			}
			ts.forEachChild(node, visit);
		};
		visit(sourceFile);
		for (const name of declarationNames) expect(declarations.has(name), name).toBe(true);
		expect(seedRegistration).toBeDefined();
		const fixtureSource = ts.transpileModule(`
			${declarationNames.map(name => declarations.get(name)).join('\n')}
			((supplementalStartupCleanup) => {
				${seedRegistration};
			})(observeStartupCleanup(supplementalStartupCleanup));
			supplementalStartupCleanup;
		`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
		const startupCleanup = runInNewContext(fixtureSource, {
			STORAGE_KEYS: storageKeys,
			SCHEMA_CACHE_VERSION: 1,
			context: {
				globalStorageUri: 'fixture-storage',
				globalState: {
					keys: () => [...state.keys()],
					get: (key: string) => state.get(key),
					update: async (key: string, value: unknown) => {
						if (value === undefined) state.delete(key);
						else state.set(key, value);
						if (key === previousSelectionKey && value !== undefined) {
							cleanupWriteStarted.resolve();
							await releaseCleanup.promise;
						}
					},
				},
			},
			connectionManager: {
				getConnections,
				removeConnection: async (connectionId: string) => { connections.delete(connectionId); },
				addConnection: async (configuration: Omit<FixtureConnection, 'id' | 'authorityId'>) => {
					const connection = { ...configuration, id: 'seed-connection', authorityId: 'organizations' };
					connections.set(connection.id, connection);
					return connection;
				},
			},
			testAuthPreferences: {
				removeConnection: async (connectionId: string) => { preferences.delete(connectionId); },
				setExplicitAccount: async (connectionId: string, account: { id: string; label: string }) => {
					preferences.set(connectionId, account);
				},
				getAccountPartition: (authorityId: string, accountId: string) => `${authorityId}/${accountId}`,
			},
			testConnectionCache: {
				clearConnection: async (connectionId: string) => { databases.delete(connectionId); },
				setDatabases: async (connectionId: string, accountPartition: string, values: string[]) => {
					databases.set(connectionId, { accountPartition, databases: values });
				},
			},
			kustoClusterKey: (clusterUrl: string) => new URL(clusterUrl).hostname,
			schemaCacheKey,
			getSchemaCacheFileUri: (_storage: string, cacheKey: string) => cacheKey,
			writeCachedSchemaToDisk: async (_storage: string, cacheKey: string, schema: SeedSchema) => {
				schemas.set(cacheKey, schema);
				return true;
			},
			vscode: {
				commands: {
					registerCommand: (command: string, handler: () => Promise<SeedResult>) => { commands.set(command, handler); },
				},
				workspace: { fs: { delete: async (cacheKey: string) => { schemas.delete(cacheKey); } } },
			},
			getWorkbenchLogger: () => ({ warn }),
			observeStartupCleanup: (pending: Promise<unknown>): PromiseLike<unknown> => ({
				then(onfulfilled, onrejected) {
					startupAwaited.resolve();
					return pending.then(onfulfilled, onrejected);
				},
			}),
		}) as Promise<unknown>;
		await cleanupWriteStarted.promise;
		expect(state.get(previousSelectionKey)).toMatchObject({
			lastConnectionId: 'user-connection', lastConnectionIdPresent: true,
			lastDatabase: 'UserDb', lastDatabasePresent: true,
		});
		const readsBeforeSeed = getConnections.mock.calls.length;
		const seedPromise = commands.get(seedCommandId)!();
		let readsWhileCleanupHeld = 0;
		try {
			await Promise.race([seedPromise, startupAwaited.promise]);
			readsWhileCleanupHeld = getConnections.mock.calls.length - readsBeforeSeed;
		} finally {
			releaseCleanup.resolve();
			await Promise.all([startupCleanup, seedPromise]);
		}
		expect(warn).not.toHaveBeenCalled();
		expect(await startupCleanup).toEqual({ verified: true, restoredFilePinCount: 0, restoredCachedDatabaseCount: 0 });
		const seeded = await seedPromise;
		expect(seeded).toEqual({
			connectionId: 'seed-connection', clusterUrl: 'https://kw-diagnostics-seed.kusto.windows.net', database: 'SeedDb',
		});
		const accountPartition = 'organizations/kusto-workbench-test-account';
		const seedCacheKey = schemaCacheKey(seeded.clusterUrl, seeded.database, seeded.connectionId, accountPartition);
		const cachedDatabases = databases.get(seeded.connectionId);
		expect({
			lastConnectionId: state.get(storageKeys.lastConnectionId),
			lastDatabase: state.get(storageKeys.lastDatabase),
			authPartition: preferences.get(seeded.connectionId)?.id === 'kusto-workbench-test-account'
				&& cachedDatabases?.accountPartition === accountPartition,
			databases: cachedDatabases?.databases,
			schemaExists: schemas.has(seedCacheKey),
		}).toEqual({
			lastConnectionId: 'seed-connection', lastDatabase: 'SeedDb',
			authPartition: true, databases: ['SeedDb'], schemaExists: true,
		});
		expect(readsWhileCleanupHeld).toBe(0);
		expect(schemas.get(seedCacheKey)).toMatchObject({
			connectionId: seeded.connectionId, database: 'SeedDb', accountPartition,
			schema: { tables: ['KnownOnly'], columnTypesByTable: { KnownOnly: { Timestamp: 'datetime', Value: 'long' } } },
		});
		expect(connections.get(userConnection.id)).toEqual(userConnection);
		expect(connections.has('supplemental-connection')).toBe(false);
		expect(state.has(previousSelectionKey)).toBe(false);
	});

	it.each([
		['isolated reset', true, 'populated'],
		['isolated fresh session', true, 'missing'],
		['ordinary existing empty session', false, 'empty'],
		['ordinary missing session', false, 'missing'],
	] as const)('opens %s with canonical creation and locked writes before reveal', async (_scenario, isolated, initial) => {
		const callbackSource = extensionCommandCallback('kusto.openQueryEditor');
		const savedSession = stringifyKqlxFile({
			kind: 'kqlx', version: 1, state: { sections: [{
				type: 'query', query: 'print Old=1', clusterUrl: 'https://old.kusto.windows.net',
				database: 'OldDb', resultJson: '{"rows":[[1]]}',
			}] },
		});
		let bytes = initial === 'missing' ? undefined : new TextEncoder().encode(initial === 'empty' ? '' : savedSession);
		const originalBytes = bytes?.slice();
		const sessionUri = join('fixture-storage', 'session.kqlx');
		const shouldWrite = isolated || initial === 'missing';
		let releaseWrite!: () => void;
		let markWriteStarted!: () => void;
		const writeHeld = new Promise<void>(resolve => { releaseWrite = resolve; });
		const writeStarted = new Promise<void>(resolve => { markWriteStarted = resolve; });
		const closeHeld = deferred();
		const closeStarted = deferred();
		const initializationHeld = deferred();
		const initializationStarted = deferred();
		const events: string[] = [];
		let locked = false;
		const createFresh = vi.fn(createKqlxOrMdxFileWithDefaultSection);
		const close = vi.fn(async (uri: string) => {
			expect(uri).toBe(sessionUri);
			expect(locked).toBe(false);
			events.push('close');
			closeStarted.resolve();
			await closeHeld.promise;
			events.push('closed');
		});
		const writeFile = vi.fn(async (uri: string, content: Uint8Array) => {
			expect(uri).toBe(sessionUri);
			expect(locked).toBe(true);
			markWriteStarted();
			await writeHeld;
			bytes = content.slice();
			events.push('write');
		});
		const reveal = vi.fn(async (uri: string) => {
			expect(uri).toBe(sessionUri);
			expect(locked).toBe(false);
			events.push('reveal');
		});
		const waitForInitialization = vi.fn(async (uri: string, timeoutMs: number) => {
			expect(uri).toBe(sessionUri);
			expect(timeoutMs).toBe(30_000);
			expect(locked).toBe(false);
			events.push('wait');
			initializationStarted.resolve();
			await initializationHeld.promise;
			events.push('ready');
			return true;
		});
		const open = runInNewContext(ts.transpileModule(`(${callbackSource});`, {
			compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
		}).outputText, {
			TextEncoder, stringifyKqlxFile, testIsolateKustoConnections: isolated,
			createKqlxOrMdxFileWithDefaultSection: createFresh,
			afterFirstLaunch: (handler: () => Promise<void>) => handler,
			context: { globalStorageUri: 'fixture-storage' },
			vscode: { Uri: { joinPath: join }, workspace: { fs: {
				createDirectory: vi.fn().mockResolvedValue(undefined), writeFile,
				stat: async (uri: string) => {
					expect(uri).toBe(sessionUri);
					expect(locked).toBe(true);
					if (bytes === undefined) throw Object.assign(new Error('missing'), { code: 'FileNotFound' });
					return { size: bytes.length };
				},
			} } },
			withKqlxDocumentWriteLock: async (uri: string, writer: () => Promise<void>) => {
				expect(uri).toBe(sessionUri);
				locked = true;
				events.push('lock');
				try { await writer(); } finally { locked = false; events.push('unlock'); }
			},
			revealOrOpenQueryEditorSession: reveal,
			closeQueryEditorSessionTabs: close,
			KqlxEditorProvider: { waitForOpenEditorInitialized: waitForInitialization },
		}) as () => Promise<void>;
		const settled = vi.fn();
		const opening = open().then(settled);
		try {
			if (isolated) {
				await Promise.race([closeStarted.promise, opening]);
				expect(events).toEqual(['close']);
				expect(writeFile).not.toHaveBeenCalled();
				expect(reveal).not.toHaveBeenCalled();
				expect(settled).not.toHaveBeenCalled();
				closeHeld.resolve();
			}
			await Promise.race([writeStarted, opening]);
			expect(bytes).toEqual(originalBytes);
			expect(writeFile).toHaveBeenCalledTimes(shouldWrite ? 1 : 0);
			expect(reveal).toHaveBeenCalledTimes(shouldWrite ? 0 : 1);
			releaseWrite();
			await Promise.race([initializationStarted.promise, opening]);
			expect(waitForInitialization).toHaveBeenCalledTimes(isolated ? 1 : 0);
			if (isolated) expect(settled).not.toHaveBeenCalled();
		} finally {
			closeHeld.resolve();
			releaseWrite();
			initializationHeld.resolve();
			await opening;
		}
		expect(close).toHaveBeenCalledTimes(isolated ? 1 : 0);
		expect(createFresh.mock.calls).toEqual(shouldWrite ? [['kqlx']] : []);
		expect(events).toEqual([
			...(isolated ? ['close', 'closed'] : []),
			'lock', ...(shouldWrite ? ['write'] : []), 'unlock', 'reveal', ...(isolated ? ['wait', 'ready'] : []),
		]);
		if (shouldWrite) {
			expect(bytes).toEqual(new TextEncoder().encode(stringifyKqlxFile(createKqlxOrMdxFileWithDefaultSection('kqlx'))));
			expect(parseKqlxText(new TextDecoder().decode(bytes))).toEqual({
				ok: true, file: { kind: 'kqlx', version: 1, state: { sections: [{ type: 'query', expanded: true, query: '' }] } },
			});
		} else {
			expect(bytes).toEqual(originalBytes);
		}
	});

	it('declares file-opening choices as profile-only application settings', () => {
		for (const key of ['openKqlFiles', 'openCslFiles', 'openMdFiles', 'openSqlFiles']) {
			expect(packageJson.contributes.configuration.properties[`kustoWorkbench.${key}`]?.scope, key).toBe('application');
		}
	});

	it('declares editing defaults as application settings for cross-window propagation', () => {
		for (const key of ['autoTriggerAutocompleteEnabled', 'copilotInlineCompletionsEnabled', 'caretDocsEnabled']) {
			expect(packageJson.contributes.configuration.properties[`kustoWorkbench.editing.${key}`]?.scope, key).toBe('application');
		}
	});

	it('gates every contributed production command except the configure command', () => {
		const contributed = packageJson.contributes.commands.map(command => command.command);
		const expected = [...extensionGatedCommands, 'kusto.openRemoteFile', 'kusto.configureFirstLaunchSetup'].sort();
		expect(contributed.sort()).toEqual(expected);
		for (const command of extensionGatedCommands) {
			const registration = extensionSource.slice(extensionSource.indexOf(`registerCommand('${command}'`));
			expect(registration.slice(0, 180), command).toContain('afterFirstLaunch(');
		}
		expect(remoteSource).toMatch(/registerCommand\('kusto\.openRemoteFile', async \(\) => \{\s+await beforeOpen\(\);/);
		expect(extensionSource).toContain("registerCommand('kusto.configureFirstLaunchSetup', () => firstLaunchCoordinator.openConfiguration())");
	});

	it('validates remote URI input before consuming first use', () => {
		const uriHandler = remoteSource.slice(remoteSource.indexOf('async handleUri(uri: vscode.Uri)'));
		expect(uriHandler.indexOf('const validationError = validateRemoteUrl(fileUrl);')).toBeGreaterThan(-1);
		expect(uriHandler.indexOf('const validationError = validateRemoteUrl(fileUrl);'))
			.toBeLessThan(uriHandler.indexOf('await beforeOpen();'));
	});

	it('does not persist application editing toggles into notebook documents', () => {
		for (const functionName of [
			'toggleAutoTriggerAutocompleteEnabled',
			'toggleCopilotInlineCompletionsEnabled',
			'toggleCaretDocsEnabled',
		]) {
			const start = queryToolbarSource.indexOf(`export function ${functionName}`);
			const body = queryToolbarSource.slice(start, queryToolbarSource.indexOf('\n}', start) + 2);
			expect(body, functionName).not.toContain('schedulePersist()');
		}
	});

	it('awaits first-launch bootstrap and rethrows failure before other infrastructure starts', () => {
		const bootstrap = extensionSource.slice(extensionSource.indexOf('const firstLaunchCoordinator = new FirstLaunchCoordinator'));
		expect(bootstrap.indexOf('await firstLaunchCoordinator.initialize();')).toBeGreaterThan(-1);
		expect(bootstrap.indexOf('throw error;')).toBeGreaterThan(bootstrap.indexOf('await firstLaunchCoordinator.initialize();'));
		expect(bootstrap).toContain("process.env.KUSTO_WORKBENCH_E2E_BYPASS_FIRST_LAUNCH === '1'");
		expect(bootstrap.indexOf('const editorCursorStatusBar = new EditorCursorStatusBar();'))
			.toBeGreaterThan(bootstrap.indexOf('throw error;'));
	});

	it('drains accepted Kusto selection writes during extension deactivation', () => {
		expect(extensionSource).toMatch(/export async function deactivate\(\) \{\s+await ConnectionService\.waitForLastSelectionSettlement\(\);/);
	});

	it('registers the setup artifact in initial copy, watch copy, bundle, and both size tools', () => {
		const artifact = 'first-launch-setup.bundle.js';
		expect(esbuildSource.match(new RegExp(artifact.replaceAll('.', '\\.'), 'g'))?.length).toBeGreaterThanOrEqual(2);
		expect(esbuildSource.match(/first-launch-setup\.html/g)?.length).toBeGreaterThanOrEqual(4);
		expect(sizeReportSource).toContain(artifact);
		expect(sizeGateSource).toContain(artifact);
	});

	it('loads Markdown UMD globals before Monaco establishes AMD in the query editor', () => {
		const queryEditorTemplate = readFileSync(join(process.cwd(), 'src', 'webview', 'queryEditor.html'), 'utf8');
		expect(queryEditorTemplate.indexOf('<script src="{{markedUrl}}"></script>')).toBeGreaterThan(-1);
		expect(queryEditorTemplate.indexOf('<script src="{{purifyUrl}}"></script>'))
			.toBeGreaterThan(queryEditorTemplate.indexOf('<script src="{{markedUrl}}"></script>'));
		expect(queryEditorTemplate.indexOf('<script src="{{monacoLoaderUri}}"></script>'))
			.toBeGreaterThan(queryEditorTemplate.indexOf('<script src="{{purifyUrl}}"></script>'));
	});

	it('cleans production output and makes first-launch bundle failures fatal', () => {
		expect(packageJson.scripts.package).toContain("rmSync('dist'");
		const firstLaunchCatch = esbuildSource.slice(esbuildSource.indexOf("console.warn('[watch] failed to bundle first-launch setup" ) - 100);
		expect(firstLaunchCatch.slice(0, 180)).toContain('if (production)');
		expect(firstLaunchCatch.slice(0, 180)).toContain('throw e;');
		const assetCopyCatch = esbuildSource.slice(esbuildSource.indexOf("console.warn('[watch] failed to copy webview runtime assets") - 100);
		expect(assetCopyCatch.slice(0, 180)).toContain('if (production)');
		expect(assetCopyCatch.slice(0, 180)).toContain('throw e;');
		expect(esbuildSource).toContain("'webview/first-launch-setup.html'");
		expect(esbuildSource).toContain('Missing required production artifact');
		expect(packageJson.dependencies['proper-lockfile']).toBeTruthy();
	});
});