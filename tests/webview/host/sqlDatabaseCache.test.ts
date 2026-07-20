import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	beginSqlDatabaseCacheRequest,
	clearSqlDatabaseCacheStore,
	blockSqlDatabaseCacheConnection,
	deleteSqlDatabaseCacheEntry,
	getOwnedSqlDatabaseCacheEntry,
	parseSqlDatabaseCacheStore,
	setSqlDatabaseCacheConnectionIdentity,
	sqlDatabaseTargetSignature,
	unblockSqlDatabaseCacheConnection,
	writeOwnedSqlDatabaseCacheEntry,
} from '../../../src/host/sqlDatabaseCache';
import { sqlSchemaPrincipalFingerprintForPrincipal } from '../../../src/host/sqlEditorSchema';

const tempDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirectories.splice(0).map(directory => fs.promises.rm(directory, { recursive: true, force: true })));
});

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>(res => { resolve = res; });
	return { promise, resolve };
}

function createHarness(options: { disk?: boolean } = {}) {
	let accountId = 'account-a';
	let accountVersion = 1;
	let store: unknown = {};
	const directory = options.disk ? fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sql-db-cache-')) : undefined;
	if (directory) tempDirectories.push(directory);
	const context = {
		...(directory ? { globalStorageUri: { fsPath: directory } } : {}),
		globalState: {
			get: vi.fn((key: string) => key === 'sql.auth.serverAccountMap'
				? { 'server.example': accountId }
				: store),
			update: vi.fn(async (_key: string, value: unknown) => { store = structuredClone(value); }),
		},
	} as any;
	const writeCanonicalAccount = (value: string) => {
		const root = String(context.globalStorageUri?.fsPath || '');
		if (!root) return;
		fs.mkdirSync(root, { recursive: true });
		fs.writeFileSync(path.join(root, 'sql-server-account-map.v1.json'), JSON.stringify({
			schemaVersion: 1,
			version: accountVersion++,
			accountsByServer: value ? { 'server.example': value } : {},
		}), 'utf8');
	};
	writeCanonicalAccount(accountId);
	const connection = {
		id: 'sql-1', name: 'SQL', dialect: 'mssql', serverUrl: 'server.example', port: 1433,
		database: 'master', authType: 'aad',
	};
	return {
		context,
		connection,
		getStore: () => store,
		setStore: (value: unknown) => { store = value; },
		setAccountId: (value: string) => { accountId = value; writeCanonicalAccount(value); },
		setLegacyAccountId: (value: string) => { accountId = value; },
	};
}

const ACCOUNT_A_FINGERPRINT = 'c7413a6dcd19462ddd57b771aab9c07f664891a66017c0122c0099af711c6f70';

