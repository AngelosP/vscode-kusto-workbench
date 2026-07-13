import { kustoClusterKey } from '../shared/kustoClusterUrls';
import type { KustoConnection } from './connectionManager';

export interface KustoFavorite {
	name: string;
	connectionId: string;
	clusterUrl: string;
	database: string;
	accountPartition?: string;
}

export interface SqlFavorite {
	name: string;
	connectionId: string;
	database: string;
}

export interface FavoriteMutationResult<TFavorite> {
	favorites: TFavorite[];
	changed: boolean;
	favorite?: TFavorite;
}

function trimText(value: unknown): string {
	return String(value || '').trim();
}

export function normalizeFavoriteClusterUrl(clusterUrl: string): string {
	let normalized = trimText(clusterUrl);
	if (!normalized) return '';
	if (!/^https?:\/\//i.test(normalized)) normalized = 'https://' + normalized;
	return normalized.replace(/\/+$/g, '').toLowerCase();
}

export function getKustoFavoriteDefaultName(clusterUrl: string, database: string): string {
	try {
		const normalized = normalizeFavoriteClusterUrl(clusterUrl);
		const parsed = new URL(normalized);
		const host = String(parsed.hostname || '').trim();
		const clusterName = host ? (host.split('.')[0] || host) : normalized;
		return `${clusterName}.${trimText(database)}`;
	} catch {
		return `${trimText(clusterUrl) || 'Kusto Cluster'}.${trimText(database)}`;
	}
}

export function getKustoFavoriteKey(connectionId: string, database: string): string {
	return `${trimText(connectionId)}|${trimText(database).toLowerCase()}`;
}

function getKustoFavoriteStorageKey(connectionId: string, database: string, accountPartition?: string): string {
	return `${trimText(connectionId)}|${trimText(accountPartition)}|${trimText(database).toLowerCase()}`;
}

export function getSqlFavoriteKey(connectionId: string, database: string): string {
	return `${trimText(connectionId)}|${trimText(database).toLowerCase()}`;
}

export function sanitizeKustoFavorites(raw: unknown): KustoFavorite[] {
	if (!Array.isArray(raw)) return [];
	const favorites: KustoFavorite[] = [];
	for (const item of raw) {
		if (!item || typeof item !== 'object') continue;
		const maybe = item as Partial<KustoFavorite>;
		const favorite = sanitizeKustoFavoriteInput(maybe);
		if (favorite) favorites.push(favorite);
	}
	return favorites;
}

export function migrateKustoFavoritesWithStatus(
	raw: unknown,
	connections: readonly KustoConnection[],
	activeAccountPartitions: ReadonlyMap<string, string | undefined> = new Map(),
): { favorites: KustoFavorite[]; unresolved: number } {
	if (!Array.isArray(raw)) return { favorites: [], unresolved: 0 };
	const favorites: KustoFavorite[] = [];
	let unresolved = 0;
	for (const item of raw) {
		if (!item || typeof item !== 'object') { unresolved++; continue; }
		const maybe = item as Partial<KustoFavorite>;
		let connectionId = trimText(maybe.connectionId);
		const clusterUrl = trimText(maybe.clusterUrl);
		if (connectionId) {
			const connection = connections.find(candidate => candidate.id === connectionId);
			if (!connection || (clusterUrl && kustoClusterKey(connection.clusterUrl) !== kustoClusterKey(clusterUrl))) { unresolved++; continue; }
		} else {
			const matches = connections.filter(connection => kustoClusterKey(connection.clusterUrl) === kustoClusterKey(clusterUrl));
			if (matches.length !== 1) { unresolved++; continue; }
			connectionId = matches[0].id;
		}
		const connection = connections.find(candidate => candidate.id === connectionId);
		const storedPartition = trimText(maybe.accountPartition);
		const accountPartition = storedPartition || trimText(activeAccountPartitions.get(connectionId));
		const favorite = sanitizeKustoFavoriteInput({ ...maybe, connectionId, clusterUrl: connection?.clusterUrl ?? clusterUrl, accountPartition });
		if (favorite && !favorites.some(existing => getKustoFavoriteStorageKey(existing.connectionId, existing.database, existing.accountPartition) === getKustoFavoriteStorageKey(favorite.connectionId, favorite.database, favorite.accountPartition))) {
			favorites.push(favorite);
		} else if (!favorite) unresolved++;
	}
	return { favorites, unresolved };
}

export function migrateKustoFavorites(
	raw: unknown,
	connections: readonly KustoConnection[],
	activeAccountPartitions?: ReadonlyMap<string, string | undefined>,
): KustoFavorite[] {
	return migrateKustoFavoritesWithStatus(raw, connections, activeAccountPartitions).favorites;
}

export function filterKustoFavoritesForActivePrincipals(
	favorites: readonly KustoFavorite[],
	activeAccountPartitions: ReadonlyMap<string, string | undefined>,
): KustoFavorite[] {
	return favorites.flatMap(favorite => {
		if (trimText(favorite.accountPartition) !== trimText(activeAccountPartitions.get(favorite.connectionId))) return [];
		const { accountPartition: _accountPartition, ...visibleFavorite } = favorite;
		return [visibleFavorite];
	});
}

export function mergeKustoFavoritesForActivePrincipals(
	allFavorites: readonly KustoFavorite[],
	activeFavorites: readonly KustoFavorite[],
	activeAccountPartitions: ReadonlyMap<string, string | undefined>,
): KustoFavorite[] {
	const activeOwnerKeys = new Set(
		[...activeAccountPartitions].map(([connectionId, partition]) => `${trimText(connectionId)}|${trimText(partition)}`),
	);
	const hiddenFavorites = allFavorites.filter(favorite => !activeOwnerKeys.has(`${trimText(favorite.connectionId)}|${trimText(favorite.accountPartition)}`));
	return [...hiddenFavorites, ...activeFavorites.map(favorite => ({
		...favorite,
		accountPartition: trimText(favorite.accountPartition) || trimText(activeAccountPartitions.get(favorite.connectionId)) || undefined,
	}))];
}

export function sanitizeSqlFavorites(raw: unknown): SqlFavorite[] {
	if (!Array.isArray(raw)) return [];
	const favorites: SqlFavorite[] = [];
	for (const item of raw) {
		if (!item || typeof item !== 'object') continue;
		const maybe = item as Partial<SqlFavorite>;
		const favorite = sanitizeSqlFavoriteInput(maybe);
		if (favorite) favorites.push(favorite);
	}
	return favorites;
}

export function getKustoFavorite(favorites: readonly KustoFavorite[], connectionId: string, database: string): KustoFavorite | undefined {
	return favorites.find(favorite => trimText(favorite.connectionId) === trimText(connectionId)
		&& trimText(favorite.database).toLowerCase() === trimText(database).toLowerCase());
}

export function getSqlFavorite(favorites: readonly SqlFavorite[], connectionId: string, database: string): SqlFavorite | undefined {
	const key = getSqlFavoriteKey(connectionId, database);
	return favorites.find(favorite => getSqlFavoriteKey(favorite.connectionId, favorite.database) === key);
}

export function addKustoFavoriteIfMissing(
	favorites: readonly KustoFavorite[],
	favoriteInput: Partial<KustoFavorite>
): FavoriteMutationResult<KustoFavorite> {
	const current = [...favorites];
	const favorite = sanitizeKustoFavoriteInput(favoriteInput);
	if (!favorite) return { favorites: current, changed: false };
	const existing = getKustoFavorite(current, favorite.connectionId, favorite.database);
	if (existing) return { favorites: current, changed: false, favorite: existing };
	return { favorites: [...current, favorite], changed: true, favorite };
}

export function upsertKustoFavorite(
	favorites: readonly KustoFavorite[],
	favoriteInput: Partial<KustoFavorite>
): FavoriteMutationResult<KustoFavorite> {
	const current = [...favorites];
	const favorite = sanitizeKustoFavoriteInput(favoriteInput);
	if (!favorite) return { favorites: current, changed: false };
	const key = getKustoFavoriteKey(favorite.connectionId, favorite.database);
	let matchedFavorite: KustoFavorite | undefined;
	let matched = false;
	let changed = false;
	const next = current.map(existing => {
		if (getKustoFavoriteKey(existing.connectionId, existing.database) !== key) return existing;
		matched = true;
		const updated = { ...existing, name: favorite.name };
		matchedFavorite = updated;
		if (existing.name !== favorite.name) changed = true;
		return updated;
	});
	if (!matched) {
		next.push(favorite);
		return { favorites: next, changed: true, favorite };
	}
	return { favorites: next, changed, favorite: matchedFavorite };
}

export function renameKustoFavorite(
	favorites: readonly KustoFavorite[],
	connectionId: string,
	database: string,
	name: string
): FavoriteMutationResult<KustoFavorite> {
	const nextName = trimText(name);
	const current = [...favorites];
	if (!nextName || !trimText(connectionId) || !trimText(database)) return { favorites: current, changed: false };
	const key = getKustoFavoriteKey(connectionId, database);
	let matchedFavorite: KustoFavorite | undefined;
	let changed = false;
	const next = current.map(existing => {
		if (getKustoFavoriteKey(existing.connectionId, existing.database) !== key) return existing;
		const updated = { ...existing, name: nextName };
		matchedFavorite = updated;
		if (existing.name !== nextName) changed = true;
		return updated;
	});
	return { favorites: next, changed, favorite: matchedFavorite };
}

export function removeKustoFavorite(
	favorites: readonly KustoFavorite[],
	connectionId: string,
	database: string
): FavoriteMutationResult<KustoFavorite> {
	const current = [...favorites];
	if (!trimText(connectionId) || !trimText(database)) return { favorites: current, changed: false };
	const key = getKustoFavoriteKey(connectionId, database);
	const next = current.filter(favorite => getKustoFavoriteKey(favorite.connectionId, favorite.database) !== key);
	return { favorites: next, changed: next.length !== current.length };
}

export function addSqlFavoriteIfMissing(
	favorites: readonly SqlFavorite[],
	favoriteInput: Partial<SqlFavorite>
): FavoriteMutationResult<SqlFavorite> {
	const current = [...favorites];
	const favorite = sanitizeSqlFavoriteInput(favoriteInput);
	if (!favorite) return { favorites: current, changed: false };
	const existing = getSqlFavorite(current, favorite.connectionId, favorite.database);
	if (existing) return { favorites: current, changed: false, favorite: existing };
	return { favorites: [...current, favorite], changed: true, favorite };
}

export function upsertSqlFavorite(
	favorites: readonly SqlFavorite[],
	favoriteInput: Partial<SqlFavorite>
): FavoriteMutationResult<SqlFavorite> {
	const current = [...favorites];
	const favorite = sanitizeSqlFavoriteInput(favoriteInput);
	if (!favorite) return { favorites: current, changed: false };
	const key = getSqlFavoriteKey(favorite.connectionId, favorite.database);
	let matchedFavorite: SqlFavorite | undefined;
	let matched = false;
	let changed = false;
	const next = current.map(existing => {
		if (getSqlFavoriteKey(existing.connectionId, existing.database) !== key) return existing;
		matched = true;
		const updated = { ...existing, name: favorite.name };
		matchedFavorite = updated;
		if (existing.name !== favorite.name) changed = true;
		return updated;
	});
	if (!matched) {
		next.push(favorite);
		return { favorites: next, changed: true, favorite };
	}
	return { favorites: next, changed, favorite: matchedFavorite };
}

export function renameSqlFavorite(
	favorites: readonly SqlFavorite[],
	connectionId: string,
	database: string,
	name: string
): FavoriteMutationResult<SqlFavorite> {
	const nextName = trimText(name);
	const current = [...favorites];
	if (!nextName || !trimText(connectionId) || !trimText(database)) return { favorites: current, changed: false };
	const key = getSqlFavoriteKey(connectionId, database);
	let matchedFavorite: SqlFavorite | undefined;
	let changed = false;
	const next = current.map(existing => {
		if (getSqlFavoriteKey(existing.connectionId, existing.database) !== key) return existing;
		const updated = { ...existing, name: nextName };
		matchedFavorite = updated;
		if (existing.name !== nextName) changed = true;
		return updated;
	});
	return { favorites: next, changed, favorite: matchedFavorite };
}

export function removeSqlFavorite(
	favorites: readonly SqlFavorite[],
	connectionId: string,
	database: string
): FavoriteMutationResult<SqlFavorite> {
	const current = [...favorites];
	if (!trimText(connectionId) || !trimText(database)) return { favorites: current, changed: false };
	const key = getSqlFavoriteKey(connectionId, database);
	const next = current.filter(favorite => getSqlFavoriteKey(favorite.connectionId, favorite.database) !== key);
	return { favorites: next, changed: next.length !== current.length };
}

function sanitizeKustoFavoriteInput(favorite: Partial<KustoFavorite>): KustoFavorite | undefined {
	const name = trimText(favorite.name);
	const connectionId = trimText(favorite.connectionId);
	const clusterUrl = trimText(favorite.clusterUrl);
	const database = trimText(favorite.database);
	const accountPartition = trimText(favorite.accountPartition);
	if (!name || !connectionId || !clusterUrl || !database) return undefined;
	return { name, connectionId, clusterUrl, database, ...(accountPartition ? { accountPartition } : {}) };
}

function sanitizeSqlFavoriteInput(favorite: Partial<SqlFavorite>): SqlFavorite | undefined {
	const name = trimText(favorite.name);
	const connectionId = trimText(favorite.connectionId);
	const database = trimText(favorite.database);
	if (!name || !connectionId || !database) return undefined;
	return { name, connectionId, database };
}
