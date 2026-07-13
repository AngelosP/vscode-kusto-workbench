import { describe, expect, it } from 'vitest';
import {
	addKustoFavoriteIfMissing,
	addSqlFavoriteIfMissing,
	filterKustoFavoritesForActivePrincipals,
	getKustoFavorite,
	getKustoFavoriteDefaultName,
	getSqlFavorite,
	migrateKustoFavorites,
	migrateKustoFavoritesWithStatus,
	mergeKustoFavoritesForActivePrincipals,
	removeKustoFavorite,
	removeSqlFavorite,
	renameKustoFavorite,
	renameSqlFavorite,
	sanitizeKustoFavorites,
	sanitizeSqlFavorites,
	upsertKustoFavorite,
	upsertSqlFavorite,
	type KustoFavorite,
	type SqlFavorite,
} from '../../../src/host/connectionManagerFavorites';

describe('connectionManagerFavorites', () => {
	describe('Kusto favorites', () => {
		const existing: KustoFavorite[] = [
			{ name: 'Original', connectionId: 'conn-one', clusterUrl: 'https://example.kusto.windows.net/', database: 'DbOne' },
			{ name: 'Other', connectionId: 'conn-other', clusterUrl: 'https://other.kusto.windows.net', database: 'OtherDb' },
		];

		it('sanitizes valid favorites and drops malformed entries', () => {
			const favorites = sanitizeKustoFavorites([
				{ name: '  Keep  ', connectionId: ' conn-one ', clusterUrl: ' example.kusto.windows.net ', database: ' DbOne ' },
				{ name: '', connectionId: 'conn-one', clusterUrl: 'example.kusto.windows.net', database: 'DbTwo' },
				{ name: 'Missing database', connectionId: 'conn-one', clusterUrl: 'example.kusto.windows.net' },
				null,
			]);

			expect(favorites).toEqual([
				{ name: 'Keep', connectionId: 'conn-one', clusterUrl: 'example.kusto.windows.net', database: 'DbOne' },
			]);
		});

		it('matches by connection ID and case-insensitive database', () => {
			expect(getKustoFavorite(existing, 'conn-one', 'dbone')?.name).toBe('Original');
		});

		it('does not conflate two connection identities that share an endpoint', () => {
			const favorites: KustoFavorite[] = [
				{ name: 'Home tenant', connectionId: 'home', clusterUrl: 'https://shared.kusto.windows.net', database: 'prod' },
				{ name: 'Guest tenant', connectionId: 'guest', clusterUrl: 'https://shared.kusto.windows.net', database: 'prod' },
			];

			expect(getKustoFavorite(favorites, 'guest', 'PROD')?.name).toBe('Guest tenant');
		});

		it('explicit add does not overwrite an existing friendly name', () => {
			const result = addKustoFavoriteIfMissing(existing, {
				name: 'Should not replace',
				connectionId: 'conn-one',
				clusterUrl: 'https://EXAMPLE.kusto.windows.net',
				database: 'dbone',
			});

			expect(result.changed).toBe(false);
			expect(result.favorites).toEqual(existing);
		});

		it('prompt upsert can intentionally rename an existing favorite without changing identity fields', () => {
			const result = upsertKustoFavorite(existing, {
				name: 'Renamed',
				connectionId: 'conn-one',
				clusterUrl: 'example.kusto.windows.net',
				database: 'dbone',
			});

			expect(result.changed).toBe(true);
			expect(result.favorites[0]).toEqual({ name: 'Renamed', connectionId: 'conn-one', clusterUrl: 'https://example.kusto.windows.net/', database: 'DbOne' });
			expect(result.favorites[1]).toBe(existing[1]);
		});

		it('renames an existing favorite and preserves order', () => {
			const result = renameKustoFavorite(existing, 'conn-one', 'dbone', '  Friendly  ');

			expect(result.changed).toBe(true);
			expect(result.favorites.map(favorite => favorite.name)).toEqual(['Friendly', 'Other']);
		});

		it('does not create a favorite when renaming a missing target or blank name', () => {
			expect(renameKustoFavorite(existing, 'missing', 'DbOne', 'Friendly')).toEqual({
				favorites: existing,
				changed: false,
				favorite: undefined,
			});
			expect(renameKustoFavorite(existing, 'conn-one', 'DbOne', '   ').changed).toBe(false);
		});

		it('removes all favorites matching an identity', () => {
			const result = removeKustoFavorite([
				...existing,
				{ name: 'Duplicate', connectionId: 'conn-one', clusterUrl: 'example.kusto.windows.net', database: 'dbone' },
			], 'conn-one', 'DBONE');

			expect(result.changed).toBe(true);
			expect(result.favorites).toEqual([existing[1]]);
		});

		it('builds the same style of default name as query-editor favorites', () => {
			expect(getKustoFavoriteDefaultName('https://sample.kusto.windows.net', 'Logs')).toBe('sample.Logs');
		});

		it('migrates an endpoint-only favorite when exactly one connection matches', () => {
			const migrated = migrateKustoFavorites([
				{ name: 'Legacy', clusterUrl: 'shared.westus', database: 'Prod' },
			], [
				{ id: 'guest', name: 'Guest', clusterUrl: 'https://shared.westus.kusto.windows.net', authorityId: 'contoso.com' },
			]);

			expect(migrated).toEqual([
				{ name: 'Legacy', connectionId: 'guest', clusterUrl: 'https://shared.westus.kusto.windows.net', database: 'Prod' },
			]);
		});

		it('drops an endpoint-only favorite when tenant connections make ownership ambiguous', () => {
				const migrated = migrateKustoFavoritesWithStatus([
				{ name: 'Legacy', clusterUrl: 'https://shared.kusto.windows.net', database: 'Prod' },
			], [
				{ id: 'home', name: 'Home', clusterUrl: 'https://shared.kusto.windows.net' },
				{ id: 'guest', name: 'Guest', clusterUrl: 'https://shared.kusto.windows.net', authorityId: 'contoso.com' },
			]);

			expect(migrated).toEqual({ favorites: [], unresolved: 1 });
		});

		it('migrates legacy favorites to the current principal and hides them after account rotation', () => {
			const connections = [{ id: 'shared', name: 'Shared', clusterUrl: 'https://shared.kusto.windows.net' }];
			const partitionA = new Map<string, string | undefined>([['shared', 'partition-a']]);
			const partitionB = new Map<string, string | undefined>([['shared', 'partition-b']]);
			const stored = migrateKustoFavorites([
				{ name: 'A only', connectionId: 'shared', clusterUrl: 'https://shared.kusto.windows.net', database: 'SecretA' },
			], connections, partitionA);

			expect(stored[0].accountPartition).toBe('partition-a');
			expect(filterKustoFavoritesForActivePrincipals(stored, partitionA)).toEqual([
				{ name: 'A only', connectionId: 'shared', clusterUrl: 'https://shared.kusto.windows.net', database: 'SecretA' },
			]);
			expect(filterKustoFavoritesForActivePrincipals(stored, partitionB)).toEqual([]);
		});

		it('preserves hidden A favorites while replacing B active favorites', () => {
			const allFavorites: KustoFavorite[] = [
				{ name: 'A only', connectionId: 'shared', clusterUrl: 'https://shared.kusto.windows.net', database: 'SecretA', accountPartition: 'partition-a' },
				{ name: 'Old B', connectionId: 'shared', clusterUrl: 'https://shared.kusto.windows.net', database: 'OldB', accountPartition: 'partition-b' },
			];
			const partitionB = new Map<string, string | undefined>([['shared', 'partition-b']]);
			const merged = mergeKustoFavoritesForActivePrincipals(allFavorites, [
				{ name: 'New B', connectionId: 'shared', clusterUrl: 'https://shared.kusto.windows.net', database: 'NewB' },
			], partitionB);

			expect(merged).toEqual([
				allFavorites[0],
				{ name: 'New B', connectionId: 'shared', clusterUrl: 'https://shared.kusto.windows.net', database: 'NewB', accountPartition: 'partition-b' },
			]);
		});
	});

	describe('SQL favorites', () => {
		const existing: SqlFavorite[] = [
			{ name: 'Original SQL', connectionId: 'sql1', database: 'Sales' },
			{ name: 'Warehouse', connectionId: 'sql2', database: 'Dw' },
		];

		it('sanitizes valid SQL favorites and drops malformed entries', () => {
			const favorites = sanitizeSqlFavorites([
				{ name: '  Keep SQL  ', connectionId: ' sql1 ', database: ' Sales ' },
				{ name: 'No connection', database: 'Sales' },
			]);

			expect(favorites).toEqual([
				{ name: 'Keep SQL', connectionId: 'sql1', database: 'Sales' },
			]);
		});

		it('matches SQL favorites by connection id and case-insensitive database', () => {
			expect(getSqlFavorite(existing, 'sql1', 'sales')?.name).toBe('Original SQL');
		});

		it('explicit SQL add does not overwrite an existing friendly name', () => {
			const result = addSqlFavoriteIfMissing(existing, { name: 'No replace', connectionId: 'sql1', database: 'sales' });

			expect(result.changed).toBe(false);
			expect(result.favorites).toEqual(existing);
		});

		it('prompt SQL upsert can intentionally rename without changing identity fields', () => {
			const result = upsertSqlFavorite(existing, { name: 'Renamed SQL', connectionId: 'sql1', database: 'sales' });

			expect(result.changed).toBe(true);
			expect(result.favorites[0]).toEqual({ name: 'Renamed SQL', connectionId: 'sql1', database: 'Sales' });
		});

		it('renames and removes SQL favorites by identity', () => {
			const renamed = renameSqlFavorite(existing, 'sql1', 'sales', '  Friendly SQL  ');
			expect(renamed.favorites.map(favorite => favorite.name)).toEqual(['Friendly SQL', 'Warehouse']);

			const removed = removeSqlFavorite(renamed.favorites, 'sql1', 'SALES');
			expect(removed.changed).toBe(true);
			expect(removed.favorites).toEqual([existing[1]]);
		});
	});
});
