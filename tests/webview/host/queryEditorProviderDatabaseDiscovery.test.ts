import { describe, expect, it, vi } from 'vitest';

import { QueryEditorProvider } from '../../../src/host/queryEditorProvider';
import { sqlSchemaPrincipalFingerprint } from '../../../src/host/sqlEditorSchema';
import {
	beginSqlDatabaseCacheRequest,
	SQL_DATABASE_CACHE_STORAGE_KEY,
	writeOwnedSqlDatabaseCacheEntry,
} from '../../../src/host/sqlDatabaseCache';

function createProviderHarness(): QueryEditorProvider & Record<string, any> {
	const provider = Object.create(QueryEditorProvider.prototype) as QueryEditorProvider & Record<string, any>;
	return provider;
}

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>(res => { resolve = res; });
	return { promise, resolve };
}

function createSqlConnectionSnapshotHarness(options: { accountId?: string; authType?: 'aad' | 'sql-login' } = {}) {
	const provider = createProviderHarness();
	const authType = options.authType ?? 'sql-login';
	let accountId = options.accountId;
	const connection: any = {
		id: 'sql-1', name: 'SQL', dialect: 'mssql', serverUrl: 'server.example', port: 1433,
		database: 'master', authType, ...(authType === 'sql-login' ? { username: 'user-a' } : {}),
	};
	const cachedDatabases: Record<string, any> = {};
	const globalState = {
		get: vi.fn((key: string) => {
			if (key === 'sql.auth.serverAccountMap') return accountId ? { 'server.example': accountId } : {};
			if (key === 'sql.connectionManager.cachedDatabases') return { ...cachedDatabases };
			return undefined;
		}),
		update: vi.fn(async (key: string, value: unknown) => {
			if (key === 'sql.connectionManager.cachedDatabases') {
				for (const existing of Object.keys(cachedDatabases)) delete cachedDatabases[existing];
				Object.assign(cachedDatabases, value);
			}
		}),
	};
	const connectionManager = {
		getConnection: vi.fn(() => connection),
		getConnections: vi.fn(() => [connection]),
	};
	provider.context = { globalState };
	provider.sqlWorkbench = {
		connectionManager,
		dispatchSqlOwnerSnapshot: vi.fn(async (dispatch: (snapshot: any) => unknown) => await dispatch({
			policy: { connectionIds: [], version: 1, globallyBlocked: false, revocationGenerations: {} },
			connections: [connection], connectionVersion: 1,
			accountsByServer: accountId ? { 'server.example': accountId } : {}, principalVersion: 1,
		})),
	};
	provider.sqlFavoritesApplication = {
		handleMessage: vi.fn(),
		getFavorites: vi.fn(() => []),
		dispose: vi.fn(),
	};
	provider.output = { error: vi.fn(), warn: vi.fn() };
	provider.postMessage = vi.fn();
	provider.sqlConnectionsSnapshotTail = Promise.resolve(true);
	return {
		provider,
		globalState,
		cachedDatabases,
		getConnection: () => connection,
		setAccountId: (value: string | undefined) => { accountId = value; },
	};
}

async function seedOwnedSqlDatabaseCache(
	harness: ReturnType<typeof createSqlConnectionSnapshotHarness>,
	databases: string[],
): Promise<void> {
	const connection = harness.getConnection();
	const principalFingerprint = sqlSchemaPrincipalFingerprint(harness.provider.context, connection);
	if (!principalFingerprint) throw new Error('Expected a SQL principal fingerprint.');
	const request = await beginSqlDatabaseCacheRequest(
		harness.provider.context,
		SQL_DATABASE_CACHE_STORAGE_KEY,
		connection,
	);
	await writeOwnedSqlDatabaseCacheEntry(
		harness.provider.context,
		SQL_DATABASE_CACHE_STORAGE_KEY,
		connection,
		principalFingerprint,
		databases,
		request,
		async () => undefined,
	);
}

describe('QueryEditorProvider SQL connection snapshot ownership', () => {
	it('omits a populated cache from connection snapshots after principal rotation', async () => {
		const harness = createSqlConnectionSnapshotHarness({ accountId: 'account-a', authType: 'aad' });
		await seedOwnedSqlDatabaseCache(harness, ['AccountADb']);

		harness.provider.postMessage.mockClear();
		harness.setAccountId('account-b');
		await harness.provider.sendSqlConnectionsData();

		expect(harness.provider.postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'sqlConnectionsData',
			cachedDatabases: {},
		}));
	});

	it('canonically strips protected cache data and principal fingerprints from a stale local snapshot', async () => {
		const harness = createSqlConnectionSnapshotHarness({ accountId: 'account-a', authType: 'aad' });
		(harness.cachedDatabases as any).entries = {
			'sql-1': { databases: ['SecretDb'] },
		};
		harness.provider.sqlWorkbench.dispatchSqlOwnerSnapshot = vi.fn(async (dispatch: (snapshot: any) => unknown) => await dispatch({
			policy: { connectionIds: ['sql-1'], version: 2, globallyBlocked: false, revocationGenerations: { 'sql-1': 1 } },
			connections: [harness.getConnection()], connectionVersion: 1,
			accountsByServer: { 'server.example': 'account-a' }, principalVersion: 1,
		}));

		await harness.provider.sendSqlConnectionsData();

		const message = harness.provider.postMessage.mock.calls.map((call: any[]) => call[0])
			.find((candidate: any) => candidate.type === 'sqlConnectionsData');
		expect(message.sqlLeaveNoTrace).toEqual(['sql-1']);
		expect(message.cachedDatabases).toEqual({});
		expect(message.connections[0]).not.toHaveProperty('principalFingerprint');
	});

	it('propagates the latest failed delivery across overlapping connection snapshots', async () => {
		const harness = createSqlConnectionSnapshotHarness();
		const firstDelivery = deferred<boolean>();
		harness.provider.postMessage
			.mockImplementationOnce(() => firstDelivery.promise)
			.mockResolvedValueOnce(false);

		const first = harness.provider.sendSqlConnectionsData();
		await vi.waitFor(() => expect(harness.provider.postMessage).toHaveBeenCalledTimes(1));
		const second = harness.provider.sendSqlConnectionsData();
		firstDelivery.resolve(true);

		await expect(first).resolves.toBe(true);
		await expect(second).resolves.toBe(false);
		expect(harness.provider.postMessage).toHaveBeenCalledTimes(2);
	});
});