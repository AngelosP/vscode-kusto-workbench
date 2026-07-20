import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import {
	clearSqlTokenOverride,
	deleteSqlServerAccountMapEntry,
	readSqlServerAccountMap,
	resolveSqlAadAccessToken,
	setSqlServerAccountMapEntry,
	setSqlTokenOverride,
} from '../../../src/host/sql/sqlAuthState';
import { readCurrentSqlServerAccountMap } from '../../../src/host/sql/sqlServerAccountMapStore';

const tempDirectories: string[] = [];

function createMockContext(globalStorageDirectory?: string): any {
	const globalStateStore = new Map<string, unknown>();
	const secretStore = new Map<string, string>();
	return {
		...(globalStorageDirectory ? { globalStorageUri: vscode.Uri.file(globalStorageDirectory) } : {}),
		globalState: {
			get: <T>(key: string, fallback?: T) => globalStateStore.has(key) ? globalStateStore.get(key) as T : fallback,
			update: vi.fn(async (key: string, value: unknown) => {
				if (value === undefined) {
					globalStateStore.delete(key);
				} else {
					globalStateStore.set(key, value);
				}
			}),
		},
		secrets: {
			get: vi.fn(async (key: string) => secretStore.get(key)),
			store: vi.fn(async (key: string, value: string) => {
				secretStore.set(key, value);
			}),
			delete: vi.fn(async (key: string) => {
				secretStore.delete(key);
			}),
		},
	};
}

