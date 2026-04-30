export interface KustoFavorite {
	name: string;
	clusterUrl: string;
	database: string;
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

export function getKustoFavoriteKey(clusterUrl: string, database: string): string {
	return `${normalizeFavoriteClusterUrl(clusterUrl)}|${trimText(database).toLowerCase()}`;
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

export function getKustoFavorite(favorites: readonly KustoFavorite[], clusterUrl: string, database: string): KustoFavorite | undefined {
	const key = getKustoFavoriteKey(clusterUrl, database);
	return favorites.find(favorite => getKustoFavoriteKey(favorite.clusterUrl, favorite.database) === key);
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
	const existing = getKustoFavorite(current, favorite.clusterUrl, favorite.database);
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
	const key = getKustoFavoriteKey(favorite.clusterUrl, favorite.database);
	let matchedFavorite: KustoFavorite | undefined;
	let matched = false;
	let changed = false;
	const next = current.map(existing => {
		if (getKustoFavoriteKey(existing.clusterUrl, existing.database) !== key) return existing;
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
	clusterUrl: string,
	database: string,
	name: string
): FavoriteMutationResult<KustoFavorite> {
	const nextName = trimText(name);
	const current = [...favorites];
	if (!nextName || !trimText(clusterUrl) || !trimText(database)) return { favorites: current, changed: false };
	const key = getKustoFavoriteKey(clusterUrl, database);
	let matchedFavorite: KustoFavorite | undefined;
	let changed = false;
	const next = current.map(existing => {
		if (getKustoFavoriteKey(existing.clusterUrl, existing.database) !== key) return existing;
		const updated = { ...existing, name: nextName };
		matchedFavorite = updated;
		if (existing.name !== nextName) changed = true;
		return updated;
	});
	return { favorites: next, changed, favorite: matchedFavorite };
}

export function removeKustoFavorite(
	favorites: readonly KustoFavorite[],
	clusterUrl: string,
	database: string
): FavoriteMutationResult<KustoFavorite> {
	const current = [...favorites];
	if (!trimText(clusterUrl) || !trimText(database)) return { favorites: current, changed: false };
	const key = getKustoFavoriteKey(clusterUrl, database);
	const next = current.filter(favorite => getKustoFavoriteKey(favorite.clusterUrl, favorite.database) !== key);
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
	const clusterUrl = trimText(favorite.clusterUrl);
	const database = trimText(favorite.database);
	if (!name || !clusterUrl || !database) return undefined;
	return { name, clusterUrl, database };
}

function sanitizeSqlFavoriteInput(favorite: Partial<SqlFavorite>): SqlFavorite | undefined {
	const name = trimText(favorite.name);
	const connectionId = trimText(favorite.connectionId);
	const database = trimText(favorite.database);
	if (!name || !connectionId || !database) return undefined;
	return { name, connectionId, database };
}
