export type ConnectionSearchScope = 'selected' | 'cached' | 'refresh-cached' | 'everything';

export interface ConnectionSearchTarget {
	connectionId: string;
	database?: string;
}

export function normalizeConnectionSearchTargets(value: unknown): ConnectionSearchTarget[] {
	if (!Array.isArray(value)) return [];
	const targets: ConnectionSearchTarget[] = [];
	for (const entry of value) {
		if (!entry || typeof entry !== 'object' || typeof entry.connectionId !== 'string' || !entry.connectionId.trim()) continue;
		if (entry.database !== undefined && (typeof entry.database !== 'string' || !entry.database.trim())) continue;
		const target: ConnectionSearchTarget = entry.database === undefined
			? { connectionId: entry.connectionId }
			: { connectionId: entry.connectionId, database: entry.database };
		if (targets.some(existing => existing.connectionId === target.connectionId
			&& (existing.database === undefined || existing.database === target.database))) continue;
		if (target.database === undefined) {
			for (let index = targets.length - 1; index >= 0; index--) {
				if (targets[index].connectionId === target.connectionId) targets.splice(index, 1);
			}
		}
		targets.push(target);
	}
	return targets;
}

export function connectionSearchIncludes(
	targets: readonly ConnectionSearchTarget[], connectionId: string, database?: string,
): boolean {
	return targets.some(target => target.connectionId === connectionId
		&& (target.database === undefined || target.database === database));
}

export function sameConnectionSearchTargets(
	left: readonly ConnectionSearchTarget[], right: readonly ConnectionSearchTarget[],
): boolean {
	return left.length === right.length && left.every(target => right.some(other =>
		other.connectionId === target.connectionId && other.database === target.database));
}