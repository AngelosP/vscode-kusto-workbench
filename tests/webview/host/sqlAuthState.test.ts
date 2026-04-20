import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import {
	clearSqlTokenOverride,
	readSqlServerAccountMap,
	resolveSqlAadAccessToken,
	setSqlServerAccountMapEntry,
	setSqlTokenOverride,
} from '../../../src/host/sql/sqlAuthState';

function createMockContext(): any {
	const globalStateStore = new Map<string, unknown>();
	const secretStore = new Map<string, string>();
	return {
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

	it('clears a stored override token', async () => {
		const context = createMockContext();
		await setSqlTokenOverride(context, 'acct-1', 'override-token');
		await clearSqlTokenOverride(context, 'acct-1');

		const resolved = await resolveSqlAadAccessToken(context, 'unmapped.database.windows.net');

		expect(vscode.authentication.getSession).toHaveBeenCalled();
		expect(resolved).toEqual({ source: 'none' });
	});
});