import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authentication } from 'vscode';
import { buildStsConnectionOptions, formatStsServerName } from '../../../src/host/sql/stsConnectionOptions';

const connectionManager = {
	assertConnectionCurrent: vi.fn(async () => undefined),
	getPasswordForConnection: vi.fn(),
} as any;
const context = {
	globalState: { get: vi.fn(), update: vi.fn().mockResolvedValue(undefined) },
	secrets: { get: vi.fn(), store: vi.fn().mockResolvedValue(undefined), delete: vi.fn().mockResolvedValue(undefined) },
} as any;

describe('STS connection options', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		delete process.env.KUSTO_WORKBENCH_TEST_SQL_AAD_TOKEN;
		connectionManager.getPasswordForConnection.mockResolvedValue('secret-password');
	});

	it('formats explicit ports once', () => {
		expect(formatStsServerName('server.example', 1444)).toBe('server.example,1444');
		expect(formatStsServerName('server.example,1444', 1444)).toBe('server.example,1444');
	});

	it('builds strict data-plane SQL Login options', async () => {
		const { options } = await buildStsConnectionOptions({
			connection: { id: 'sql-1', name: 'SQL', dialect: 'mssql', serverUrl: 'server.example', port: 1444, authType: 'sql-login', username: 'user' },
			database: 'Db', connectionManager, context, purpose: 'data', commandTimeoutSeconds: 1200,
		});

		expect(options).toEqual({
			server: 'server.example,1444', database: 'Db', authenticationType: 'SqlLogin',
			encrypt: 'Mandatory', trustServerCertificate: false, connectTimeout: 30,
			commandTimeout: 1200, user: 'user', password: 'secret-password',
		});
	});

	it('uses an operation-scoped password without reading saved credentials', async () => {
		connectionManager.getPasswordForConnection.mockResolvedValue(undefined);
		const { options } = await buildStsConnectionOptions({
			connection: { id: 'sql-1', name: 'SQL', dialect: 'mssql', serverUrl: 'server.example', authType: 'sql-login', username: 'user' },
			database: 'Db', connectionManager, context, purpose: 'data', passwordOverride: 'draft-password',
		});

		expect(options.password).toBe('draft-password');
		expect(connectionManager.getPasswordForConnection).not.toHaveBeenCalled();
	});

	it('preserves the existing permissive language certificate policy', async () => {
		const { options } = await buildStsConnectionOptions({
			connection: { id: 'sql-1', name: 'SQL', dialect: 'mssql', serverUrl: 'server.example', authType: 'sql-login', username: 'user' },
			database: 'Db', connectionManager, context, purpose: 'language',
		});
		expect(options.trustServerCertificate).toBe(true);
		expect(options.connectTimeout).toBe(15);
	});

	it('uses an AAD access token without exposing it in other fields', async () => {
		vi.spyOn(authentication, 'getSession').mockResolvedValue({ accessToken: 'aad-token', account: { id: 'account', label: 'Account' } } as any);
		const built = await buildStsConnectionOptions({
			connection: { id: 'sql-1', name: 'SQL', dialect: 'mssql', serverUrl: 'server.example', authType: 'aad' },
			database: 'Db', connectionManager, context, purpose: 'data',
		});
		expect(built.options.azureAccountToken).toBe('aad-token');
		expect(built.options).not.toHaveProperty('password');
		expect(built.aadAccountId).toBe('account');
	});

	it('fails clearly when a SQL Login password is missing', async () => {
		connectionManager.getPasswordForConnection.mockResolvedValue(undefined);
		await expect(buildStsConnectionOptions({
			connection: { id: 'sql-1', name: 'SQL', dialect: 'mssql', serverUrl: 'server.example', authType: 'sql-login', username: 'user' },
			database: 'Db', connectionManager, context, purpose: 'data',
		})).rejects.toThrow('Password not found');
	});

	it('rejects a blank SQL Login username before returning STS options', async () => {
		await expect(buildStsConnectionOptions({
			connection: { id: 'sql-1', name: 'SQL', dialect: 'mssql', serverUrl: 'server.example', authType: 'sql-login', username: ' ' },
			database: 'Db', connectionManager, context, purpose: 'data',
		})).rejects.toThrow('Username not found');
	});
});