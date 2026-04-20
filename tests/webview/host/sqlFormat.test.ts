import { describe, it, expect } from 'vitest';
import { parseKqlxText, stringifyKqlxFile, createEmptyKqlxOrMdxFile } from '../../../src/host/kqlxFormat';
import type { KqlxFileV1, KqlxSectionV1 } from '../../../src/host/kqlxFormat';

describe('KqlxSectionV1 sql variant — parse round-trip', () => {
	it('parses a file with an sql section', () => {
		const file: KqlxFileV1 = {
			kind: 'kqlx',
			version: 1,
			state: {
				sections: [
					{
						type: 'sql',
						id: 'sql_1234',
						name: 'User count',
						query: 'SELECT COUNT(*) FROM users',
						serverUrl: 'myserver.database.windows.net',
						database: 'mydb',
						expanded: true,
					},
				],
			},
		};

		const text = stringifyKqlxFile(file);
		const result = parseKqlxText(text, { allowedKinds: ['kqlx', 'mdx', 'sqlx'] });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const sections = result.file.state.sections;
		expect(sections).toHaveLength(1);
		expect(sections[0].type).toBe('sql');
		const sql = sections[0] as Extract<KqlxSectionV1, { type: 'sql' }>;
		expect(sql.id).toBe('sql_1234');
		expect(sql.query).toBe('SELECT COUNT(*) FROM users');
		expect(sql.serverUrl).toBe('myserver.database.windows.net');
		expect(sql.database).toBe('mydb');
	});

	it('parses a mixed kqlx file with query + sql sections', () => {
		const file: KqlxFileV1 = {
			kind: 'kqlx',
			version: 1,
			state: {
				sections: [
					{
						type: 'query',
						id: 'query_1',
						query: 'StormEvents | take 10',
						clusterUrl: 'https://help.kusto.windows.net',
						database: 'Samples',
					},
					{
						type: 'sql',
						id: 'sql_2',
						query: 'SELECT TOP 10 * FROM orders',
						serverUrl: 'myserver.database.windows.net',
						database: 'SalesDB',
					},
				],
			},
		};
		const text = stringifyKqlxFile(file);
		const result = parseKqlxText(text, { allowedKinds: ['kqlx'] });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.file.state.sections).toHaveLength(2);
		expect(result.file.state.sections[0].type).toBe('query');
		expect(result.file.state.sections[1].type).toBe('sql');
	});

	it('parses a .sqlx file with kind sqlx', () => {
		const file: KqlxFileV1 = {
			kind: 'sqlx',
			version: 1,
			state: {
				sections: [
					{
						type: 'sql',
						id: 'sql_1',
						query: 'SELECT 1',
					},
				],
			},
		};
		const text = stringifyKqlxFile(file);
		const result = parseKqlxText(text, { allowedKinds: ['kqlx', 'mdx', 'sqlx'] });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.file.kind).toBe('sqlx');
	});

	it('rejects sqlx kind when not in allowedKinds', () => {
		const file: KqlxFileV1 = {
			kind: 'sqlx',
			version: 1,
			state: { sections: [] },
		};
		const text = stringifyKqlxFile(file);
		const result = parseKqlxText(text, { allowedKinds: ['kqlx'] });
		expect(result.ok).toBe(false);
	});

	it('sql section with all optional fields', () => {
		const file: KqlxFileV1 = {
			kind: 'kqlx',
			version: 1,
			state: {
				sections: [
					{
						type: 'sql',
						id: 'sql_full',
						name: 'Full SQL',
						query: 'SELECT * FROM products',
						serverUrl: 'sql.example.com',
						database: 'Shop',
						expanded: false,
						resultsVisible: true,
						editorHeightPx: 200,
						resultsHeightPx: 300,
						copilotChatVisible: true,
						copilotChatWidthPx: 400,
					},
				],
			},
		};
		const text = stringifyKqlxFile(file);
		const result = parseKqlxText(text, { allowedKinds: ['kqlx'] });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const sql = result.file.state.sections[0] as Extract<KqlxSectionV1, { type: 'sql' }>;
		expect(sql.expanded).toBe(false);
		expect(sql.editorHeightPx).toBe(200);
		expect(sql.resultsHeightPx).toBe(300);
		expect(sql.copilotChatVisible).toBe(true);
	});
});
