import { describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { SqlConnectionManager } from '../../../src/host/sqlConnectionManager';

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>(res => { resolve = res; });
	return { promise, resolve };
}

function createHarness(initialConnections: any[] = [], initialPasswords: Record<string, string> = {}, globalStoragePath?: string) {
	let connections = structuredClone(initialConnections);
	const passwords = new Map(Object.entries(initialPasswords));
	const globalStateUpdate = vi.fn(async (key: string, value: unknown) => {
		if (key === 'sql.connections') connections = structuredClone(value as any[]);
	});
	const secretStore = vi.fn(async (key: string, value: string) => { passwords.set(key, value); });
	const secretDelete = vi.fn(async (key: string) => { passwords.delete(key); });
	const context = {
		...(globalStoragePath ? { globalStorageUri: { fsPath: globalStoragePath } } : {}),
		globalState: {
			get: vi.fn((key: string) => key === 'sql.connections' ? structuredClone(connections) : undefined),
			update: globalStateUpdate,
		},
		secrets: {
			get: vi.fn(async (key: string) => passwords.get(key)),
			store: secretStore,
			delete: secretDelete,
		},
	} as any;
	const manager = new SqlConnectionManager(context);
	return { manager, context, passwords, globalStateUpdate, secretStore, secretDelete, getPersisted: () => structuredClone(connections) };
}

const ORIGINAL = {
	id: 'sql-1', name: 'Original', dialect: 'mssql', serverUrl: 'old.example',
	database: 'OldDb', authType: 'sql-login', username: 'OldUser',
};

