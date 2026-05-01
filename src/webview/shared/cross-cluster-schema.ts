export interface CrossClusterSchemaContext {
	clusterUrl?: string | null;
	database?: string | null;
}

export interface CrossClusterSchemaRef {
	clusterName: string | null;
	database: string;
}

function normalizeClusterHost(value: string | null | undefined): string {
	return String(value || '')
		.trim()
		.toLowerCase()
		.replace(/^https?:\/\//, '')
		.replace(/\/+$/, '');
}

function clusterShortName(value: string | null | undefined): string {
	const host = normalizeClusterHost(value);
	return host ? (host.match(/^([^.]+)/)?.[1] || host) : '';
}

function addUniqueRef(refs: CrossClusterSchemaRef[], ref: CrossClusterSchemaRef): void {
	const clusterKey = ref.clusterName === null ? null : ref.clusterName.toLowerCase();
	const databaseKey = ref.database.toLowerCase();
	if (refs.some(candidate =>
		(candidate.clusterName === null ? null : candidate.clusterName.toLowerCase()) === clusterKey &&
		candidate.database.toLowerCase() === databaseKey
	)) {
		return;
	}
	refs.push(ref);
}

export function extractCrossClusterRefs(queryText: unknown, currentContext?: CrossClusterSchemaContext | null): CrossClusterSchemaRef[] {
	const refs: CrossClusterSchemaRef[] = [];
	if (typeof queryText !== 'string' || !queryText) {
		return refs;
	}

	const currentClusterShort = clusterShortName(currentContext?.clusterUrl);
	const currentClusterHost = normalizeClusterHost(currentContext?.clusterUrl);
	const currentDbLower = String(currentContext?.database || '').toLowerCase();
	const clusterDbPattern = /cluster\s*\(\s*['"]?([^'")\s]+)['"]?\s*\)\s*\.\s*database\s*\(\s*['"]?([^'")\s]+)['"]?\s*\)/gi;
	const clusterDatabaseRanges: Array<[number, number]> = [];
	let match: RegExpExecArray | null;

	while ((match = clusterDbPattern.exec(queryText)) !== null) {
		clusterDatabaseRanges.push([match.index, match.index + match[0].length]);
		const clusterName = match[1];
		const database = match[2];
		if (!clusterName || !database) {
			continue;
		}

		const clusterLower = clusterName.toLowerCase();
		const clusterHostLower = normalizeClusterHost(clusterName);
		const databaseLower = database.toLowerCase();
		if (currentDbLower && databaseLower === currentDbLower) {
			if (currentClusterShort && (clusterLower === currentClusterShort || clusterHostLower === currentClusterShort)) {
				continue;
			}
			if (currentClusterHost && (clusterLower === currentClusterHost || clusterHostLower === currentClusterHost)) {
				continue;
			}
		}

		addUniqueRef(refs, { clusterName, database });
	}

	const dbOnlyPattern = /(?<!cluster\s*\([^)]*\)\s*\.)\bdatabase\s*\(\s*['"]?([^'")\s]+)['"]?\s*\)/gi;
	while ((match = dbOnlyPattern.exec(queryText)) !== null) {
		if (clusterDatabaseRanges.some(([start, end]) => match!.index >= start && match!.index < end)) {
			continue;
		}
		const database = match[1];
		if (!database || database.toLowerCase() === currentDbLower) {
			continue;
		}
		addUniqueRef(refs, { clusterName: null, database });
	}

	return refs;
}

export function getCrossClusterSchemaCheckDelay(now: number, lastInteractionAt: number, minIdleMs: number): number {
	const minIdle = Math.max(0, Number(minIdleMs) || 0);
	if (minIdle === 0) {
		return 0;
	}
	const lastInteraction = Math.max(0, Number(lastInteractionAt) || 0);
	if (lastInteraction === 0) {
		return 0;
	}
	const idleFor = Math.max(0, (Number(now) || 0) - lastInteraction);
	return idleFor >= minIdle ? 0 : minIdle - idleFor;
}