import { describe, expect, it, vi } from 'vitest';

import type { SqlFavorite } from '../../../src/host/connectionManagerFavorites';
import type { SqlConnection } from '../../../src/host/sqlConnectionManager';
import {
	HostSqlConnectionsProjectionApplicationHandler,
} from '../../../src/host/sqlConnectionsProjectionApplicationHandler';
import {
	sqlSchemaPrincipalFingerprintForPrincipal,
} from '../../../src/host/sqlEditorSchema';
import {
	sqlDatabaseTargetSignature,
	type SqlDatabaseCacheEntry,
} from '../../../src/host/sqlDatabaseCache';
import type { IncomingWebviewMessage } from '../../../src/host/queryEditorTypes';
import type { SqlOwnerSnapshot } from '../../../src/host/sql/sqlWorkbenchService';

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>(resolvePromise => { resolve = resolvePromise; });
	return { promise, resolve };
}

function sqlConnection(overrides: Partial<SqlConnection> = {}): SqlConnection {
	return {
		id: 'sql-1',
		name: 'SQL One',
		dialect: 'mssql',
		serverUrl: 'server.example',
		port: 1433,
		database: 'master',
		authType: 'sql-login',
		username: 'user-a',
		...overrides,
	};
}

function ownerSnapshot(
	connections: readonly SqlConnection[],
	overrides: Partial<SqlOwnerSnapshot> = {},
): SqlOwnerSnapshot {
	return {
		policy: {
			connectionIds: [],
			version: 7,
			globallyBlocked: false,
			revocationGenerations: {},
		},
		connections,
		connectionVersion: 8,
		accountsByServer: {},
		principalVersion: 9,
		...overrides,
	};
}

function databaseCacheEntry(
	connection: SqlConnection,
	principal: string,
	databases: string[],
): SqlDatabaseCacheEntry {
	const principalFingerprint = sqlSchemaPrincipalFingerprintForPrincipal(connection, principal);
	if (!principalFingerprint) throw new Error('Expected SQL principal fingerprint.');
	return {
		version: 1,
		connectionId: connection.id,
		targetSignature: sqlDatabaseTargetSignature(connection),
		principalFingerprint,
		databases,
		writeId: 'write-1',
		requestId: 'request-1',
		requestVersion: 1,
		updatedAt: 1,
	};
}

function createHarness(options: {
	capturedConnections?: SqlConnection[];
	snapshot?: SqlOwnerSnapshot;
	cacheEntries?: ReadonlyMap<string, SqlDatabaseCacheEntry | undefined>;
	applicationState?: Readonly<Record<string, unknown>>;
	favorites?: SqlFavorite[];
} = {}) {
	const capturedConnections = options.capturedConnections ?? [sqlConnection()];
	let snapshot = options.snapshot ?? ownerSnapshot(capturedConnections);
	const cacheEntries = options.cacheEntries ?? new Map();
	const applicationState = options.applicationState ?? {};
	const getConnections = vi.fn(() => capturedConnections);
	const applicationStateGet = vi.fn((key: string) => applicationState[key]);
	const readDatabaseCache = vi.fn(async (connection: SqlConnection) => cacheEntries.get(connection.id));
	const getFavorites = vi.fn(() => options.favorites ?? []);
	const postMessage = vi.fn(async () => true);
	const dispatchSqlOwnerSnapshot = vi.fn();
	const handler = new HostSqlConnectionsProjectionApplicationHandler({
		applicationState: {
			get<T>(key: string, defaultValue?: T): T | undefined {
				const value = applicationStateGet(key);
				return (value === undefined ? defaultValue : value) as T | undefined;
			},
		},
		connectionManager: { getConnections },
		workbench: {
			async dispatchSqlOwnerSnapshot<T>(
				dispatch: (owner: SqlOwnerSnapshot) => T | PromiseLike<T>,
			): Promise<T> {
				dispatchSqlOwnerSnapshot();
				return await dispatch(snapshot);
			},
		},
		readDatabaseCache,
		getFavorites,
		postMessage,
	});
	return {
		handler,
		getConnections,
		applicationStateGet,
		readDatabaseCache,
		getFavorites,
		postMessage,
		dispatchSqlOwnerSnapshot,
		setSnapshot(value: SqlOwnerSnapshot) { snapshot = value; },
	};
}

