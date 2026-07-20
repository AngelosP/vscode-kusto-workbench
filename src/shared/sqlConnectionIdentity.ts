import { sha256Hex } from './sha256';

export interface SqlConnectionTargetIdentity {
	dialect?: string;
	serverUrl?: string;
	port?: number;
	database?: string;
	authType?: string;
	username?: string;
	credentialRevision?: number;
}

export function sqlConnectionServerSignature(connection: SqlConnectionTargetIdentity): string {
	const server = String(connection.serverUrl || '').trim().toLowerCase();
	if (!server || /,\s*\d+\s*$/.test(server)) return server;
	const explicitPort = typeof connection.port === 'number' && Number.isFinite(connection.port) && connection.port > 0
		? connection.port
		: undefined;
	if (server.includes('\\')) return explicitPort ? `${server},${explicitPort}` : server;
	const effectivePort = explicitPort ?? (String(connection.dialect || '').trim().toLowerCase() === 'mssql' ? 1433 : undefined);
	return effectivePort ? `${server},${effectivePort}` : server;
}

export function sqlConnectionTargetSignature(connection: SqlConnectionTargetIdentity): string {
	const material = JSON.stringify({
		dialect: String(connection.dialect || '').trim().toLowerCase(),
		server: sqlConnectionServerSignature(connection),
		database: String(connection.database || '').trim(),
		authType: String(connection.authType || '').trim().toLowerCase(),
		username: String(connection.username || '').trim(),
		credentialRevision: Number.isSafeInteger(connection.credentialRevision) && Number(connection.credentialRevision) > 0
			? Number(connection.credentialRevision)
			: 0,
	});
	return `v2:${sha256Hex(material)}`;
}

export function legacySqlConnectionTargetSignature(connection: SqlConnectionTargetIdentity): string {
	return JSON.stringify({
		dialect: String(connection.dialect || '').trim().toLowerCase(),
		serverUrl: String(connection.serverUrl || '').trim().toLowerCase(),
		port: connection.port || '',
		database: String(connection.database || '').trim(),
		authType: String(connection.authType || '').trim().toLowerCase(),
		username: String(connection.username || '').trim(),
	});
}

function parseLegacySqlConnectionTargetSignature(signature: string): SqlConnectionTargetIdentity | undefined {
	try {
		const parsed = JSON.parse(signature) as Record<string, unknown>;
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
		const expectedKeys = ['authType', 'database', 'dialect', 'port', 'serverUrl', 'username'];
		if (Object.keys(parsed).sort().join('\n') !== expectedKeys.join('\n')) return undefined;
		if (typeof parsed.dialect !== 'string'
			|| typeof parsed.serverUrl !== 'string'
			|| typeof parsed.database !== 'string'
			|| typeof parsed.authType !== 'string'
			|| typeof parsed.username !== 'string') return undefined;
		if (parsed.port !== '' && (typeof parsed.port !== 'number' || !Number.isFinite(parsed.port) || parsed.port <= 0)) return undefined;
		return {
			dialect: parsed.dialect,
			serverUrl: parsed.serverUrl,
			...(typeof parsed.port === 'number' ? { port: parsed.port } : {}),
			database: parsed.database,
			authType: parsed.authType,
			username: parsed.username,
		};
	} catch {
		return undefined;
	}
}

function parseVersionOneSqlConnectionTargetSignature(signature: string): SqlConnectionTargetIdentity | undefined {
	try {
		const parsed = JSON.parse(signature) as Record<string, unknown>;
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
		const expectedKeys = ['authType', 'credentialRevision', 'database', 'dialect', 'server', 'username'];
		if (Object.keys(parsed).sort().join('\n') !== expectedKeys.join('\n')) return undefined;
		if (typeof parsed.dialect !== 'string' || typeof parsed.server !== 'string'
			|| typeof parsed.database !== 'string' || typeof parsed.authType !== 'string'
			|| typeof parsed.username !== 'string' || !Number.isSafeInteger(parsed.credentialRevision)) return undefined;
		const serverMatch = parsed.server.match(/^(.*?)(?:,(\d+))?$/);
		return {
			dialect: parsed.dialect,
			serverUrl: serverMatch?.[1] || parsed.server,
			...(serverMatch?.[2] ? { port: Number(serverMatch[2]) } : {}),
			database: parsed.database,
			authType: parsed.authType,
			username: parsed.username,
			credentialRevision: Number(parsed.credentialRevision),
		};
	} catch {
		return undefined;
	}
}

function sqlConnectionTargetWithoutRevisionSignature(connection: SqlConnectionTargetIdentity): string {
	return JSON.stringify({
		dialect: String(connection.dialect || '').trim().toLowerCase(),
		server: sqlConnectionServerSignature(connection),
		database: String(connection.database || '').trim(),
		authType: String(connection.authType || '').trim().toLowerCase(),
		username: String(connection.username || '').trim(),
	});
}

export function normalizeSqlConnectionTargetSignature(signature: string): string {
	const value = String(signature || '');
	if (!value || value.startsWith('v2:')) return value;
	const legacyTarget = parseVersionOneSqlConnectionTargetSignature(value)
		?? parseLegacySqlConnectionTargetSignature(value);
	return legacyTarget ? sqlConnectionTargetSignature(legacyTarget) : value;
}

export function sqlConnectionTargetSignatureMatches(connection: SqlConnectionTargetIdentity, expectedSignature: string): boolean {
	if (sqlConnectionTargetSignature(connection) === expectedSignature) return true;
	if (expectedSignature.startsWith('v2:')) return false;
	const versionOneTarget = parseVersionOneSqlConnectionTargetSignature(expectedSignature);
	if (versionOneTarget) return sqlConnectionTargetSignature(connection) === sqlConnectionTargetSignature(versionOneTarget);
	const credentialRevision = Number.isSafeInteger(connection.credentialRevision) ? Number(connection.credentialRevision) : 0;
	if (credentialRevision !== 0) return false;
	const legacyTarget = parseLegacySqlConnectionTargetSignature(expectedSignature);
	return !!legacyTarget
		&& sqlConnectionTargetWithoutRevisionSignature(connection) === sqlConnectionTargetWithoutRevisionSignature(legacyTarget);
}