describe('SqlConnectionManager transactions', () => {
	it.each(['', '   '])('rejects a blank SQL Login username before adding credentials', async username => {
		const harness = createHarness();

		await expect(harness.manager.addConnection({
			name: 'New', dialect: 'mssql', serverUrl: 'new.example', authType: 'sql-login', username,
		}, 'password')).rejects.toThrow('non-empty username');

		expect(harness.manager.getConnections()).toEqual([]);
		expect(harness.secretStore).not.toHaveBeenCalled();
	});

	it('rejects a blank SQL Login username before editing credentials', async () => {
		const harness = createHarness([ORIGINAL], { 'sql.password.sql-1': 'old-password' });

		await expect(harness.manager.updateConnectionAndPassword('sql-1', { username: ' ' }, 'new-password'))
			.rejects.toThrow('non-empty username');

		expect(harness.manager.getConnection('sql-1')).toEqual(ORIGINAL);
		expect(harness.passwords.get('sql.password.sql-1')).toBe('old-password');
		expect(harness.secretStore).not.toHaveBeenCalled();
	});

	it.each([undefined, ''])('rejects a missing or empty password when adding SQL Login', async password => {
		const harness = createHarness();

		await expect(harness.manager.addConnection({
			name: 'New', dialect: 'mssql', serverUrl: 'new.example', authType: 'sql-login', username: 'user',
		}, password)).rejects.toThrow('non-empty password');

		expect(harness.manager.getConnections()).toEqual([]);
		expect(harness.secretStore).not.toHaveBeenCalled();
	});

	it('rejects a password payload when adding a non-SQL Login connection', async () => {
		const harness = createHarness();

		await expect(harness.manager.addConnection({
			name: 'New', dialect: 'mssql', serverUrl: 'new.example', authType: 'aad',
		}, 'must-not-be-stored')).rejects.toThrow('only be stored for SQL Login');

		expect(harness.manager.getConnections()).toEqual([]);
		expect(harness.secretStore).not.toHaveBeenCalled();
	});

	it.each([0, 65_536, 70_000, 1433.5])('rejects invalid port %s before adding a connection', async port => {
		const harness = createHarness();

		await expect(harness.manager.addConnection({
			name: 'Invalid', dialect: 'mssql', serverUrl: 'invalid.example', authType: 'aad', port,
		})).rejects.toThrow('port between 1 and 65535');

		expect(harness.manager.getConnections()).toEqual([]);
		expect(harness.getPersisted()).toEqual([]);
		expect(harness.secretStore).not.toHaveBeenCalled();
	});

	it('rejects an empty SQL Login replacement before changing the target', async () => {
		const harness = createHarness([ORIGINAL], { 'sql.password.sql-1': 'old-password' });

		await expect(harness.manager.updateConnectionAndPassword('sql-1', { serverUrl: 'new.example' }, ''))
			.rejects.toThrow('must be non-empty');

		expect(harness.manager.getConnection('sql-1')).toEqual(ORIGINAL);
		expect(harness.passwords.get('sql.password.sql-1')).toBe('old-password');
		expect(harness.secretStore).not.toHaveBeenCalled();
	});

	it('rejects a password payload when changing SQL Login to AAD', async () => {
		const harness = createHarness([ORIGINAL], { 'sql.password.sql-1': 'old-password' });

		await expect(harness.manager.updateConnectionAndPassword('sql-1', { authType: 'aad', username: undefined }, 'must-not-be-stored'))
			.rejects.toThrow('only be stored for SQL Login');

		expect(harness.manager.getConnection('sql-1')).toEqual(ORIGINAL);
		expect(harness.passwords.get('sql.password.sql-1')).toBe('old-password');
	});

	it.each([
		{ field: 'server', updates: { serverUrl: 'new.example' } },
		{ field: 'port', updates: { port: 1444 } },
		{ field: 'username', updates: { username: 'NewUser' } },
		{ field: 'dialect', updates: { dialect: 'other-sql' } },
	])('requires a replacement password when the SQL Login $field changes', async ({ updates }) => {
		const harness = createHarness([ORIGINAL], { 'sql.password.sql-1': 'old-password' });

		await expect(harness.manager.updateConnection('sql-1', updates))
			.rejects.toThrow('replacement password');
		expect(harness.manager.getConnection('sql-1')).toEqual(ORIGINAL);
		expect(harness.passwords.get('sql.password.sql-1')).toBe('old-password');
	});

	it('allows passwordless non-credential SQL Login metadata changes', async () => {
		const harness = createHarness([ORIGINAL], { 'sql.password.sql-1': 'old-password' });

		await harness.manager.updateConnection('sql-1', { name: 'Renamed', database: 'OtherDb' });

		expect(harness.manager.getConnection('sql-1')).toEqual({ ...ORIGINAL, name: 'Renamed', database: 'OtherDb' });
		expect(harness.passwords.get('sql.password.sql-1')).toBe('old-password');
	});

	it('treats omitted MSSQL port and explicit 1433 as the same credential endpoint', async () => {
		const harness = createHarness([ORIGINAL], { 'sql.password.sql-1': 'old-password' });

		await harness.manager.updateConnection('sql-1', { port: 1433 });

		expect(harness.manager.getConnection('sql-1')).toEqual({ ...ORIGINAL, port: 1433 });
		expect(harness.passwords.get('sql.password.sql-1')).toBe('old-password');
	});

	it('rejects an invalid updated port before leasing or replacing credentials', async () => {
		const harness = createHarness([ORIGINAL], { 'sql.password.sql-1': 'old-password' });

		await expect(harness.manager.updateConnectionAndPassword('sql-1', { port: 70_000 }, 'new-password'))
			.rejects.toThrow('port between 1 and 65535');

		expect(harness.manager.getConnection('sql-1')).toEqual(ORIGINAL);
		expect(harness.getPersisted()).toEqual([ORIGINAL]);
		expect(harness.passwords.get('sql.password.sql-1')).toBe('old-password');
		expect(harness.secretStore).not.toHaveBeenCalled();
	});

	it('deletes the stored password when leaving SQL Login and requires one to return', async () => {
		const harness = createHarness([ORIGINAL], { 'sql.password.sql-1': 'old-password' });

		await harness.manager.updateConnection('sql-1', { authType: 'aad', username: undefined });

		expect(harness.passwords.has('sql.password.sql-1')).toBe(false);
		await expect(harness.manager.updateConnection('sql-1', { authType: 'sql-login', username: 'OldUser' }))
			.rejects.toThrow('replacement password');
	});

	it('restores the SQL Login password when leaving-login persistence fails', async () => {
		const harness = createHarness([ORIGINAL], { 'sql.password.sql-1': 'old-password' });
		harness.globalStateUpdate.mockRejectedValueOnce(new Error('persist failed'));

		await expect(harness.manager.updateConnection('sql-1', { authType: 'aad', username: undefined }))
			.rejects.toThrow('persist failed');

		expect(harness.manager.getConnection('sql-1')).toEqual(ORIGINAL);
		expect(harness.passwords.get('sql.password.sql-1')).toBe('old-password');
	});

	it('does not publish an edit when connection persistence fails', async () => {
		const harness = createHarness([ORIGINAL], { 'sql.password.sql-1': 'old-password' });
		harness.globalStateUpdate.mockRejectedValueOnce(new Error('persist failed'));

		await expect(harness.manager.updateConnectionAndPassword('sql-1', { serverUrl: 'new.example' }, 'new-password'))
			.rejects.toThrow('persist failed');

		expect(harness.manager.getConnection('sql-1')).toEqual(ORIGINAL);
		expect(harness.getPersisted()).toEqual([ORIGINAL]);
		expect(harness.passwords.get('sql.password.sql-1')).toBe('old-password');
	});

	it('does not publish an edit when password storage fails', async () => {
		const harness = createHarness([ORIGINAL], { 'sql.password.sql-1': 'old-password' });
		harness.secretStore.mockRejectedValueOnce(new Error('secret failed'));

		await expect(harness.manager.updateConnectionAndPassword('sql-1', { serverUrl: 'new.example' }, 'new-password'))
			.rejects.toThrow('secret failed');

		expect(harness.manager.getConnection('sql-1')).toEqual(ORIGINAL);
		expect(harness.getPersisted()).toEqual([ORIGINAL]);
		expect(harness.passwords.get('sql.password.sql-1')).toBe('old-password');
	});

	it('removes an unpublished password when connection-add storage commits and then rejects', async () => {
		const harness = createHarness();
		harness.secretStore.mockImplementationOnce(async (key: string, value: string) => {
			harness.passwords.set(key, value);
			throw new Error('add secret committed then rejected');
		});

		await expect(harness.manager.addConnection({ name: 'New', dialect: 'mssql', serverUrl: 'new.example', authType: 'sql-login', username: 'user' }, 'password'))
			.rejects.toThrow('add secret committed then rejected');

		expect(harness.manager.getConnections()).toEqual([]);
		expect([...harness.passwords.keys()].filter(key => key.startsWith('sql.password.'))).toEqual([]);
	});

	it('retries cleanup of an unpublished password tombstone on next initialization', async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sql-add-cleanup-'));
		try {
			const first = createHarness([], {}, directory);
			await first.manager.ready();
			first.secretStore.mockImplementationOnce(async (key: string, value: string) => {
				first.passwords.set(key, value);
				throw new Error('add secret committed then rejected');
			});
			first.secretDelete.mockRejectedValueOnce(new Error('cleanup failed'));

			await expect(first.manager.addConnection({ name: 'New', dialect: 'mssql', serverUrl: 'new.example', authType: 'sql-login', username: 'user' }, 'password'))
				.rejects.toThrow('add secret committed then rejected');
			const orphanedKey = [...first.passwords.keys()].find(key => key.startsWith('sql.password.'))!;
			expect(orphanedKey).toBeTruthy();
			first.manager.dispose();

			const second = createHarness([], { [orphanedKey]: 'password' }, directory);
			await second.manager.ready();
			expect(second.passwords.has(orphanedKey)).toBe(false);
			expect(JSON.parse(fs.readFileSync(path.join(directory, 'sql-connections.v1.json'), 'utf8')).mutationLeases).toEqual({});
			second.manager.dispose();
		} finally {
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});

	it('quarantines a malformed orphan journal and recovers cleanup from the canonical failed lease', async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sql-orphan-journal-corrupt-'));
		const connectionId = 'sql-orphan';
		const passwordKey = `sql.password.${connectionId}`;
		try {
			fs.writeFileSync(path.join(directory, 'sql-connections.v1.json'), JSON.stringify({
				schemaVersion: 1,
				version: 2,
				connections: [],
				mutationLeases: {
					[connectionId]: { operationId: 'failed-add', expiresAt: Number.MAX_SAFE_INTEGER, failed: true },
				},
			}), 'utf8');
			fs.writeFileSync(path.join(directory, 'sql-orphan-secret-cleanup.v1.json'), '{broken', 'utf8');
			const harness = createHarness([], { [passwordKey]: 'orphan-password' }, directory);

			await expect(harness.manager.ready()).resolves.toBeUndefined();
			expect(harness.passwords.has(passwordKey)).toBe(false);
			expect(JSON.parse(fs.readFileSync(path.join(directory, 'sql-connections.v1.json'), 'utf8')).mutationLeases).toEqual({});
			expect(JSON.parse(fs.readFileSync(path.join(directory, 'sql-orphan-secret-cleanup.v1.json'), 'utf8'))).toEqual({ connectionIds: [] });
			expect(fs.readdirSync(directory).some(name => name.startsWith('sql-orphan-secret-cleanup.v1.json.corrupt-'))).toBe(true);
			harness.manager.dispose();
		} finally {
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});

	it('rolls back durable deletion when password deletion fails', async () => {
		const harness = createHarness([ORIGINAL], { 'sql.password.sql-1': 'old-password' });
		harness.secretDelete.mockRejectedValueOnce(new Error('delete failed'));

		await expect(harness.manager.removeConnection('sql-1')).rejects.toThrow('delete failed');

		expect(harness.manager.getConnection('sql-1')).toEqual(ORIGINAL);
		expect(harness.getPersisted()).toEqual([ORIGINAL]);
		expect(harness.passwords.get('sql.password.sql-1')).toBe('old-password');
	});

	it('restores a password when deletion commits and then rejects', async () => {
		const harness = createHarness([ORIGINAL], { 'sql.password.sql-1': 'old-password' });
		harness.secretDelete.mockImplementationOnce(async (key: string) => {
			harness.passwords.delete(key);
			throw new Error('delete committed then rejected');
		});

		await expect(harness.manager.removeConnection('sql-1')).rejects.toThrow('delete committed then rejected');

		expect(harness.manager.getConnection('sql-1')).toEqual(ORIGINAL);
		expect(harness.passwords.get('sql.password.sql-1')).toBe('old-password');
		await expect(harness.manager.getPasswordForConnection(ORIGINAL)).resolves.toBe('old-password');
	});

	it('publishes memory only after connection and password commits succeed', async () => {
		const harness = createHarness([ORIGINAL], { 'sql.password.sql-1': 'old-password' });

		await harness.manager.updateConnectionAndPassword('sql-1', { serverUrl: 'new.example', username: 'NewUser' }, 'new-password');

		expect(harness.manager.getConnection('sql-1')).toEqual({ ...ORIGINAL, serverUrl: 'new.example', username: 'NewUser', credentialRevision: 1 });
		expect(harness.getPersisted()).toEqual([{ ...ORIGINAL, serverUrl: 'new.example', username: 'NewUser', credentialRevision: 1 }]);
		expect(harness.passwords.get('sql.password.sql-1')).toBe('new-password');
	});

	it('rolls back when connection persistence commits and then rejects', async () => {
		const harness = createHarness([ORIGINAL], { 'sql.password.sql-1': 'old-password' });
		const realUpdate = harness.context.globalState.update.getMockImplementation()!;
		harness.globalStateUpdate.mockImplementationOnce(async (key: string, value: unknown) => {
			await realUpdate(key, value);
			throw new Error('commit then reject');
		});

		await expect(harness.manager.updateConnectionAndPassword('sql-1', { serverUrl: 'new.example' }, 'new-password'))
			.rejects.toThrow('commit then reject');

		expect(harness.manager.getConnection('sql-1')).toEqual(ORIGINAL);
		expect(harness.getPersisted()).toEqual([ORIGINAL]);
		expect(harness.passwords.get('sql.password.sql-1')).toBe('old-password');
	});

	it('rolls back when password storage commits and then rejects', async () => {
		const harness = createHarness([ORIGINAL], { 'sql.password.sql-1': 'old-password' });
		harness.secretStore.mockImplementationOnce(async (key: string, value: string) => {
			harness.passwords.set(key, value);
			throw new Error('secret commit then reject');
		});

		await expect(harness.manager.updateConnectionAndPassword('sql-1', { serverUrl: 'new.example' }, 'new-password'))
			.rejects.toThrow('secret commit then reject');

		expect(harness.manager.getConnection('sql-1')).toEqual(ORIGINAL);
		expect(harness.getPersisted()).toEqual([ORIGINAL]);
		expect(harness.passwords.get('sql.password.sql-1')).toBe('old-password');
	});

	it('keeps the connection blocked when an uncertain password cannot be restored', async () => {
		const harness = createHarness([ORIGINAL], { 'sql.password.sql-1': 'old-password' });
		harness.secretStore
			.mockImplementationOnce(async (key: string, value: string) => {
				harness.passwords.set(key, value);
				throw new Error('new secret commit then reject');
			})
			.mockRejectedValueOnce(new Error('old secret restore failed'));

		await expect(harness.manager.updateConnectionAndPassword('sql-1', { serverUrl: 'new.example' }, 'new-password'))
			.rejects.toThrow('new secret commit then reject');

		await expect(harness.manager.getPasswordForConnection(ORIGINAL)).rejects.toThrow('SQL connection is changing');
		expect(harness.manager.getConnection('sql-1')).toEqual(ORIGINAL);
		await expect(harness.manager.updateConnection('sql-1', { name: 'Metadata only' }))
			.rejects.toThrow('Enter a replacement password');
		await expect(harness.manager.getPasswordForConnection(ORIGINAL)).rejects.toThrow('SQL connection is changing');

		harness.secretStore.mockRejectedValueOnce(new Error('replacement failed'));
		await expect(harness.manager.updateConnectionAndPassword('sql-1', { name: 'Recovery attempt' }, 'replacement-password'))
			.rejects.toThrow('replacement failed');
		await expect(harness.manager.getPasswordForConnection(ORIGINAL)).rejects.toThrow('SQL connection is changing');

		harness.secretDelete.mockRejectedValueOnce(new Error('delete failed'));
		await expect(harness.manager.removeConnection('sql-1')).rejects.toThrow('delete failed');
		await expect(harness.manager.getPasswordForConnection(ORIGINAL)).rejects.toThrow('SQL connection is changing');
	});

	it('keeps a permanently blocked connection blocked when clear fails', async () => {
		const harness = createHarness([ORIGINAL], { 'sql.password.sql-1': 'old-password' });
		harness.secretStore
			.mockImplementationOnce(async (key: string, value: string) => {
				harness.passwords.set(key, value);
				throw new Error('new secret commit then reject');
			})
			.mockRejectedValueOnce(new Error('old secret restore failed'));
		await expect(harness.manager.updateConnectionAndPassword('sql-1', {}, 'new-password'))
			.rejects.toThrow('new secret commit then reject');

		harness.secretDelete.mockRejectedValueOnce(new Error('delete failed'));
		await expect(harness.manager.clearConnections()).rejects.toThrow('delete failed');

		expect(harness.manager.getConnection('sql-1')).toEqual(ORIGINAL);
		await expect(harness.manager.getPasswordForConnection(ORIGINAL)).rejects.toThrow('SQL connection is changing');
	});

	it('serializes simultaneous adds without losing either connection', async () => {
		const harness = createHarness();
		const firstPersist = deferred<void>();
		const realUpdate = harness.context.globalState.update.getMockImplementation()!;
		harness.globalStateUpdate.mockImplementationOnce(async (key: string, value: unknown) => {
			await firstPersist.promise;
			await realUpdate(key, value);
		});

		const first = harness.manager.addConnection({ name: 'A', dialect: 'mssql', serverUrl: 'a.example', authType: 'aad' });
		const second = harness.manager.addConnection({ name: 'B', dialect: 'mssql', serverUrl: 'b.example', authType: 'aad' });
		await vi.waitFor(() => expect(harness.globalStateUpdate).toHaveBeenCalledTimes(1));
		expect(harness.globalStateUpdate).toHaveBeenCalledTimes(1);
		firstPersist.resolve();
		await Promise.all([first, second]);

		expect(harness.manager.getConnections().map(connection => connection.name)).toEqual(['A', 'B']);
		expect(harness.getPersisted().map((connection: any) => connection.name)).toEqual(['A', 'B']);
	});

	it('does not resurrect a connection when edit is queued before delete', async () => {
		const harness = createHarness([ORIGINAL], { 'sql.password.sql-1': 'old-password' });
		const editPersist = deferred<void>();
		const realUpdate = harness.context.globalState.update.getMockImplementation()!;
		harness.globalStateUpdate.mockImplementationOnce(async (key: string, value: unknown) => {
			await editPersist.promise;
			await realUpdate(key, value);
		});

		const edit = harness.manager.updateConnectionAndPassword('sql-1', { serverUrl: 'new.example' }, 'new-password');
		const remove = harness.manager.removeConnection('sql-1');
		editPersist.resolve();
		await Promise.all([edit, remove]);

		expect(harness.manager.getConnection('sql-1')).toBeUndefined();
		expect(harness.getPersisted()).toEqual([]);
	});

	it('merges concurrent adds from independent extension-host contexts', async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sql-connections-'));
		try {
			const first = createHarness([], {}, directory);
			const second = createHarness([], {}, directory);
			await Promise.all([first.manager.ready(), second.manager.ready()]);

			await Promise.all([
				first.manager.addConnection({ name: 'A', dialect: 'mssql', serverUrl: 'a.example', authType: 'aad' }),
				second.manager.addConnection({ name: 'B', dialect: 'mssql', serverUrl: 'b.example', authType: 'aad' }),
			]);
			await Promise.all([first.manager.ready(), second.manager.ready()]);
			const third = createHarness([], {}, directory);
			await third.manager.ready();

			expect(third.manager.getConnections().map(connection => connection.name).sort()).toEqual(['A', 'B']);
			first.manager.dispose();
			second.manager.dispose();
			third.manager.dispose();
		} finally {
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});

	it('propagates a password-only credential revision to another manager', async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sql-password-revision-'));
		try {
			const first = createHarness([ORIGINAL], { 'sql.password.sql-1': 'old-password' }, directory);
			const second = createHarness([ORIGINAL], { 'sql.password.sql-1': 'old-password' }, directory);
			await Promise.all([first.manager.ready(), second.manager.ready()]);
			const changes: any[][] = [];
			second.manager.onDidChangeConnections(connections => changes.push([...connections]));

			await first.manager.updateConnectionAndPassword('sql-1', {}, 'new-password');
			await (second.manager as any).refresh();

			expect(second.manager.getConnection('sql-1')).toEqual({ ...ORIGINAL, credentialRevision: 1 });
			expect(changes).toContainEqual([{ ...ORIGINAL, credentialRevision: 1 }]);
			await expect(second.manager.assertConnectionCurrent(ORIGINAL)).rejects.toThrow('SQL connection changed');
			first.manager.dispose();
			second.manager.dispose();
		} finally {
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});

	it.each([
		'sql-connections.backup.v1.json',
		'sql-connections.v1.json',
	])('rolls back target and credentials when the %s pre-commit stage fails', async failedFile => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sql-precommit-failure-'));
		try {
			const first = createHarness([ORIGINAL], { 'sql.password.sql-1': 'old-password' }, directory);
			await first.manager.ready();
			const manager = first.manager as any;
			const realWriteAtomic = manager.writeAtomic.bind(manager);
			vi.spyOn(manager, 'writeAtomic').mockImplementation(async (filePath: string, contents: string) => {
				const matchesFailedStage = failedFile === 'sql-connections.backup.v1.json'
					? filePath.includes('sql-connections.backup.v1.json')
					: filePath.endsWith(failedFile);
				if (matchesFailedStage && contents.includes('new.example') && !contents.includes('mutationLeases": {\n    "sql-1"')) {
					throw new Error(`${failedFile} failed`);
				}
				await realWriteAtomic(filePath, contents);
			});

			await expect(first.manager.updateConnectionAndPassword('sql-1', { serverUrl: 'new.example' }, 'new-password'))
				.rejects.toThrow(`${failedFile} failed`);
			expect(first.passwords.get('sql.password.sql-1')).toBe('old-password');
			first.manager.dispose();

			const second = createHarness([], { 'sql.password.sql-1': 'old-password' }, directory);
			await second.manager.ready();
			expect(second.manager.getConnection('sql-1')).toEqual(ORIGINAL);
			await expect(second.manager.getPasswordForConnection(ORIGINAL)).resolves.toBe('old-password');
			second.manager.dispose();
		} finally {
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});

	it('rolls back target and password when the recovery pointer cannot commit', async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sql-marker-failure-'));
		try {
			const first = createHarness([ORIGINAL], { 'sql.password.sql-1': 'old-password' }, directory);
			await first.manager.ready();
			const manager = first.manager as any;
			const realWriteAtomic = manager.writeAtomic.bind(manager);
			vi.spyOn(manager, 'writeAtomic').mockImplementation(async (filePath: string, contents: string) => {
				if (filePath.endsWith('sql-connections.commit.v1.json')) throw new Error('marker failed');
				await realWriteAtomic(filePath, contents);
			});

			await expect(first.manager.updateConnectionAndPassword('sql-1', { serverUrl: 'new.example' }, 'new-password'))
				.rejects.toThrow('marker failed');
			expect(first.manager.getConnection('sql-1')).toEqual(ORIGINAL);
			expect(first.passwords.get('sql.password.sql-1')).toBe('old-password');
			first.manager.dispose();

			const second = createHarness([], { 'sql.password.sql-1': 'old-password' }, directory);
			await second.manager.ready();
			expect(second.manager.getConnection('sql-1')).toEqual(ORIGINAL);
			await expect(second.manager.getPasswordForConnection(ORIGINAL)).resolves.toBe('old-password');
			second.manager.dispose();
		} finally {
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});

	it('keeps the committed connection when the post-commit migration sentinel cannot be established', async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sql-migration-failure-'));
		try {
			const harness = createHarness([ORIGINAL], { 'sql.password.sql-1': 'old-password' }, directory);
			await harness.manager.ready();
			fs.rmSync(path.join(directory, 'sql-connections-migrated.v1'));
			const manager = harness.manager as any;
			const realWriteAtomic = manager.writeAtomic.bind(manager);
			vi.spyOn(manager, 'writeAtomic').mockImplementation(async (filePath: string, contents: string) => {
				if (filePath.endsWith('sql-connections-migrated.v1')) throw new Error('migration failed');
				await realWriteAtomic(filePath, contents);
			});

			await expect(harness.manager.updateConnectionAndPassword('sql-1', { serverUrl: 'new.example' }, 'new-password'))
				.resolves.toBeUndefined();
			const updated = { ...ORIGINAL, serverUrl: 'new.example', credentialRevision: 1 };
			expect(harness.manager.getConnection('sql-1')).toEqual(updated);
			expect(harness.passwords.get('sql.password.sql-1')).toBe('new-password');
			expect(fs.existsSync(path.join(directory, 'sql-connections-migrated.v1'))).toBe(false);
			harness.manager.dispose();

			const restarted = createHarness([], { 'sql.password.sql-1': 'new-password' }, directory);
			await restarted.manager.ready();
			expect(restarted.manager.getConnection('sql-1')).toEqual(updated);
			restarted.manager.dispose();
		} finally {
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});

	it('does not mark migration complete when canonical connection replacement fails', async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sql-migration-primary-failure-'));
		try {
			const harness = createHarness([ORIGINAL], { 'sql.password.sql-1': 'old-password' }, directory);
			await harness.manager.ready();
			fs.rmSync(path.join(directory, 'sql-connections-migrated.v1'));
			const manager = harness.manager as any;
			const realWriteAtomic = manager.writeAtomic.bind(manager);
			vi.spyOn(manager, 'writeAtomic').mockImplementation(async (filePath: string, contents: string) => {
				if (filePath.endsWith('sql-connections.v1.json')) throw new Error('primary failed');
				await realWriteAtomic(filePath, contents);
			});

			await expect(harness.manager.updateConnectionAndPassword('sql-1', { serverUrl: 'new.example' }, 'new-password'))
				.rejects.toThrow('primary failed');
			expect(fs.existsSync(path.join(directory, 'sql-connections-migrated.v1'))).toBe(false);
			harness.manager.dispose();
		} finally {
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});

	it('quarantines a malformed canonical connection file without trusting the legacy mirror', async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sql-connections-corrupt-'));
		try {
			await fs.promises.writeFile(path.join(directory, 'sql-connections.v1.json'), '{broken', 'utf8');
			const harness = createHarness([ORIGINAL], { 'sql.password.sql-1': 'old-password' }, directory);

			await expect(harness.manager.ready()).resolves.toBeUndefined();
			expect(harness.manager.getConnection('sql-1')).toBeUndefined();
			expect(harness.passwords.has('sql.password.sql-1')).toBe(false);
			await expect(harness.manager.getPasswordForConnection(ORIGINAL)).rejects.toThrow('SQL connection changed');
			expect(fs.readdirSync(directory).some(name => name.startsWith('sql-connections.v1.json.corrupt-'))).toBe(true);
			expect(JSON.parse(await fs.promises.readFile(path.join(directory, 'sql-connections.v1.json'), 'utf8')).connections).toEqual([]);
			harness.manager.dispose();
		} finally {
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});

	it('fails closed when the canonical connection snapshot is structurally invalid', async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sql-connections-structural-'));
		try {
			fs.writeFileSync(path.join(directory, 'sql-connections.v1.json'), '{}', 'utf8');
			const harness = createHarness([ORIGINAL], { 'sql.password.sql-1': 'old-password' }, directory);
			await harness.manager.ready();
			await expect(harness.manager.getPasswordForConnection(ORIGINAL)).rejects.toThrow('SQL connection changed');
			expect(JSON.parse(fs.readFileSync(path.join(directory, 'sql-connections.v1.json'), 'utf8')).connections).toEqual([]);
			harness.manager.dispose();
		} finally {
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});

	it('restores the committed snapshot when a nested mutation lease is malformed', async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sql-connections-nested-corrupt-'));
		try {
			const first = createHarness([ORIGINAL], { 'sql.password.sql-1': 'old-password' }, directory);
			await first.manager.ready();
			first.manager.dispose();
			const snapshotPath = path.join(directory, 'sql-connections.v1.json');
			const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
			snapshot.mutationLeases['sql-1'] = { operationId: '', expiresAt: 'invalid' };
			fs.writeFileSync(snapshotPath, JSON.stringify(snapshot), 'utf8');

			const second = createHarness([], { 'sql.password.sql-1': 'old-password' }, directory);
			await second.manager.ready();
			expect(second.manager.getConnection('sql-1')).toEqual(ORIGINAL);
			expect(fs.readdirSync(directory).some(name => name.startsWith('sql-connections.v1.json.corrupt-'))).toBe(true);
			second.manager.dispose();
		} finally {
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});

	it.each([
		['numeric connection ID', (connection: any) => { connection.id = 42; }],
		['string port', (connection: any) => { connection.port = '1433'; }],
		['numeric optional database', (connection: any) => { connection.database = 42; }],
	] as const)('rejects a pointerless canonical snapshot with %s', async (_label, mutate) => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sql-connections-primitive-'));
		try {
			const connection = structuredClone(ORIGINAL) as any;
			mutate(connection);
			fs.writeFileSync(path.join(directory, 'sql-connections.v1.json'), JSON.stringify({
				schemaVersion: 1, version: 1, connections: [connection], mutationLeases: {},
			}), 'utf8');
			const harness = createHarness([ORIGINAL], { 'sql.password.sql-1': 'old-password' }, directory);

			await harness.manager.ready();

			expect(harness.manager.getConnections()).toEqual([]);
			expect(fs.readdirSync(directory).some(name => name.startsWith('sql-connections.v1.json.corrupt-'))).toBe(true);
			harness.manager.dispose();
		} finally {
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});

	it('rolls back a valid connection primary left ahead of its commit pointer', async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sql-connections-crash-window-'));
		try {
			const first = createHarness([ORIGINAL], { 'sql.password.sql-1': 'old-password' }, directory);
			await first.manager.ready();
			first.manager.dispose();
			const snapshotPath = path.join(directory, 'sql-connections.v1.json');
			const uncommitted = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
			uncommitted.version += 1;
			uncommitted.connections[0].serverUrl = 'uncommitted.example';
			fs.writeFileSync(snapshotPath, `${JSON.stringify(uncommitted, null, 2)}\n`, 'utf8');

			const second = createHarness([], { 'sql.password.sql-1': 'old-password' }, directory);
			await second.manager.ready();

			expect(second.manager.getConnection('sql-1')).toEqual(ORIGINAL);
			expect(JSON.parse(fs.readFileSync(snapshotPath, 'utf8')).connections).toEqual([ORIGINAL]);
			second.manager.dispose();
		} finally {
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});

	it('does not resurrect a deleted connection from a stale mirror after the primary snapshot disappears', async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sql-connections-missing-'));
		try {
			const first = createHarness([ORIGINAL], { 'sql.password.sql-1': 'old-password' }, directory);
			await first.manager.ready();
			first.globalStateUpdate.mockRejectedValue(new Error('stale mirror'));
			await first.manager.removeConnection('sql-1');
			expect(first.getPersisted()).toEqual([ORIGINAL]);
			first.manager.dispose();
			fs.unlinkSync(path.join(directory, 'sql-connections.v1.json'));

			const second = createHarness([ORIGINAL], {}, directory);
			await second.manager.ready();
			expect(second.manager.getConnections()).toEqual([]);
			expect(JSON.parse(fs.readFileSync(path.join(directory, 'sql-connections.v1.json'), 'utf8')).connections).toEqual([]);
			second.manager.dispose();
		} finally {
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});

	it('keeps an interrupted password edit blocked indefinitely after restart', async () => {
		vi.useFakeTimers();
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sql-password-crash-'));
		try {
			fs.writeFileSync(path.join(directory, 'sql-connections.v1.json'), JSON.stringify({
				schemaVersion: 1,
				version: 4,
				connections: [ORIGINAL],
				mutationLeases: {
					'sql-1': { operationId: 'interrupted-edit', expiresAt: Date.now() + 1000 },
				},
			}), 'utf8');
			const harness = createHarness([ORIGINAL], { 'sql.password.sql-1': 'new-password-for-uncommitted-target' }, directory);
			await harness.manager.ready();

			await expect(harness.manager.getPasswordForConnection(ORIGINAL)).rejects.toThrow('SQL connection is changing');
			await vi.advanceTimersByTimeAsync(10 * 60_000);
			await expect(harness.manager.getPasswordForConnection(ORIGINAL)).rejects.toThrow('SQL connection is changing');
			const persisted = JSON.parse(fs.readFileSync(path.join(directory, 'sql-connections.v1.json'), 'utf8'));
			expect(persisted.mutationLeases['sql-1']).toMatchObject({ failed: true, expiresAt: Number.MAX_SAFE_INTEGER });
			harness.manager.dispose();
		} finally {
			vi.useRealTimers();
			fs.rmSync(directory, { recursive: true, force: true });
		}
	}, 15_000);

	it('never pairs an old connection target with a password being updated', async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sql-credentials-'));
		try {
			const first = createHarness([ORIGINAL], { 'sql.password.sql-1': 'old-password' }, directory);
			const second = createHarness([ORIGINAL], { 'sql.password.sql-1': 'old-password' }, directory);
			await Promise.all([first.manager.ready(), second.manager.ready()]);
			const passwordWrite = deferred<void>();
			const passwordWriteStarted = deferred<void>();
			first.secretStore.mockImplementationOnce(async (key: string, value: string) => {
				first.passwords.set(key, value);
				passwordWriteStarted.resolve();
				await passwordWrite.promise;
			});

			const update = first.manager.updateConnectionAndPassword('sql-1', { serverUrl: 'new.example' }, 'new-password');
			await passwordWriteStarted.promise;
			expect(first.secretStore).toHaveBeenCalledOnce();
			const oldOwnerRead = second.manager.getPasswordForConnection(ORIGINAL);
			let settled = false;
			void oldOwnerRead.finally(() => { settled = true; }).catch(() => undefined);
			await Promise.resolve();
			expect(settled).toBe(false);

			passwordWrite.resolve();
			await update;
			await expect(oldOwnerRead).rejects.toThrow('SQL connection changed');
			first.manager.dispose();
			second.manager.dispose();
		} finally {
			fs.rmSync(directory, { recursive: true, force: true });
		}
	}, 15_000);
});
