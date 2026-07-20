import * as vscode from 'vscode';
import type { SqlConnection, SqlConnectionManager } from '../sqlConnectionManager';
import { SqlQueryCancelledError, SqlQueryExecutionError } from './sqlErrors';
import { resolveSqlAadAccessToken } from './sqlAuthState';
import type { StsConnectionOptions } from './stsProtocol';

export type StsConnectionPurpose = 'language' | 'data';

export interface BuildStsConnectionOptionsInput {
	connection: SqlConnection;
	database: string;
	connectionManager: SqlConnectionManager;
	context: vscode.ExtensionContext;
	purpose: StsConnectionPurpose;
	commandTimeoutSeconds?: number;
	passwordOverride?: string;
	allowUncommittedTarget?: boolean;
}

export interface BuiltStsConnectionOptions {
	options: StsConnectionOptions;
	aadAccountId?: string;
}

export function formatStsServerName(serverUrl: string, port?: number): string {
	const server = String(serverUrl || '').trim();
	if (!server || !port || /,\s*\d+\s*$/.test(server)) return server;
	return `${server},${port}`;
}

export async function buildStsConnectionOptions(input: BuildStsConnectionOptionsInput): Promise<BuiltStsConnectionOptions> {
	const { connection, connectionManager, context, purpose } = input;
	if (!input.allowUncommittedTarget) await connectionManager.assertConnectionCurrent(connection);
	if (input.allowUncommittedTarget && connection.authType !== 'aad' && input.passwordOverride === undefined) {
		throw new SqlQueryExecutionError('A password is required to test a changed SQL Login target.');
	}
	const options: StsConnectionOptions = {
		server: formatStsServerName(connection.serverUrl, connection.port),
		database: String(input.database || connection.database || '').trim(),
		authenticationType: connection.authType === 'aad' ? 'AzureMFA' : 'SqlLogin',
		encrypt: 'Mandatory',
		trustServerCertificate: purpose === 'language',
		connectTimeout: purpose === 'language' ? 15 : 30,
		...(typeof input.commandTimeoutSeconds === 'number'
			? { commandTimeout: Math.max(0, Math.floor(input.commandTimeoutSeconds)) }
			: {}),
	};

	if (connection.authType === 'aad') {
		const resolved = await resolveSqlAadAccessToken(context, connection.serverUrl);
		if (!resolved.token || !resolved.accountId) throw new SqlQueryCancelledError('Sign-in cancelled');
		options.azureAccountToken = resolved.token;
		if (!input.allowUncommittedTarget) await connectionManager.assertConnectionCurrent(connection);
		return { options, aadAccountId: resolved.accountId };
	} else {
		const password = input.passwordOverride !== undefined
			? input.passwordOverride
			: await connectionManager.getPasswordForConnection(connection);
		if (!password) {
			throw new SqlQueryExecutionError('Password not found. Please re-enter your password for this connection.');
		}
		const username = String(connection.username || '').trim();
		if (!username) {
			throw new SqlQueryExecutionError('Username not found. Please enter a username for this SQL Login connection.');
		}
		options.user = username;
		options.password = password;
	}

	if (!input.allowUncommittedTarget) await connectionManager.assertConnectionCurrent(connection);
	return { options };
}