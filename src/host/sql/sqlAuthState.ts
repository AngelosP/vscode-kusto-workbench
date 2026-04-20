import * as vscode from 'vscode';

const STORAGE_KEYS = {
	sqlServerAccountMap: 'sql.auth.serverAccountMap',
} as const;

const SECRET_KEYS = {
	sqlTokenOverrideByAccountId: (accountId: string) => `sql.auth.tokenOverride.${accountId}`,
} as const;

const AUTH_PROVIDER_ID = 'microsoft';
const AUTH_SCOPES = ['https://database.windows.net/.default'] as const;

const TEST_ENV_KEYS = {
	serverUrl: 'KUSTO_WORKBENCH_TEST_SQL_AAD_SERVER_URL',
	accountId: 'KUSTO_WORKBENCH_TEST_SQL_AAD_ACCOUNT_ID',
	token: 'KUSTO_WORKBENCH_TEST_SQL_AAD_TOKEN',
} as const;

export type SqlAadTokenResolution = {
	token?: string;
	accountId?: string;
	source: 'env' | 'override' | 'session' | 'none';
};

export function normalizeSqlServerUrl(serverUrl: string | undefined): string {
	return String(serverUrl || '').trim().toLowerCase();
}

export function readSqlServerAccountMap(context: vscode.ExtensionContext): Record<string, string> {
	const raw = context.globalState.get<Record<string, string> | undefined>(STORAGE_KEYS.sqlServerAccountMap);
	if (!raw || typeof raw !== 'object') {
		return {};
	}

	const normalized: Record<string, string> = {};
	for (const [serverUrl, accountId] of Object.entries(raw)) {
		const normalizedServer = normalizeSqlServerUrl(serverUrl);
		const normalizedAccountId = String(accountId || '').trim();
		if (normalizedServer && normalizedAccountId) {
			normalized[normalizedServer] = normalizedAccountId;
		}
	}
	return normalized;
}

export async function setSqlServerAccountMapEntry(
	context: vscode.ExtensionContext,
	serverUrl: string,
	accountId: string,
): Promise<void> {
	const normalizedServer = normalizeSqlServerUrl(serverUrl);
	const normalizedAccountId = String(accountId || '').trim();
	if (!normalizedServer || !normalizedAccountId) {
		return;
	}
	const next = readSqlServerAccountMap(context);
	next[normalizedServer] = normalizedAccountId;
	await context.globalState.update(STORAGE_KEYS.sqlServerAccountMap, next);
}

export async function setSqlTokenOverride(
	context: vscode.ExtensionContext,
	accountId: string,
	token: string,
): Promise<void> {
	const normalizedAccountId = String(accountId || '').trim();
	if (!normalizedAccountId) {
		return;
	}
	await context.secrets.store(SECRET_KEYS.sqlTokenOverrideByAccountId(normalizedAccountId), String(token || ''));
}

export async function clearSqlTokenOverride(
	context: vscode.ExtensionContext,
	accountId: string,
): Promise<void> {
	const normalizedAccountId = String(accountId || '').trim();
	if (!normalizedAccountId) {
		return;
	}
	try {
		await context.secrets.delete(SECRET_KEYS.sqlTokenOverrideByAccountId(normalizedAccountId));
	} catch {
		// ignore
	}
}

export async function getSqlTokenOverride(
	context: vscode.ExtensionContext,
	accountId: string,
): Promise<string | undefined> {
	const normalizedAccountId = String(accountId || '').trim();
	if (!normalizedAccountId) {
		return undefined;
	}
	try {
		const token = await context.secrets.get(SECRET_KEYS.sqlTokenOverrideByAccountId(normalizedAccountId));
		return token && token.trim() ? token.trim() : undefined;
	} catch {
		return undefined;
	}
}

function readEnvOverride(serverUrl: string): SqlAadTokenResolution {
	const token = String(process.env[TEST_ENV_KEYS.token] || '').trim();
	if (!token) {
		return { source: 'none' };
	}

	const expectedServer = normalizeSqlServerUrl(process.env[TEST_ENV_KEYS.serverUrl]);
	if (expectedServer && expectedServer !== serverUrl) {
		return { source: 'none' };
	}

	const accountId = String(process.env[TEST_ENV_KEYS.accountId] || '').trim() || undefined;
	return { token, accountId, source: 'env' };
}

export async function resolveSqlAadAccessToken(
	context: vscode.ExtensionContext,
	serverUrl: string,
): Promise<SqlAadTokenResolution> {
	const normalizedServer = normalizeSqlServerUrl(serverUrl);

	const envOverride = readEnvOverride(normalizedServer);
	if (envOverride.token) {
		if (normalizedServer && envOverride.accountId) {
			await setSqlServerAccountMapEntry(context, normalizedServer, envOverride.accountId);
		}
		return envOverride;
	}

	const serverAccountMap = readSqlServerAccountMap(context);
	const accountId = normalizedServer ? serverAccountMap[normalizedServer] : undefined;
	if (accountId) {
		const overrideToken = await getSqlTokenOverride(context, accountId);
		if (overrideToken) {
			return { token: overrideToken, accountId, source: 'override' };
		}
	}

	const session = await vscode.authentication.getSession(
		AUTH_PROVIDER_ID,
		[...AUTH_SCOPES],
		{ createIfNone: true },
	);
	if (!session) {
		return { source: 'none' };
	}
	if (normalizedServer && session.account?.id) {
		await setSqlServerAccountMapEntry(context, normalizedServer, session.account.id);
	}
	return {
		token: session.accessToken,
		accountId: session.account?.id,
		source: 'session',
	};
}