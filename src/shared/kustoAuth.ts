import { kustoClusterKey, kustoDatabaseKey } from './kustoClusterUrls';

export const KUSTO_AUTH_PROVIDER_ID = 'microsoft';
export const KUSTO_AUTH_SCOPE = 'https://kusto.kusto.windows.net/.default';

const TENANT_GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TENANT_DOMAIN_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;
const WELL_KNOWN_AUTHORITIES = new Set(['common', 'consumers', 'organizations']);

export type KustoConnectionIdentity = {
	id: string;
	clusterUrl: string;
	authorityId?: string;
};

export type KustoConnectionResolution<T extends KustoConnectionIdentity> =
	| { kind: 'matched'; connection: T }
	| { kind: 'missing' }
	| { kind: 'ambiguous'; connections: T[] };

export type StrictKustoConnectionResolution<T extends KustoConnectionIdentity> =
	| { kind: 'matched'; connection: T }
	| { kind: 'missing' }
	| { kind: 'ambiguous'; connections: T[] }
	| { kind: 'mismatch'; connection: T };

export function normalizeKustoAuthorityId(value: unknown): string | undefined {
	const authorityId = String(value ?? '').trim().toLowerCase();
	if (!authorityId) return undefined;
	if (WELL_KNOWN_AUTHORITIES.has(authorityId)) return authorityId;
	if (TENANT_GUID_PATTERN.test(authorityId) || TENANT_DOMAIN_PATTERN.test(authorityId)) return authorityId;
	throw new Error('Tenant / Authority ID must be a tenant GUID, tenant domain, common, consumers, or organizations.');
}

export function getKustoAuthScopes(authorityId?: unknown): string[] {
	const normalizedAuthority = normalizeKustoAuthorityId(authorityId);
	return normalizedAuthority
		? [KUSTO_AUTH_SCOPE, `VSCODE_TENANT:${normalizedAuthority}`]
		: [KUSTO_AUTH_SCOPE];
}

export function getKustoConnectionIdentityKey(clusterUrl: unknown, authorityId?: unknown): string {
	const clusterKey = kustoClusterKey(clusterUrl);
	if (!clusterKey) return '';
	return `${clusterKey}|${normalizeKustoAuthorityId(authorityId) ?? ''}`;
}

export function resolveKustoConnection<T extends KustoConnectionIdentity>(
	connections: readonly T[],
	request: { clusterUrl?: unknown; authorityId?: unknown; connectionIdHint?: unknown },
): KustoConnectionResolution<T> {
	const targetCluster = kustoClusterKey(request.clusterUrl);
	if (!targetCluster) return { kind: 'missing' };
	const requestedAuthority = normalizeKustoAuthorityId(request.authorityId);
	const hint = String(request.connectionIdHint ?? '').trim();
	const explicitDefaultAuthority = !!hint && requestedAuthority === undefined;

	const clusterMatches = connections.flatMap(connection => {
		if (kustoClusterKey(connection.clusterUrl) !== targetCluster) return [];
		try {
			return [{ connection, authorityId: normalizeKustoAuthorityId(connection.authorityId) }];
		} catch {
			return [];
		}
	});
	if (hint) {
		const hinted = clusterMatches.find(candidate => candidate.connection.id === hint);
		if (hinted && hinted.authorityId === requestedAuthority) {
			return { kind: 'matched', connection: hinted.connection };
		}
	}

	const authorityMatches = requestedAuthority === undefined
		? explicitDefaultAuthority
			? clusterMatches.filter(candidate => candidate.authorityId === undefined)
			: clusterMatches
		: clusterMatches.filter(candidate => candidate.authorityId === requestedAuthority);
	if (authorityMatches.length === 1) return { kind: 'matched', connection: authorityMatches[0].connection };
	if (authorityMatches.length > 1) return { kind: 'ambiguous', connections: authorityMatches.map(candidate => candidate.connection) };
	return { kind: 'missing' };
}

export function resolveStrictKustoConnection<T extends KustoConnectionIdentity>(
	connections: readonly T[],
	request: { clusterUrl?: unknown; connectionId?: unknown },
): StrictKustoConnectionResolution<T> {
	const targetCluster = kustoClusterKey(request.clusterUrl);
	if (!targetCluster) return { kind: 'missing' };
	const connectionId = String(request.connectionId ?? '').trim();
	if (connectionId) {
		const connection = connections.find(candidate => candidate.id === connectionId);
		if (!connection) return { kind: 'missing' };
		return kustoClusterKey(connection.clusterUrl) === targetCluster
			? { kind: 'matched', connection }
			: { kind: 'mismatch', connection };
	}
	const matches = connections.filter(connection => kustoClusterKey(connection.clusterUrl) === targetCluster);
	if (matches.length === 1) return { kind: 'matched', connection: matches[0] };
	if (matches.length > 1) return { kind: 'ambiguous', connections: matches };
	return { kind: 'missing' };
}

export function getKustoSchemaIdentityKey(
	connectionId: unknown,
	accountPartition: unknown,
	clusterUrl: unknown,
	database: unknown,
): string {
	const id = String(connectionId ?? '').trim();
	const partition = String(accountPartition ?? '').trim();
	const physical = kustoDatabaseKey(clusterUrl, database);
	return id && partition && physical ? `v1|${encodeURIComponent(id)}|${partition}|${physical}` : '';
}