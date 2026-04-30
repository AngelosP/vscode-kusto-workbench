import { describe, expect, it } from 'vitest';
import {
	addKustoFavoriteIfMissing,
	addSqlFavoriteIfMissing,
	getKustoFavorite,
	getKustoFavoriteDefaultName,
	getSqlFavorite,
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
			{ name: 'Original', clusterUrl: 'https://example.kusto.windows.net/', database: 'DbOne' },
			{ name: 'Other', clusterUrl: 'https://other.kusto.windows.net', database: 'OtherDb' },
		];

		it('sanitizes valid favorites and drops malformed entries', () => {
			const favorites = sanitizeKustoFavorites([
				{ name: '  Keep  ', clusterUrl: ' example.kusto.windows.net ', database: ' DbOne ' },
				{ name: '', clusterUrl: 'example.kusto.windows.net', database: 'DbTwo' },
				{ name: 'Missing database', clusterUrl: 'example.kusto.windows.net' },
				null,
			]);

			expect(favorites).toEqual([
				{ name: 'Keep', clusterUrl: 'example.kusto.windows.net', database: 'DbOne' },
			]);
		});

		it('matches by normalized cluster URL and case-insensitive database', () => {
			expect(getKustoFavorite(existing, 'example.kusto.windows.net', 'dbone')?.name).toBe('Original');
		});

		it('explicit add does not overwrite an existing friendly name', () => {
			const result = addKustoFavoriteIfMissing(existing, {
				name: 'Should not replace',
				clusterUrl: 'https://EXAMPLE.kusto.windows.net',
				database: 'dbone',
			});

			expect(result.changed).toBe(false);
			expect(result.favorites).toEqual(existing);
		});

		it('prompt upsert can intentionally rename an existing favorite without changing identity fields', () => {
			const result = upsertKustoFavorite(existing, {
				name: 'Renamed',
				clusterUrl: 'example.kusto.windows.net',
				database: 'dbone',
			});

			expect(result.changed).toBe(true);
			expect(result.favorites[0]).toEqual({ name: 'Renamed', clusterUrl: 'https://example.kusto.windows.net/', database: 'DbOne' });
			expect(result.favorites[1]).toBe(existing[1]);
		});

		it('renames an existing favorite and preserves order', () => {
			const result = renameKustoFavorite(existing, 'example.kusto.windows.net', 'dbone', '  Friendly  ');

			expect(result.changed).toBe(true);
			expect(result.favorites.map(favorite => favorite.name)).toEqual(['Friendly', 'Other']);
		});

		it('does not create a favorite when renaming a missing target or blank name', () => {
			expect(renameKustoFavorite(existing, 'missing.kusto.windows.net', 'DbOne', 'Friendly')).toEqual({
				favorites: existing,
				changed: false,
				favorite: undefined,
			});
			expect(renameKustoFavorite(existing, 'example.kusto.windows.net', 'DbOne', '   ').changed).toBe(false);
		});

		it('removes all favorites matching an identity', () => {
			const result = removeKustoFavorite([
				...existing,
				{ name: 'Duplicate', clusterUrl: 'example.kusto.windows.net', database: 'dbone' },
			], 'EXAMPLE.kusto.windows.net', 'DBONE');

			expect(result.changed).toBe(true);
			expect(result.favorites).toEqual([existing[1]]);
		});

		it('builds the same style of default name as query-editor favorites', () => {
			expect(getKustoFavoriteDefaultName('https://sample.kusto.windows.net', 'Logs')).toBe('sample.Logs');
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
