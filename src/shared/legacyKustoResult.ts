import { canonicalSectionKind } from './documentSectionCapabilities.js';
import { kustoClusterKey, kustoDatabaseKey } from './kustoClusterUrls.js';

type LegacyKustoSectionRecord = Record<string, unknown>;

export type LegacyKustoEffectiveTarget = Readonly<{
	clusterUrl: string;
	authorityId: string;
	connectionIdHint: string;
	database: string;
}>;

export type LegacyKustoEffectiveTargetResolution =
	| Readonly<{
		kind: 'kusto';
		target: LegacyKustoEffectiveTarget;
		ownerBoxId: string;
	}>
	| Readonly<{ kind: 'sql' }>;

function normalize(value: unknown): string {
	return String(value || '').trim();
}

function targetFromRecord(record: LegacyKustoSectionRecord): LegacyKustoEffectiveTarget {
	return Object.freeze({
		clusterUrl: normalize(record.clusterUrl),
		authorityId: normalize(record.authorityId),
		connectionIdHint: normalize(record.connectionIdHint),
		database: normalize(record.database),
	});
}

export function legacyKustoTargetMatchesRecord(
	record: LegacyKustoSectionRecord,
	target: LegacyKustoEffectiveTarget,
): boolean {
	const clusterUrl = normalize(record.clusterUrl);
	if (clusterUrl && kustoClusterKey(clusterUrl) !== kustoClusterKey(target.clusterUrl)) return false;
	const authorityId = normalize(record.authorityId);
	if (authorityId && authorityId.toLowerCase() !== target.authorityId.toLowerCase()) return false;
	const connectionIdHint = normalize(record.connectionIdHint);
	if (connectionIdHint && connectionIdHint !== target.connectionIdHint) return false;
	const database = normalize(record.database);
	return !database || database.toLowerCase() === target.database.toLowerCase();
}

export function resolveLegacyKustoEffectiveTarget(
	record: LegacyKustoSectionRecord,
	sectionsById: ReadonlyMap<string, LegacyKustoSectionRecord>,
	visiting = new Set<string>(),
): LegacyKustoEffectiveTargetResolution | undefined {
	if (canonicalSectionKind(record.type) !== 'query') return undefined;
	const boxId = normalize(record.id);
	if (!boxId || visiting.has(boxId)) return undefined;
	visiting.add(boxId);
	try {
		const sourceBoxId = normalize(record.comparisonSourceBoxId);
		if (sourceBoxId) {
			const source = sectionsById.get(sourceBoxId);
			const sourceKind = canonicalSectionKind(source?.type);
			if (sourceKind === 'sql') return Object.freeze({ kind: 'sql' });
			if (sourceKind !== 'query' || !source) return undefined;
			const sourceResolution = resolveLegacyKustoEffectiveTarget(source, sectionsById, visiting);
			if (!sourceResolution || sourceResolution.kind !== 'kusto'
				|| !legacyKustoTargetMatchesRecord(record, sourceResolution.target)) return undefined;
			return sourceResolution;
		}
		const target = targetFromRecord(record);
		return kustoClusterKey(target.clusterUrl) && target.database
			? Object.freeze({ kind: 'kusto', target, ownerBoxId: boxId })
			: undefined;
	} finally {
		visiting.delete(boxId);
	}
}

export function legacyKustoResultTargetMatches(
	resultJson: unknown,
	clusterUrl: unknown,
	database: unknown,
): boolean {
	if (typeof resultJson !== 'string' || !resultJson.trim()) return false;
	try {
		const parsed = JSON.parse(resultJson) as { metadata?: unknown };
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
			|| !parsed.metadata || typeof parsed.metadata !== 'object' || Array.isArray(parsed.metadata)) {
			return false;
		}
		const metadata = parsed.metadata as Record<string, unknown>;
		if (typeof metadata.cluster !== 'string' || typeof metadata.database !== 'string') return false;
		const persistedTarget = kustoDatabaseKey(metadata.cluster, metadata.database);
		return !!persistedTarget && persistedTarget === kustoDatabaseKey(clusterUrl, database);
	} catch {
		return false;
	}
}