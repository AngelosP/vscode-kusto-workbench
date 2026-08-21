// Pure schema utility functions.
// No DOM access, no window globals. Extracted from schema.ts.
import { getKustoConnectionIdentityKey } from '../../shared/kustoAuth.js';
import { kustoClusterKey } from '../../shared/kustoClusterUrls.js';

export interface SchemaInfoData {
	status: 'not-loaded' | 'loading' | 'loaded' | 'cached' | 'error';
	statusText: string;
	tables?: number;
	cols?: number;
	funcs?: number;
	cached: boolean;
	errorMessage?: string;
}

export function shouldStartKustoSchemaPrewarm(args: {
	schemaFetchInFlight: boolean;
	authoritativeRequestToken?: string;
	preparationStatus?: string;
	diagnosticsTrusted?: boolean;
}): boolean {
	const token = String(args.authoritativeRequestToken || '');
	return args.diagnosticsTrusted !== false
		&& !args.schemaFetchInFlight
		&& (!token || token.startsWith('schema_prewarm_'))
		&& args.preparationStatus !== 'preparing'
		&& args.preparationStatus !== 'deferred';
}

type KustoConnectionKeyspaceEntry = Readonly<{
	id?: unknown;
	clusterUrl?: unknown;
	authorityId?: unknown;
	accountPartition?: unknown;
}>;

function kustoConnectionPrincipalKey(connection: KustoConnectionKeyspaceEntry): string {
	const id = String(connection?.id || '').trim();
	const accountPartition = String(connection?.accountPartition || '').trim();
	const identity = getKustoConnectionIdentityKey(connection?.clusterUrl, connection?.authorityId);
	return id && identity ? `${encodeURIComponent(id)}|${accountPartition}|${identity}` : '';
}

function kustoConnectionClusterCounts(connections: readonly KustoConnectionKeyspaceEntry[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const connection of connections || []) {
		const clusterKey = kustoClusterKey(connection?.clusterUrl);
		if (clusterKey) counts.set(clusterKey, (counts.get(clusterKey) || 0) + 1);
	}
	return counts;
}

export function classifyKustoConnectionKeyspaceChange(
	previousConnections: readonly KustoConnectionKeyspaceEntry[],
	nextConnections: readonly KustoConnectionKeyspaceEntry[],
): Readonly<{ changed: boolean; invalidated: boolean }> {
	try {
		const previous = new Set((previousConnections || []).map(kustoConnectionPrincipalKey).filter(Boolean));
		const next = new Set((nextConnections || []).map(kustoConnectionPrincipalKey).filter(Boolean));
		const previousClusterCounts = kustoConnectionClusterCounts(previousConnections);
		const nextClusterCounts = kustoConnectionClusterCounts(nextConnections);
		const clusterCardinalityChanged = previousClusterCounts.size !== nextClusterCounts.size
			|| Array.from(previousClusterCounts).some(([key, count]) => nextClusterCounts.get(key) !== count);
		const changed = previous.size !== next.size
			|| Array.from(previous).some(key => !next.has(key))
			|| clusterCardinalityChanged;
		const invalidated = Array.from(previous).some(key => !next.has(key))
			|| Array.from(previousClusterCounts).some(([key, count]) => count === 1 && (nextClusterCounts.get(key) || 0) > 1);
		return Object.freeze({ changed, invalidated });
	} catch {
		return Object.freeze({ changed: true, invalidated: true });
	}
}

export function isExplicitKustoTargetSelectionSource(source: unknown): boolean {
	const value = String(source || '').trim();
	return value === 'user' || value === 'tool';
}

export function shouldForceKustoFocusedSchemaApply(args: {
	workerApplyRequired: boolean;
	baseWorkerReady: boolean;
	workerContextMatches: boolean;
}): boolean {
	return args.workerApplyRequired
		|| (args.baseWorkerReady && !args.workerContextMatches);
}

export function shouldScheduleKustoSupplementalSchemaEnhancement(args: {
	primarySchemaKey?: string | null;
	supplementalSchemaKey: string;
}): boolean {
	const primarySchemaKey = String(args.primarySchemaKey || '');
	const supplementalSchemaKey = String(args.supplementalSchemaKey || '');
	return !!supplementalSchemaKey && (!primarySchemaKey || primarySchemaKey !== supplementalSchemaKey);
}

/**
 * Build a schema info object from display text, error flag, and optional metadata.
 * Pure function — no DOM or window access.
 */
export function buildSchemaInfo(text: string, isError: boolean, meta?: Record<string, unknown>): SchemaInfoData {
	const hasText = !!text;
	if (hasText && meta) {
		const tablesCount = Number(meta.tablesCount);
		const columnsCount = Number(meta.columnsCount);
		const functionsCount = Number(meta.functionsCount);
		const fromCache = !!meta.fromCache;
		return {
			status: isError ? 'error' : (fromCache ? 'cached' : 'loaded'),
			statusText: isError ? (String(meta.errorMessage || 'Error')) : (fromCache ? 'Cached' : 'Loaded'),
			tables: tablesCount >= 0 ? tablesCount : 0,
			cols: columnsCount >= 0 ? columnsCount : 0,
			funcs: functionsCount >= 0 ? functionsCount : 0,
			cached: fromCache,
			errorMessage: isError ? String(text || 'Error') : undefined,
		};
	}
	if (hasText) {
		return {
			status: isError ? 'error' : 'loaded',
			statusText: isError ? 'Error' : text,
			tables: undefined,
			cols: undefined,
			funcs: undefined,
			cached: false,
			errorMessage: isError ? String(text || 'Error') : undefined,
		};
	}
	return {
		status: 'not-loaded',
		statusText: 'Not loaded',
		tables: undefined,
		cols: undefined,
		funcs: undefined,
		cached: false,
	};
}
