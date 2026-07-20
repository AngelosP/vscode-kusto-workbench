import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Uri } from 'vscode';

import {
	establishCanonicalSqlServerAccount,
	readCurrentSqlServerAccountMap,
	setCanonicalSqlServerAccount,
	SqlServerAccountMapStore,
} from '../../../src/host/sql/sqlServerAccountMapStore';

const tempDirectories: string[] = [];

afterEach(() => {
	for (const directory of tempDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function createContext(directory: string) {
	const values = new Map<string, unknown>();
	return {
		globalStorageUri: Uri.file(directory),
		globalState: {
			get: vi.fn((key: string) => values.get(key)),
			update: vi.fn(async (key: string, value: unknown) => { values.set(key, value); }),
		},
		_values: values,
	} as any;
}

function output() {
	return { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;
}

describe('SqlServerAccountMapStore', () => {
	it('atomically preserves the winner of concurrent first-owner adoption', async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sql-account-adoption-'));
		tempDirectories.push(directory);
		const firstContext = createContext(directory);
		const secondContext = createContext(directory);

		const results = await Promise.all([
			establishCanonicalSqlServerAccount(firstContext, 'server.example', 'account-a'),
			establishCanonicalSqlServerAccount(secondContext, 'server.example', 'account-b'),
		]);

		expect(new Set(results).size).toBe(1);
		const winner = results[0];
		expect(['account-a', 'account-b']).toContain(winner);
		expect(await readCurrentSqlServerAccountMap(firstContext)).toEqual({ 'server.example': winner });
	});

	it('keeps the canonical account map when the post-commit migration sentinel creation fails', async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sql-account-migration-failure-'));
		tempDirectories.push(directory);
		const context = createContext(directory);
		const store = new SqlServerAccountMapStore(context, output());
		let renameSpy: ReturnType<typeof vi.spyOn> | undefined;
		try {
			await store.ready();
			await setCanonicalSqlServerAccount(context, 'server.example', 'account-a');
			fs.rmSync(path.join(directory, 'sql-server-account-map-migrated.v1'));
			const realRename = fs.promises.rename.bind(fs.promises);
			renameSpy = vi.spyOn(fs.promises, 'rename').mockImplementation(async (oldPath, newPath) => {
				if (String(newPath).endsWith('sql-server-account-map-migrated.v1')) throw new Error('migration failed');
				await realRename(oldPath, newPath);
			});

			await expect(setCanonicalSqlServerAccount(context, 'server.example', 'account-b')).resolves.toBeUndefined();
			renameSpy.mockRestore();
			renameSpy = undefined;
			expect(JSON.parse(fs.readFileSync(path.join(directory, 'sql-server-account-map.v1.json'), 'utf8')).accountsByServer)
				.toEqual({ 'server.example': 'account-b' });
			expect(fs.existsSync(path.join(directory, 'sql-server-account-map-migrated.v1'))).toBe(false);
			store.dispose();

			context._values.set('sql.auth.serverAccountMap', { 'server.example': 'stale-account' });
			const restarted = new SqlServerAccountMapStore(context, output());
			try {
				await restarted.ready();
				expect(restarted.getAccountsByServer()).toEqual({ 'server.example': 'account-b' });
				expect(fs.existsSync(path.join(directory, 'sql-server-account-map-migrated.v1'))).toBe(true);
			} finally {
				restarted.dispose();
			}
		} finally {
			renameSpy?.mockRestore();
			store.dispose();
		}
	});

	it('does not mark migration complete when canonical account-map replacement fails', async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sql-account-migration-primary-failure-'));
		tempDirectories.push(directory);
		const context = createContext(directory);
		let renameSpy: ReturnType<typeof vi.spyOn> | undefined;
		let store: SqlServerAccountMapStore | undefined;
		try {
			context._values.set('sql.auth.serverAccountMap', { 'server.example': 'legacy-account' });
			const realRename = fs.promises.rename.bind(fs.promises);
			renameSpy = vi.spyOn(fs.promises, 'rename').mockImplementation(async (oldPath, newPath) => {
				if (String(newPath).endsWith('sql-server-account-map.v1.json')) throw new Error('primary failed');
				await realRename(oldPath, newPath);
			});
			store = new SqlServerAccountMapStore(context, output());

			await expect(store.ready()).rejects.toThrow('primary failed');
			expect(fs.existsSync(path.join(directory, 'sql-server-account-map-migrated.v1'))).toBe(false);
		} finally {
			renameSpy?.mockRestore();
			store?.dispose();
		}
	});

	it('does not publish an account rotation when primary replacement fails', async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sql-account-primary-failure-'));
		tempDirectories.push(directory);
		const context = createContext(directory);
		const store = new SqlServerAccountMapStore(context, output());
		let renameSpy: ReturnType<typeof vi.spyOn> | undefined;
		try {
			await store.ready();
			await setCanonicalSqlServerAccount(context, 'server.example', 'account-a');
			context._values.set('sql.auth.serverAccountMap', { 'server.example': 'stale-account' });
			const realRename = fs.promises.rename.bind(fs.promises);
			renameSpy = vi.spyOn(fs.promises, 'rename').mockImplementation(async (oldPath, newPath) => {
				if (String(newPath).endsWith('sql-server-account-map.v1.json')) throw new Error('primary failed');
				await realRename(oldPath, newPath);
			});

			await expect(setCanonicalSqlServerAccount(context, 'server.example', 'account-b')).rejects.toThrow('primary failed');
			renameSpy.mockRestore();
			renameSpy = undefined;
			expect(await readCurrentSqlServerAccountMap(context)).toEqual({ 'server.example': 'account-a' });
		} finally {
			renameSpy?.mockRestore();
			store.dispose();
		}
	});

	it('propagates canonical AAD principal changes across extension-host contexts', async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sql-account-map-'));
		tempDirectories.push(directory);
		const firstContext = createContext(directory);
		const secondContext = createContext(directory);
		const first = new SqlServerAccountMapStore(firstContext, output());
		const second = new SqlServerAccountMapStore(secondContext, output());
		const changes: unknown[] = [];
		second.onDidChange(change => changes.push(change));

		try {
			await Promise.all([first.ready(), second.ready()]);
			await setCanonicalSqlServerAccount(firstContext, 'Server.Example', 'account-a');
			await second.refresh();
			expect(await readCurrentSqlServerAccountMap(secondContext)).toEqual({ 'server.example': 'account-a' });
			expect(changes).toEqual([expect.objectContaining({ changedServerUrls: ['server.example'] })]);

			await setCanonicalSqlServerAccount(firstContext, 'server.example', 'account-b');
			await second.refresh();
			expect(second.getAccountsByServer()).toEqual({ 'server.example': 'account-b' });
			expect(changes.at(-1)).toEqual(expect.objectContaining({ changedServerUrls: ['server.example'] }));
		} finally {
			first.dispose();
			second.dispose();
		}
	});

	it('quarantines a malformed canonical account map and recovers the legacy mirror', async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sql-account-corrupt-'));
		tempDirectories.push(directory);
		fs.writeFileSync(path.join(directory, 'sql-server-account-map.v1.json'), '{broken', 'utf8');
		const context = createContext(directory);
		context._values.set('sql.auth.serverAccountMap', { 'server.example': 'account-a' });
		const store = new SqlServerAccountMapStore(context, output());

		try {
			await expect(store.ready()).resolves.toBeUndefined();
			expect(store.getAccountsByServer()).toEqual({});
			expect(fs.readdirSync(directory).some(name => name.startsWith('sql-server-account-map.v1.json.corrupt-'))).toBe(true);
		} finally {
			store.dispose();
		}
	});

	it('does not trust a stale mirror when the canonical account map is structurally invalid', async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sql-account-structural-'));
		tempDirectories.push(directory);
		fs.writeFileSync(path.join(directory, 'sql-server-account-map.v1.json'), '{}', 'utf8');
		const context = createContext(directory);
		context._values.set('sql.auth.serverAccountMap', { 'server.example': 'account-a' });
		const store = new SqlServerAccountMapStore(context, output());
		try {
			await store.ready();
			expect(store.getAccountsByServer()).toEqual({});
			expect(context._values.get('sql.auth.serverAccountMap')).toEqual({});
		} finally {
			store.dispose();
		}
	});

	it('publishes a newer empty snapshot and invalidates an active principal after live corruption', async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sql-account-live-corrupt-'));
		tempDirectories.push(directory);
		const context = createContext(directory);
		const store = new SqlServerAccountMapStore(context, output());
		const changes: any[] = [];
		store.onDidChange(change => changes.push(change));
		try {
			await store.ready();
			await setCanonicalSqlServerAccount(context, 'server.example', 'account-a');
			await store.refresh();
			const establishedVersion = changes.at(-1).version;
			changes.length = 0;

			fs.writeFileSync(path.join(directory, 'sql-server-account-map.v1.json'), '{broken', 'utf8');
			await store.refresh();

			expect(store.getAccountsByServer()).toEqual({});
			expect(changes).toEqual([expect.objectContaining({
				changedServerUrls: ['server.example'],
				invalidatedServerUrls: ['server.example'],
			})]);
			expect(changes[0].version).toBeGreaterThan(establishedVersion);
			expect(await readCurrentSqlServerAccountMap(context)).toEqual({});
		} finally {
			store.dispose();
		}
	});

	it('publishes a newer empty snapshot when the live canonical account map disappears', async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sql-account-live-missing-'));
		tempDirectories.push(directory);
		const context = createContext(directory);
		const store = new SqlServerAccountMapStore(context, output());
		const changes: any[] = [];
		store.onDidChange(change => changes.push(change));
		try {
			await store.ready();
			await setCanonicalSqlServerAccount(context, 'server.example', 'account-a');
			await store.refresh();
			const establishedVersion = store.getVersion();
			context._values.set('sql.auth.serverAccountMap', { 'server.example': 'stale-account' });
			fs.unlinkSync(path.join(directory, 'sql-server-account-map.v1.json'));
			changes.length = 0;

			await store.refresh();

			expect(store.getAccountsByServer()).toEqual({});
			expect(store.getVersion()).toBeGreaterThan(establishedVersion);
			expect(changes).toEqual([expect.objectContaining({ invalidatedServerUrls: ['server.example'] })]);
			expect(await readCurrentSqlServerAccountMap(context)).toEqual({});
		} finally {
			store.dispose();
		}
	});

	it('does not replay a stale mirror after restart when the migrated canonical map is missing', async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sql-account-restart-missing-'));
		tempDirectories.push(directory);
		const firstContext = createContext(directory);
		const first = new SqlServerAccountMapStore(firstContext, output());
		try {
			await first.ready();
			await setCanonicalSqlServerAccount(firstContext, 'server.example', 'account-a');
			await first.refresh();
		} finally {
			first.dispose();
		}
		fs.rmSync(path.join(directory, 'sql-server-account-map.v1.json'), { force: true });

		const staleContext = createContext(directory);
		staleContext._values.set('sql.auth.serverAccountMap', { 'server.example': 'stale-account' });
		const second = new SqlServerAccountMapStore(staleContext, output());
		try {
			await second.ready();
			expect(second.getAccountsByServer()).toEqual({});
			expect(staleContext._values.get('sql.auth.serverAccountMap')).toEqual({});
		} finally {
			second.dispose();
		}
	});
});