describe('SQL database cache ownership', () => {
	it('ignores legacy arrays and malformed entries', () => {
		expect(parseSqlDatabaseCacheStore({ 'sql-1': ['LegacyDb'] })).toEqual({});
		expect(parseSqlDatabaseCacheStore({ schemaVersion: 1, version: 1, entries: { 'sql-1': { version: 1, databases: ['Db'] } } })).toEqual({});
	});

	it('admits only the exact current target and principal', async () => {
		const harness = createHarness();
		const request = await beginSqlDatabaseCacheRequest(harness.context, 'cache', harness.connection);
		await writeOwnedSqlDatabaseCacheEntry(harness.context, 'cache', harness.connection, ACCOUNT_A_FINGERPRINT, ['DbA'], request, async () => undefined);

		expect((await getOwnedSqlDatabaseCacheEntry(harness.context, 'cache', harness.connection))?.databases).toEqual(['DbA']);
		harness.setAccountId('account-b');
		expect(await getOwnedSqlDatabaseCacheEntry(harness.context, 'cache', harness.connection)).toBeUndefined();
		harness.setAccountId('account-a');
		expect(await getOwnedSqlDatabaseCacheEntry(harness.context, 'cache', { ...harness.connection, database: 'OtherDb' })).toBeUndefined();
	});

	it('allows account B to rediscover after canonical identity rebasing removes account A rows', async () => {
		const harness = createHarness({ disk: true });
		const requestA = await beginSqlDatabaseCacheRequest(harness.context, 'cache', harness.connection);
		await writeOwnedSqlDatabaseCacheEntry(harness.context, 'cache', harness.connection, ACCOUNT_A_FINGERPRINT, ['AccountADb'], requestA, async () => undefined);

		const accountBFingerprint = sqlSchemaPrincipalFingerprintForPrincipal(harness.connection, 'account-b')!;
		await setSqlDatabaseCacheConnectionIdentity(harness.context, 'cache', harness.connection, accountBFingerprint);
		harness.setAccountId('account-b');
		const requestB = await beginSqlDatabaseCacheRequest(harness.context, 'cache', harness.connection);
		await writeOwnedSqlDatabaseCacheEntry(harness.context, 'cache', harness.connection, accountBFingerprint, ['AccountBDb'], requestB, async () => undefined);

		expect((await getOwnedSqlDatabaseCacheEntry(harness.context, 'cache', harness.connection))?.databases).toEqual(['AccountBDb']);
	});

	it('allows retry after first AAD establishment when the establishing request fails', async () => {
		const harness = createHarness({ disk: true });
		harness.setAccountId('');
		await beginSqlDatabaseCacheRequest(harness.context, 'cache', harness.connection);

		harness.setAccountId('account-a');
		const retry = await beginSqlDatabaseCacheRequest(harness.context, 'cache', harness.connection);
		await writeOwnedSqlDatabaseCacheEntry(harness.context, 'cache', harness.connection, ACCOUNT_A_FINGERPRINT, ['RetryDb'], retry, async () => undefined);

		expect((await getOwnedSqlDatabaseCacheEntry(harness.context, 'cache', harness.connection))?.databases).toEqual(['RetryDb']);
	});

	it('allows another extension host to retry after first AAD establishment fails', async () => {
		const first = createHarness({ disk: true });
		first.setAccountId('');
		await beginSqlDatabaseCacheRequest(first.context, 'cache', first.connection);

		const second = createHarness();
		second.context.globalStorageUri = first.context.globalStorageUri;
		second.setAccountId('account-a');
		const retry = await beginSqlDatabaseCacheRequest(second.context, 'cache', second.connection);
		await writeOwnedSqlDatabaseCacheEntry(second.context, 'cache', second.connection, ACCOUNT_A_FINGERPRINT, ['CrossHostRetryDb'], retry, async () => undefined);

		expect((await getOwnedSqlDatabaseCacheEntry(second.context, 'cache', second.connection))?.databases).toEqual(['CrossHostRetryDb']);
	});

	it('rejects an older request that completes after a newer request', async () => {
		const harness = createHarness();
		const older = await beginSqlDatabaseCacheRequest(harness.context, 'cache', harness.connection);
		const newer = await beginSqlDatabaseCacheRequest(harness.context, 'cache', harness.connection);

		await expect(writeOwnedSqlDatabaseCacheEntry(harness.context, 'cache', harness.connection, ACCOUNT_A_FINGERPRINT, ['OldDb'], older, async () => undefined))
			.rejects.toThrow('superseded');
		await writeOwnedSqlDatabaseCacheEntry(harness.context, 'cache', harness.connection, ACCOUNT_A_FINGERPRINT, ['CurrentDb'], newer, async () => undefined);

		expect((await getOwnedSqlDatabaseCacheEntry(harness.context, 'cache', harness.connection))?.databases).toEqual(['CurrentDb']);
	});

	it('rejects a discovery result that completes after delete', async () => {
		const harness = createHarness();
		const request = await beginSqlDatabaseCacheRequest(harness.context, 'cache', harness.connection);
		await deleteSqlDatabaseCacheEntry(harness.context, 'cache', harness.connection.id);

		await expect(writeOwnedSqlDatabaseCacheEntry(harness.context, 'cache', harness.connection, ACCOUNT_A_FINGERPRINT, ['StaleDb'], request, async () => undefined))
			.rejects.toThrow('superseded');
		expect(parseSqlDatabaseCacheStore(harness.getStore())).toEqual({});
	});

	it('rejects a discovery result that completes after clear all', async () => {
		const harness = createHarness();
		const request = await beginSqlDatabaseCacheRequest(harness.context, 'cache', harness.connection);
		await clearSqlDatabaseCacheStore(harness.context, 'cache');

		await expect(writeOwnedSqlDatabaseCacheEntry(harness.context, 'cache', harness.connection, ACCOUNT_A_FINGERPRINT, ['StaleDb'], request, async () => undefined))
			.rejects.toThrow('superseded');
		expect(parseSqlDatabaseCacheStore(harness.getStore())).toEqual({});
	});

	it('removes only its own committed value when ownership changes after persistence', async () => {
		const harness = createHarness();
		const request = await beginSqlDatabaseCacheRequest(harness.context, 'cache', harness.connection);
		let checks = 0;

		await expect(writeOwnedSqlDatabaseCacheEntry(
			harness.context,
			'cache',
			harness.connection,
			ACCOUNT_A_FINGERPRINT,
			['StaleDb'],
			request,
			async () => {
				checks += 1;
				if (checks >= 3) throw new Error('owner changed');
			},
		)).rejects.toThrow('owner changed');

		expect(parseSqlDatabaseCacheStore(harness.getStore())).toEqual({});
	});

	it('preserves SQL Login username case in the target signature', () => {
		const harness = createHarness();
		const upper = { ...harness.connection, authType: 'sql-login', username: 'ReportUser' };
		const lower = { ...upper, username: 'reportuser' };
		expect(sqlDatabaseTargetSignature(upper)).not.toBe(sqlDatabaseTargetSignature(lower));
	});

	it('preserves database case in the target signature', () => {
		const harness = createHarness();
		expect(sqlDatabaseTargetSignature({ ...harness.connection, database: 'Warehouse' }))
			.not.toBe(sqlDatabaseTargetSignature({ ...harness.connection, database: 'warehouse' }));
	});

	it('blocks new requests throughout connection mutation and allows them after explicit unblock', async () => {
		const harness = createHarness();
		await blockSqlDatabaseCacheConnection(harness.context, 'cache', harness.connection.id);
		await expect(beginSqlDatabaseCacheRequest(harness.context, 'cache', harness.connection)).rejects.toThrow('blocked');

		await unblockSqlDatabaseCacheConnection(harness.context, 'cache', harness.connection);
		await expect(beginSqlDatabaseCacheRequest(harness.context, 'cache', harness.connection)).resolves.toEqual(expect.objectContaining({ connectionId: 'sql-1' }));
	});

	it('recovers automatically after a crashed connection-mutation block expires', async () => {
		vi.useFakeTimers();
		try {
			const harness = createHarness();
			await blockSqlDatabaseCacheConnection(harness.context, 'cache', harness.connection.id);
			await expect(beginSqlDatabaseCacheRequest(harness.context, 'cache', harness.connection)).rejects.toThrow('blocked');

			await vi.advanceTimersByTimeAsync(2 * 60_000 + 1);

			await expect(beginSqlDatabaseCacheRequest(harness.context, 'cache', harness.connection))
				.resolves.toEqual(expect.objectContaining({ connectionId: 'sql-1' }));
		} finally {
			vi.useRealTimers();
		}
	});

	it('serializes two extension-host contexts through the shared disk snapshot', async () => {
		const first = createHarness({ disk: true });
		const second = createHarness();
		second.context.globalStorageUri = first.context.globalStorageUri;
		const firstRequest = await beginSqlDatabaseCacheRequest(first.context, 'cache', first.connection);
		const secondRequest = await beginSqlDatabaseCacheRequest(second.context, 'cache', second.connection);

		await expect(writeOwnedSqlDatabaseCacheEntry(first.context, 'cache', first.connection, ACCOUNT_A_FINGERPRINT, ['OldDb'], firstRequest, async () => undefined))
			.rejects.toThrow('superseded');
		await writeOwnedSqlDatabaseCacheEntry(second.context, 'cache', second.connection, ACCOUNT_A_FINGERPRINT, ['CurrentDb'], secondRequest, async () => undefined);

		expect((await getOwnedSqlDatabaseCacheEntry(first.context, 'cache', first.connection))?.databases).toEqual(['CurrentDb']);
	});

	it('ignores a stale account mirror in another extension-host context', async () => {
		const first = createHarness({ disk: true });
		const second = createHarness();
		second.context.globalStorageUri = first.context.globalStorageUri;
		second.setLegacyAccountId('account-b');
		await beginSqlDatabaseCacheRequest(first.context, 'cache', first.connection);

		await expect(beginSqlDatabaseCacheRequest(second.context, 'cache', second.connection))
			.resolves.toEqual(expect.objectContaining({ connectionId: 'sql-1' }));
	});

	it('keeps the locked file authoritative when the globalState mirror rejects', async () => {
		const harness = createHarness({ disk: true });
		harness.context.globalState.update.mockRejectedValue(new Error('mirror failed'));
		const request = await beginSqlDatabaseCacheRequest(harness.context, 'cache', harness.connection);

		await writeOwnedSqlDatabaseCacheEntry(
			harness.context, 'cache', harness.connection, ACCOUNT_A_FINGERPRINT, ['DbA'], request, async () => undefined,
		);

		expect((await getOwnedSqlDatabaseCacheEntry(harness.context, 'cache', harness.connection))?.databases).toEqual(['DbA']);
	});

	it('includes every execution-relevant non-username field in the signature', () => {
		const harness = createHarness();
		const baseline = sqlDatabaseTargetSignature(harness.connection);
		for (const changed of [
			{ dialect: 'other' }, { serverUrl: 'other.example' }, { port: 1444 },
			{ database: 'OtherDb' }, { authType: 'sql-login' },
		]) {
			expect(sqlDatabaseTargetSignature({ ...harness.connection, ...changed })).not.toBe(baseline);
		}
	});
});
