import { describe, it, expect } from 'vitest';
import { parseKqlxText, stringifyKqlxFile } from '../../../src/host/kqlxFormat';
import type { KqlxFileV1, KqlxSectionV1 } from '../../../src/host/kqlxFormat';
import { STORAGE_KEYS } from '../../../src/host/queryEditorTypes';
import type { SqlFavorite } from '../../../src/host/queryEditorTypes';

describe('SQL Favorites — favoritesMode persistence round-trip', () => {
	it('serializes and parses favoritesMode: true on sql section', () => {
		const file: KqlxFileV1 = {
			kind: 'kqlx',
			version: 1,
			state: {
				sections: [
					{
						type: 'sql',
						id: 'sql_fav1',
						name: 'Fav Test',
						query: 'SELECT 1',
						serverUrl: 'myserver.database.windows.net',
						database: 'mydb',
						favoritesMode: true,
					},
				],
			},
		};

		const text = stringifyKqlxFile(file);
		const result = parseKqlxText(text, { allowedKinds: ['kqlx', 'mdx', 'sqlx'] });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const sql = result.file.state.sections[0] as Extract<KqlxSectionV1, { type: 'sql' }>;
		expect(sql.type).toBe('sql');
		expect(sql.favoritesMode).toBe(true);
	});

	it('omits favoritesMode when not set', () => {
		const file: KqlxFileV1 = {
			kind: 'kqlx',
			version: 1,
			state: {
				sections: [
					{
						type: 'sql',
						id: 'sql_nofav',
						query: 'SELECT 1',
					},
				],
			},
		};

		const text = stringifyKqlxFile(file);
		const result = parseKqlxText(text, { allowedKinds: ['kqlx', 'mdx', 'sqlx'] });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const sql = result.file.state.sections[0] as Extract<KqlxSectionV1, { type: 'sql' }>;
		expect(sql.favoritesMode).toBeUndefined();
	});

	it('preserves favoritesMode: false when explicitly set', () => {
		const file: KqlxFileV1 = {
			kind: 'kqlx',
			version: 1,
			state: {
				sections: [
					{
						type: 'sql',
						id: 'sql_fav_false',
						query: 'SELECT 1',
						favoritesMode: false,
					},
				],
			},
		};

		const text = stringifyKqlxFile(file);
		const result = parseKqlxText(text, { allowedKinds: ['kqlx', 'mdx', 'sqlx'] });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const sql = result.file.state.sections[0] as Extract<KqlxSectionV1, { type: 'sql' }>;
		expect(sql.favoritesMode).toBe(false);
	});

	it('round-trips sql section with favoritesMode alongside other fields', () => {
		const file: KqlxFileV1 = {
			kind: 'kqlx',
			version: 1,
			state: {
				sections: [
					{
						type: 'sql',
						id: 'sql_full',
						name: 'Full Test',
						query: 'SELECT * FROM orders',
						serverUrl: 'prod.database.windows.net',
						database: 'sales',
						expanded: true,
						resultsVisible: true,
						favoritesMode: true,
						editorHeightPx: 300,
						resultsHeightPx: 200,
						copilotChatVisible: false,
					},
				],
			},
		};

		const text = stringifyKqlxFile(file);
		const result = parseKqlxText(text, { allowedKinds: ['kqlx', 'mdx', 'sqlx'] });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const sql = result.file.state.sections[0] as Extract<KqlxSectionV1, { type: 'sql' }>;
		expect(sql.favoritesMode).toBe(true);
		expect(sql.serverUrl).toBe('prod.database.windows.net');
		expect(sql.database).toBe('sales');
		expect(sql.editorHeightPx).toBe(300);
		expect(sql.resultsHeightPx).toBe(200);
	});
});

describe('SQL Favorites — SqlFavorite type validation', () => {
	it('SqlFavorite type matches expected shape', () => {
		const fav: SqlFavorite = {
			name: 'Prod Sales',
			connectionId: 'sql_abc123',
			database: 'sales',
		};
		expect(fav.name).toBe('Prod Sales');
		expect(fav.connectionId).toBe('sql_abc123');
		expect(fav.database).toBe('sales');
	});

	it('SqlFavorite key is connectionId+database (not clusterUrl)', () => {
		const fav: SqlFavorite = {
			name: 'Test',
			connectionId: 'sql_conn1',
			database: 'testdb',
		};
		const key = `${fav.connectionId}|${fav.database.toLowerCase()}`;
		expect(key).toBe('sql_conn1|testdb');
	});
});

describe('SQL Favorites — STORAGE_KEYS', () => {
	it('has sqlFavorites storage key', () => {
		expect(STORAGE_KEYS.sqlFavorites).toBe('sql.favorites');
	});
});
