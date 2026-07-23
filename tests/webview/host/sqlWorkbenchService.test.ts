import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import { SqlWorkbenchService } from '../../../src/host/sql/sqlWorkbenchService';
import { sqlSchemaPrincipalFingerprintForPrincipal } from '../../../src/host/sqlEditorSchema';
import { setSqlServerAccountMapEntry } from '../../../src/host/sql/sqlAuthState';
import { SqlLeaveNoTracePolicyStore } from '../../../src/host/sql/sqlLeaveNoTracePolicyStore';
import { withSqlStateFileLock } from '../../../src/host/sql/sqlStateTransaction';

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>(res => { resolve = res; });
	return { promise, resolve };
}

describe('SqlWorkbenchService global privacy recovery', () => {
	it('admits first-AAD pending ownership only before a canonical account mapping exists', async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sql-first-aad-composite-'));
		const connection = { id: 'sql-a', name: 'AAD', dialect: 'mssql', serverUrl: 'aad.example', authType: 'aad' };
		const values = new Map<string, unknown>([['sql.connections', [connection]]]);
		const context = {
			globalStorageUri: vscode.Uri.file(directory), logUri: vscode.Uri.file(path.join(directory, 'logs')),
			globalState: { get: vi.fn((key: string) => values.get(key)), update: vi.fn(async (key: string, value: unknown) => { values.set(key, value); }) },
			secrets: { get: vi.fn(async () => undefined), store: vi.fn(async () => undefined), delete: vi.fn(async () => undefined) },
		} as any;
		const service = new SqlWorkbenchService(context, { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any);
		try {
			await service.ready();
			const captured = service.connectionManager.getConnection(connection.id)!;

			await expect(service.dispatchCurrentSqlOwnerAllowed(captured, 'aad-pending', () => 'didOpen'))
				.resolves.toBe('didOpen');
			await setSqlServerAccountMapEntry(context, connection.serverUrl, 'account-a');
			await expect(service.dispatchCurrentSqlOwnerAllowed(captured, 'aad-pending', () => 'stale'))
				.rejects.toThrow('principal changed');
			const fingerprint = sqlSchemaPrincipalFingerprintForPrincipal(captured, 'account-a')!;
			await expect(service.dispatchCurrentSqlOwnerAllowed(captured, fingerprint, () => 'connected'))
				.resolves.toBe('connected');
		} finally {
			await service.dispose();
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});

	it('publishes affected connections when the first AAD principal is established', async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sql-first-aad-event-'));
		const connection = { id: 'sql-a', name: 'AAD', dialect: 'mssql', serverUrl: 'aad.example', authType: 'aad' };
		const values = new Map<string, unknown>([['sql.connections', [connection]]]);
		const context = {
			globalStorageUri: vscode.Uri.file(directory), logUri: vscode.Uri.file(path.join(directory, 'logs')),
			globalState: { get: vi.fn((key: string) => values.get(key)), update: vi.fn(async (key: string, value: unknown) => { values.set(key, value); }) },
			secrets: { get: vi.fn(async () => undefined), store: vi.fn(async () => undefined), delete: vi.fn(async () => undefined) },
		} as any;
		const service = new SqlWorkbenchService(context, { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any);
		try {
			await service.ready();
			const changes: any[] = [];
			service.onDidChangeSqlPrincipals(change => changes.push(change));
			const cancelConnection = vi.spyOn(service.queryService, 'cancelConnection').mockResolvedValue(undefined);

			await setSqlServerAccountMapEntry(context, connection.serverUrl, 'account-a');
			await service.serverAccountMap.refresh();

			expect(changes).toEqual([expect.objectContaining({
				serverUrls: ['aad.example'], connectionIds: ['sql-a'],
			})]);
			expect(cancelConnection).not.toHaveBeenCalled();
		} finally {
			await service.dispose();
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});

	it('cancels work after a cross-window LNT enable-disable transition coalesces before refresh', async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sql-workbench-coalesced-lnt-'));
		const values = new Map<string, unknown>([['sql.connections', [{
			id: 'sql-a', name: 'A', dialect: 'mssql', serverUrl: 'a.example', authType: 'sql-login', username: 'user',
		}]]]);
		const createContext = () => ({
			globalStorageUri: vscode.Uri.file(directory), logUri: vscode.Uri.file(path.join(directory, 'logs')),
			globalState: { get: vi.fn((key: string) => values.get(key)), update: vi.fn(async (key: string, value: unknown) => { values.set(key, value); }) },
			secrets: { get: vi.fn(async () => 'password'), store: vi.fn(async () => undefined), delete: vi.fn(async () => undefined) },
		}) as any;
		const output = { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;
		const service = new SqlWorkbenchService(createContext(), output);
		const other = new SqlLeaveNoTracePolicyStore(createContext(), output);
		try {
			await Promise.all([service.ready(), other.refresh()]);
			const cancelConnection = vi.spyOn(service.queryService, 'cancelConnection').mockResolvedValue(undefined);

			await other.setConnection('sql-a', true);
			await other.setConnection('sql-a', false);
			await service.refreshLeaveNoTracePolicy();

			expect(service.getLeaveNoTraceConnectionIds()).toEqual([]);
			expect(cancelConnection).toHaveBeenCalledWith('sql-a');
		} finally {
			other.dispose();
			await service.dispose();
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});

	it.each(['target', 'principal'] as const)('rejects composite dispatch after a canonical %s change commits', async change => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), `kw-sql-composite-${change}-`));
		const connection = {
			id: 'sql-a', name: 'A', dialect: 'mssql', serverUrl: 'a.example',
			authType: change === 'principal' ? 'aad' : 'sql-login',
			...(change === 'target' ? { username: 'user' } : {}),
		};
		const values = new Map<string, unknown>([['sql.connections', [connection]]]);
		const passwords = new Map([['sql.password.sql-a', 'old-password']]);
		const context = {
			globalStorageUri: vscode.Uri.file(directory), logUri: vscode.Uri.file(path.join(directory, 'logs')),
			globalState: {
				get: vi.fn((key: string) => values.get(key)),
				update: vi.fn(async (key: string, value: unknown) => { values.set(key, value); }),
			},
			secrets: {
				get: vi.fn(async (key: string) => passwords.get(key)),
				store: vi.fn(async (key: string, value: string) => { passwords.set(key, value); }),
				delete: vi.fn(async (key: string) => { passwords.delete(key); }),
			},
		} as any;
		const service = new SqlWorkbenchService(context, { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any);
		const dispatch = vi.fn(() => 'published');
		try {
			await service.ready();
			if (change === 'principal') await setSqlServerAccountMapEntry(context, connection.serverUrl, 'account-a');
			const captured = service.connectionManager.getConnection(connection.id)!;
			const capturedPrincipal = sqlSchemaPrincipalFingerprintForPrincipal(captured, change === 'principal' ? 'account-a' : 'user')!;
			if (change === 'target') {
				await service.connectionManager.updateConnectionAndPassword(connection.id, { serverUrl: 'b.example' }, 'new-password');
			} else {
				await setSqlServerAccountMapEntry(context, connection.serverUrl, 'account-b');
			}

			await expect(service.dispatchCurrentSqlOwnerAllowed(captured, capturedPrincipal, dispatch)).rejects.toThrow(/changed|current/i);
			expect(dispatch).not.toHaveBeenCalled();
		} finally {
			await service.dispose();
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});

	it('releases composite owner locks after callback start and before remote settlement', async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sql-composite-release-'));
		const connection = { id: 'sql-a', name: 'A', dialect: 'mssql', serverUrl: 'a.example', authType: 'sql-login', username: 'user' };
		const values = new Map<string, unknown>([['sql.connections', [connection]]]);
		const passwords = new Map([['sql.password.sql-a', 'old-password']]);
		const context = {
			globalStorageUri: vscode.Uri.file(directory), logUri: vscode.Uri.file(path.join(directory, 'logs')),
			globalState: { get: vi.fn((key: string) => values.get(key)), update: vi.fn(async (key: string, value: unknown) => { values.set(key, value); }) },
			secrets: {
				get: vi.fn(async (key: string) => passwords.get(key)),
				store: vi.fn(async (key: string, value: string) => { passwords.set(key, value); }),
				delete: vi.fn(async (key: string) => { passwords.delete(key); }),
			},
		} as any;
		const service = new SqlWorkbenchService(context, { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any);
		const remote = deferred<string>();
		const started = vi.fn(() => remote.promise);
		try {
			await service.ready();
			const captured = service.connectionManager.getConnection(connection.id)!;
			const principal = sqlSchemaPrincipalFingerprintForPrincipal(captured, 'user')!;
			const publication = service.dispatchCurrentSqlOwnerAllowed(captured, principal, started);
			await vi.waitFor(() => expect(started).toHaveBeenCalledOnce());

			await service.connectionManager.updateConnectionAndPassword(connection.id, { serverUrl: 'b.example' }, 'new-password');
			remote.resolve('done');

			await expect(publication).resolves.toBe('done');
		} finally {
			await service.dispose();
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});

	it('does not hold outer owner locks while waiting for a busy inner snapshot lock', async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sql-composite-preflight-'));
		const connection = { id: 'sql-a', name: 'A', dialect: 'mssql', serverUrl: 'a.example', authType: 'sql-login', username: 'user' };
		const values = new Map<string, unknown>([['sql.connections', [connection]]]);
		const context = {
			globalStorageUri: vscode.Uri.file(directory), logUri: vscode.Uri.file(path.join(directory, 'logs')),
			globalState: { get: vi.fn((key: string) => values.get(key)), update: vi.fn(async (key: string, value: unknown) => { values.set(key, value); }) },
			secrets: { get: vi.fn(async () => 'password'), store: vi.fn(async () => undefined), delete: vi.fn(async () => undefined) },
		} as any;
		const service = new SqlWorkbenchService(context, { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any);
		const releaseAccountLock = deferred<void>();
		const accountLockEntered = deferred<void>();
		let accountLock: Promise<void> | undefined;
		try {
			await service.ready();
			accountLock = withSqlStateFileLock(
				path.join(directory, 'sql-server-account-map.v1.json.write'),
				async () => { accountLockEntered.resolve(); await releaseAccountLock.promise; },
			);
			await accountLockEntered.promise;
			const snapshot = service.dispatchSqlOwnerSnapshot(value => value);

			await expect(service.leaveNoTracePolicy.setConnection('sql-a', true)).resolves.toBeUndefined();
			releaseAccountLock.resolve();
			await accountLock;
			await expect(snapshot).resolves.toEqual(expect.objectContaining({
				connections: [expect.objectContaining({ id: 'sql-a' })],
			}));

			const callbackError = Object.assign(new Error('callback failure'), { code: 'ELOCKED' });
			const callback = vi.fn(async () => { throw callbackError; });
			await expect(service.runWithSqlOwnerSnapshotLock(callback)).rejects.toBe(callbackError);
			expect(callback).toHaveBeenCalledOnce();
		} finally {
			releaseAccountLock.resolve();
			await accountLock?.catch(() => undefined);
			await service.dispose();
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});

	it('cancels active STS ownership after a password-only credential rotation', async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sql-workbench-password-'));
		const values = new Map<string, unknown>([[
			'sql.connections', [{
				id: 'sql-a', name: 'A', dialect: 'mssql', serverUrl: 'a.example',
				authType: 'sql-login', username: 'user',
			}],
		]]);
		const passwords = new Map([['sql.password.sql-a', 'old-password']]);
		const context = {
			globalStorageUri: vscode.Uri.file(directory),
			logUri: vscode.Uri.file(path.join(directory, 'logs')),
			globalState: {
				get: vi.fn((key: string) => values.get(key)),
				update: vi.fn(async (key: string, value: unknown) => { values.set(key, value); }),
			},
			secrets: {
				get: vi.fn(async (key: string) => passwords.get(key)),
				store: vi.fn(async (key: string, value: string) => { passwords.set(key, value); }),
				delete: vi.fn(async (key: string) => { passwords.delete(key); }),
			},
		} as any;
		const output = { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;
		const service = new SqlWorkbenchService(context, output);
		const changes: any[] = [];
		service.onDidChangeSqlConnections(change => changes.push(change));
		try {
			await service.ready();
			const cancelConnection = vi.spyOn(service.queryService, 'cancelConnection').mockResolvedValue(undefined);

			await service.connectionManager.updateConnectionAndPassword('sql-a', {}, 'new-password');

			expect(service.connectionManager.getConnection('sql-a')).toEqual(expect.objectContaining({ credentialRevision: 1 }));
			expect(passwords.get('sql.password.sql-a')).toBe('new-password');
			expect(cancelConnection).toHaveBeenCalledWith('sql-a');
			expect(changes).toContainEqual(expect.objectContaining({ connectionIds: ['sql-a'] }));
		} finally {
			await service.dispose();
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});

	it('protects every connection and cancels active work when policy recovery blocks globally', async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sql-workbench-global-block-'));
		const values = new Map<string, unknown>([
			['sql.connections', [
				{ id: 'sql-a', name: 'A', dialect: 'mssql', serverUrl: 'a.example', authType: 'aad' },
				{ id: 'sql-b', name: 'B', dialect: 'mssql', serverUrl: 'b.example', authType: 'aad' },
			]],
			['sql.leaveNoTraceConnections', []],
		]);
		const context = {
			globalStorageUri: vscode.Uri.file(directory),
			logUri: vscode.Uri.file(path.join(directory, 'logs')),
			globalState: {
				get: vi.fn((key: string) => values.get(key)),
				update: vi.fn(async (key: string, value: unknown) => { values.set(key, value); }),
			},
			secrets: {
				get: vi.fn(async () => undefined), store: vi.fn(async () => undefined), delete: vi.fn(async () => undefined),
			},
		} as any;
		const output = { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;
		const service = new SqlWorkbenchService(context, output);
		const changes: any[] = [];
		service.onDidChangeLeaveNoTrace(change => changes.push(change));
		try {
			await service.ready();
			const cancelConnection = vi.spyOn(service.queryService, 'cancelConnection').mockResolvedValue(undefined);
			for (const fileName of [
				'sql-leave-no-trace-policy.v1.json',
				'sql-leave-no-trace-policy.backup.v1.json',
				'sql-leave-no-trace-policy.commit.v1.json',
			]) fs.rmSync(path.join(directory, fileName), { force: true });

			await service.refreshLeaveNoTracePolicy();

			expect(service.getLeaveNoTraceConnectionIds().sort()).toEqual(['sql-a', 'sql-b']);
			expect(changes).toContainEqual(expect.objectContaining({
				globallyBlocked: true,
				connectionIds: expect.arrayContaining(['sql-a', 'sql-b']),
				enabledConnectionIds: expect.arrayContaining(['sql-a', 'sql-b']),
			}));
			expect(cancelConnection).toHaveBeenCalledWith('sql-a');
			expect(cancelConnection).toHaveBeenCalledWith('sql-b');
		} finally {
			await service.dispose();
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});
});