describe('HostSqlConnectionsProjectionApplicationHandler', () => {
	it('claims malformed recognized requests before projection effects', async () => {
		const harness = createHarness();
		const malformed = Object.assign([], { type: 'getSqlConnections' });

		await expect(harness.handler.handleMessage(
			malformed as unknown as IncomingWebviewMessage,
		)).resolves.toBeUndefined();

		expect(harness.getConnections).not.toHaveBeenCalled();
		expect(harness.readDatabaseCache).not.toHaveBeenCalled();
		expect(harness.applicationStateGet).not.toHaveBeenCalled();
		expect(harness.dispatchSqlOwnerSnapshot).not.toHaveBeenCalled();
		expect(harness.getFavorites).not.toHaveBeenCalled();
		expect(harness.postMessage).not.toHaveBeenCalled();
	});

	it('declines unrelated traffic and publishes the complete canonical projection', async () => {
		const connection = sqlConnection({ authType: 'aad', username: undefined });
		const principal = 'account-a';
		const principalFingerprint = sqlSchemaPrincipalFingerprintForPrincipal(connection, principal);
		const cacheEntry = databaseCacheEntry(connection, principal, ['DbA', 'DbB']);
		const favorite: SqlFavorite = { name: 'Favorite A', connectionId: connection.id, database: 'DbA' };
		const harness = createHarness({
			capturedConnections: [connection],
			snapshot: ownerSnapshot([connection], {
				accountsByServer: { 'server.example': principal },
				policy: {
					connectionIds: [],
					version: 7,
					globallyBlocked: false,
					revocationGenerations: { [connection.id]: 4 },
				},
			}),
			cacheEntries: new Map([[connection.id, cacheEntry]]),
			applicationState: {
				'sql.lastConnectionId': connection.id,
				'sql.lastDatabase': 'DbB',
			},
			favorites: [favorite],
		});
		const unrelated: IncomingWebviewMessage = { type: 'getConnections' };
		expect(harness.handler.handleMessage(unrelated)).toBeUndefined();

		await expect(harness.handler.handleMessage({ type: 'getSqlConnections' })).resolves.toBeUndefined();

		expect(harness.readDatabaseCache).toHaveBeenCalledWith(connection);
		expect(harness.dispatchSqlOwnerSnapshot).toHaveBeenCalledOnce();
		expect(harness.postMessage).toHaveBeenCalledWith({
			type: 'sqlConnectionsData',
			revision: 1,
			sqlStateVersions: { policy: 7, connections: 8, principals: 9 },
			connections: [{ ...connection, principalFingerprint, revocationGeneration: 4 }],
			lastConnectionId: connection.id,
			lastDatabase: 'DbB',
			cachedDatabases: { [connection.id]: ['DbA', 'DbB'] },
			sqlFavorites: [favorite],
			sqlLeaveNoTrace: [],
		});
	});

	it('validates the complete canonical projection before transport', async () => {
		const malformedConnection = {
			...sqlConnection(),
			name: 42,
		} as unknown as SqlConnection;
		const harness = createHarness({
			capturedConnections: [malformedConnection],
			snapshot: ownerSnapshot([malformedConnection]),
		});

		await expect(harness.handler.refresh()).resolves.toBe(false);

		expect(harness.dispatchSqlOwnerSnapshot).toHaveBeenCalledOnce();
		expect(harness.postMessage).not.toHaveBeenCalled();
	});

	it('treats prototype-sensitive connection IDs as own policy and cache keys', async () => {
		const connection = sqlConnection({ id: '__proto__' });
		const cacheEntry = databaseCacheEntry(connection, 'user-a', ['PrototypeDb']);
		const harness = createHarness({
			capturedConnections: [connection],
			snapshot: ownerSnapshot([connection], {
				policy: {
					connectionIds: [], version: 7, globallyBlocked: false, revocationGenerations: {},
				},
			}),
			cacheEntries: new Map([[connection.id, cacheEntry]]),
		});

		await expect(harness.handler.refresh()).resolves.toBe(true);

		const payload = harness.postMessage.mock.calls[0][0];
		expect(payload.connections[0]).toEqual({
			...connection,
			principalFingerprint: sqlSchemaPrincipalFingerprintForPrincipal(connection, 'user-a'),
			revocationGeneration: 0,
		});
		expect(Object.prototype.hasOwnProperty.call(payload.cachedDatabases, connection.id)).toBe(true);
		expect(payload.cachedDatabases[connection.id]).toEqual(['PrototypeDb']);
	});

	it('joins cache data only to the canonical target and principal snapshot', async () => {
		const captured = sqlConnection({ serverUrl: 'captured.example', username: 'captured-user' });
		const canonical = sqlConnection({ serverUrl: 'canonical.example', username: 'canonical-user' });
		const harness = createHarness({
			capturedConnections: [captured],
			snapshot: ownerSnapshot([canonical]),
			cacheEntries: new Map([[
				captured.id,
				databaseCacheEntry(captured, 'captured-user', ['CapturedDb']),
			]]),
		});

		await expect(harness.handler.refresh()).resolves.toBe(true);

		const payload = harness.postMessage.mock.calls[0][0];
		expect(payload.connections[0]).toEqual(expect.objectContaining({
			serverUrl: 'canonical.example',
			username: 'canonical-user',
		}));
		expect(payload.cachedDatabases).toEqual({});
	});

	it('rejects captured cache after canonical AAD principal rotation', async () => {
		const connection = sqlConnection({ authType: 'aad', username: undefined });
		const principalA = 'account-a';
		const principalB = 'account-b';
		const principalBFingerprint = sqlSchemaPrincipalFingerprintForPrincipal(connection, principalB);
		const harness = createHarness({
			capturedConnections: [connection],
			snapshot: ownerSnapshot([connection], {
				accountsByServer: { 'server.example': principalB },
			}),
			cacheEntries: new Map([[
				connection.id,
				databaseCacheEntry(connection, principalA, ['AccountADb']),
			]]),
		});

		await expect(harness.handler.refresh()).resolves.toBe(true);

		const payload = harness.postMessage.mock.calls[0][0];
		expect(payload.connections[0]).toEqual({
			...connection,
			principalFingerprint: principalBFingerprint,
			revocationGeneration: 0,
		});
		expect(payload.cachedDatabases).toEqual({});
	});

	it('filters only selectively protected favorites', async () => {
		const connection = sqlConnection();
		const protectedFavorite: SqlFavorite = {
			name: 'Protected', connectionId: connection.id, database: 'SecretDb',
		};
		const visibleFavorite: SqlFavorite = {
			name: 'Other', connectionId: 'sql-other', database: 'PublicDb',
		};
		const harness = createHarness({
			capturedConnections: [connection],
			snapshot: ownerSnapshot([connection], {
				policy: {
					connectionIds: [connection.id],
					version: 10,
					globallyBlocked: false,
					revocationGenerations: { [connection.id]: 2 },
				},
			}),
			favorites: [protectedFavorite, visibleFavorite],
		});

		await expect(harness.handler.refresh()).resolves.toBe(true);

		const payload = harness.postMessage.mock.calls[0][0];
		expect(payload.sqlFavorites).toEqual([visibleFavorite]);
		expect(payload.sqlLeaveNoTrace).toEqual([connection.id]);
	});

	it('filters all cache, principal, and favorite metadata from a globally blocked snapshot', async () => {
		const connection = sqlConnection();
		const protectedFavorite: SqlFavorite = {
			name: 'Protected', connectionId: connection.id, database: 'SecretDb',
		};
		const visibleFavorite: SqlFavorite = {
			name: 'Other', connectionId: 'sql-other', database: 'PublicDb',
		};
		const harness = createHarness({
			capturedConnections: [connection],
			snapshot: ownerSnapshot([connection], {
				policy: {
					connectionIds: [],
					version: 10,
					globallyBlocked: true,
					revocationGenerations: { [connection.id]: 6 },
				},
			}),
			cacheEntries: new Map([[
				connection.id,
				databaseCacheEntry(connection, 'user-a', ['SecretDb']),
			]]),
			favorites: [protectedFavorite, visibleFavorite],
		});

		await expect(harness.handler.refresh()).resolves.toBe(true);

		const payload = harness.postMessage.mock.calls[0][0];
		expect(payload.connections[0]).toEqual({ ...connection, revocationGeneration: 6 });
		expect(payload.connections[0]).not.toHaveProperty('principalFingerprint');
		expect(payload.cachedDatabases).toEqual({});
		expect(payload.sqlFavorites).toEqual([]);
		expect(payload.sqlLeaveNoTrace).toEqual([connection.id]);
		expect(harness.getFavorites).not.toHaveBeenCalled();
	});

	it('serializes overlapping refreshes and returns each exact delivery result', async () => {
		const harness = createHarness();
		const firstDelivery = deferred<boolean>();
		harness.postMessage
			.mockImplementationOnce(() => firstDelivery.promise)
			.mockResolvedValueOnce(false);

		const first = harness.handler.refresh();
		await vi.waitFor(() => expect(harness.postMessage).toHaveBeenCalledTimes(1));
		const second = harness.handler.refresh();
		await Promise.resolve();
		expect(harness.getConnections).toHaveBeenCalledTimes(1);

		firstDelivery.resolve(true);
		await expect(first).resolves.toBe(true);
		await expect(second).resolves.toBe(false);
		expect(harness.postMessage.mock.calls.map(call => call[0].revision)).toEqual([1, 2]);
	});

	it('continues the revisioned tail after a failed snapshot', async () => {
		const harness = createHarness();
		const failure = new Error('projection transport failed');
		harness.postMessage
			.mockRejectedValueOnce(failure)
			.mockResolvedValueOnce(true);

		await expect(harness.handler.refresh()).rejects.toBe(failure);
		await expect(harness.handler.refresh()).resolves.toBe(true);

		expect(harness.postMessage.mock.calls.map(call => call[0].revision)).toEqual([1, 2]);
	});

	it('suppresses queued and later work after disposal', async () => {
		const connection = sqlConnection();
		const cacheRead = deferred<SqlDatabaseCacheEntry | undefined>();
		const harness = createHarness({ capturedConnections: [connection] });
		harness.readDatabaseCache.mockImplementationOnce(() => cacheRead.promise);
		const accepted = harness.handler.refresh();
		await vi.waitFor(() => expect(harness.readDatabaseCache).toHaveBeenCalledOnce());

		harness.handler.dispose();
		harness.handler.dispose();
		cacheRead.resolve(undefined);

		await expect(accepted).resolves.toBe(false);
		expect(harness.applicationStateGet).not.toHaveBeenCalled();
		expect(harness.dispatchSqlOwnerSnapshot).not.toHaveBeenCalled();
		expect(harness.getFavorites).not.toHaveBeenCalled();
		expect(harness.postMessage).not.toHaveBeenCalled();
		await expect(harness.handler.handleMessage({ type: 'getSqlConnections' })).resolves.toBeUndefined();
		await expect(harness.handler.refresh()).resolves.toBe(false);
		expect(harness.readDatabaseCache).toHaveBeenCalledOnce();
	});
});