describe('sqlAuthState', () => {
	const originalEnv = {
		serverUrl: process.env.KUSTO_WORKBENCH_TEST_SQL_AAD_SERVER_URL,
		accountId: process.env.KUSTO_WORKBENCH_TEST_SQL_AAD_ACCOUNT_ID,
		token: process.env.KUSTO_WORKBENCH_TEST_SQL_AAD_TOKEN,
	};

	beforeEach(() => {
		vi.restoreAllMocks();
		delete process.env.KUSTO_WORKBENCH_TEST_SQL_AAD_SERVER_URL;
		delete process.env.KUSTO_WORKBENCH_TEST_SQL_AAD_ACCOUNT_ID;
		delete process.env.KUSTO_WORKBENCH_TEST_SQL_AAD_TOKEN;
		vi.spyOn(vscode.authentication, 'getSession').mockResolvedValue(undefined as any);
	});

	afterEach(() => {
		for (const directory of tempDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
		if (originalEnv.serverUrl === undefined) delete process.env.KUSTO_WORKBENCH_TEST_SQL_AAD_SERVER_URL;
		else process.env.KUSTO_WORKBENCH_TEST_SQL_AAD_SERVER_URL = originalEnv.serverUrl;
		if (originalEnv.accountId === undefined) delete process.env.KUSTO_WORKBENCH_TEST_SQL_AAD_ACCOUNT_ID;
		else process.env.KUSTO_WORKBENCH_TEST_SQL_AAD_ACCOUNT_ID = originalEnv.accountId;
		if (originalEnv.token === undefined) delete process.env.KUSTO_WORKBENCH_TEST_SQL_AAD_TOKEN;
		else process.env.KUSTO_WORKBENCH_TEST_SQL_AAD_TOKEN = originalEnv.token;
	});

	it('returns a stored override token for a mapped server without interactive auth', async () => {
		const context = createMockContext();
		await setSqlServerAccountMapEntry(context, 'MyServer.database.windows.net', 'acct-1');
		await setSqlTokenOverride(context, 'acct-1', 'override-token');

		const resolved = await resolveSqlAadAccessToken(context, 'myserver.database.windows.net');

		expect(resolved).toEqual({ token: 'override-token', accountId: 'acct-1', source: 'override' });
		expect(vscode.authentication.getSession).not.toHaveBeenCalled();
		expect(readSqlServerAccountMap(context)).toEqual({ 'myserver.database.windows.net': 'acct-1' });
	});

	it('returns the matching env override token before interactive auth', async () => {
		const context = createMockContext();
		process.env.KUSTO_WORKBENCH_TEST_SQL_AAD_SERVER_URL = 'envserver.database.windows.net';
		process.env.KUSTO_WORKBENCH_TEST_SQL_AAD_ACCOUNT_ID = 'env-account';
		process.env.KUSTO_WORKBENCH_TEST_SQL_AAD_TOKEN = 'env-token';

		const resolved = await resolveSqlAadAccessToken(context, 'EnvServer.database.windows.net');

		expect(resolved).toEqual({ token: 'env-token', accountId: 'env-account', source: 'env' });
		expect(vscode.authentication.getSession).not.toHaveBeenCalled();
		expect(readSqlServerAccountMap(context)).toEqual({ 'envserver.database.windows.net': 'env-account' });
	});

	it('falls back to an interactive session and records the server/account mapping', async () => {
		const context = createMockContext();
		vi.spyOn(vscode.authentication, 'getSession').mockResolvedValue({
			accessToken: 'session-token',
			account: { id: 'session-account', label: 'user@example.com' },
		} as any);

		const resolved = await resolveSqlAadAccessToken(context, 'live.database.windows.net');

		expect(resolved).toEqual({ token: 'session-token', accountId: 'session-account', source: 'session' });
		expect(readSqlServerAccountMap(context)).toEqual({ 'live.database.windows.net': 'session-account' });
	});

	it('rejects a session that differs from the established canonical account', async () => {
		const context = createMockContext();
		await setSqlServerAccountMapEntry(context, 'live.database.windows.net', 'account-a');
		vi.spyOn(vscode.authentication, 'getSession').mockResolvedValue({
			accessToken: 'account-b-token', account: { id: 'account-b', label: 'Account B' },
		} as any);

		await expect(resolveSqlAadAccessToken(context, 'live.database.windows.net'))
			.rejects.toThrow('principal changed');

		expect(vscode.authentication.getSession).toHaveBeenCalledWith(
			'microsoft', expect.any(Array),
			expect.objectContaining({ account: { id: 'account-a', label: 'account-a' } }),
		);
		expect(readSqlServerAccountMap(context)).toEqual({ 'live.database.windows.net': 'account-a' });
	});

	it('rejects a first-session candidate that loses concurrent canonical adoption', async () => {
		const context = createMockContext();
		let resolveSession!: (session: any) => void;
		vi.spyOn(vscode.authentication, 'getSession').mockImplementation(() => new Promise(resolve => {
			resolveSession = resolve;
		}));

		const resolving = resolveSqlAadAccessToken(context, 'live.database.windows.net');
		await vi.waitFor(() => expect(vscode.authentication.getSession).toHaveBeenCalled());
		await setSqlServerAccountMapEntry(context, 'live.database.windows.net', 'account-a');
		resolveSession({ accessToken: 'account-b-token', account: { id: 'account-b', label: 'Account B' } });

		await expect(resolving).rejects.toThrow('principal changed');
		expect(readSqlServerAccountMap(context)).toEqual({ 'live.database.windows.net': 'account-a' });
	});

	it('rejects an established session when another context rotates the canonical account during sign-in', async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sql-auth-rotation-'));
		tempDirectories.push(directory);
		const resolvingContext = createMockContext(directory);
		const rotatingContext = createMockContext(directory);
		await setSqlServerAccountMapEntry(resolvingContext, 'live.database.windows.net', 'account-a');
		let resolveSession!: (session: any) => void;
		vi.spyOn(vscode.authentication, 'getSession').mockImplementation(() => new Promise(resolve => {
			resolveSession = resolve;
		}));

		const resolving = resolveSqlAadAccessToken(resolvingContext, 'live.database.windows.net');
		await vi.waitFor(() => expect(vscode.authentication.getSession).toHaveBeenCalled());
		await setSqlServerAccountMapEntry(rotatingContext, 'live.database.windows.net', 'account-b');
		resolveSession({ accessToken: 'account-a-token', account: { id: 'account-a', label: 'Account A' } });

		await expect(resolving).rejects.toThrow('principal changed');
		expect(await readCurrentSqlServerAccountMap(resolvingContext)).toEqual({
			'live.database.windows.net': 'account-b',
		});
	});

	it('rejects an established session when another context removes the canonical account during sign-in', async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sql-auth-removal-'));
		tempDirectories.push(directory);
		const resolvingContext = createMockContext(directory);
		const removingContext = createMockContext(directory);
		await setSqlServerAccountMapEntry(resolvingContext, 'live.database.windows.net', 'account-a');
		let resolveSession!: (session: any) => void;
		vi.spyOn(vscode.authentication, 'getSession').mockImplementation(() => new Promise(resolve => {
			resolveSession = resolve;
		}));

		const resolving = resolveSqlAadAccessToken(resolvingContext, 'live.database.windows.net');
		await vi.waitFor(() => expect(vscode.authentication.getSession).toHaveBeenCalled());
		await deleteSqlServerAccountMapEntry(removingContext, 'live.database.windows.net');
		resolveSession({ accessToken: 'account-a-token', account: { id: 'account-a', label: 'Account A' } });

		await expect(resolving).rejects.toThrow('principal changed');
		expect(await readCurrentSqlServerAccountMap(resolvingContext)).toEqual({});
	});

	it('clears a stored override token', async () => {
		const context = createMockContext();
		await setSqlTokenOverride(context, 'acct-1', 'override-token');
		await clearSqlTokenOverride(context, 'acct-1');

		const resolved = await resolveSqlAadAccessToken(context, 'unmapped.database.windows.net');

		expect(vscode.authentication.getSession).toHaveBeenCalled();
		expect(resolved).toEqual({ source: 'none' });
	});
});