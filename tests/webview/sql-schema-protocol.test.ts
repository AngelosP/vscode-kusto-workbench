import { describe, expect, it } from 'vitest';

import {
	isSqlSchemaHostMessageType,
	isSqlSchemaWebviewMessageType,
	parseSqlSchemaHostMessage,
	parseSqlSchemaWebviewMessage,
} from '../../src/shared/sqlSchemaProtocol.js';

const identity = {
	boxId: ' sql-box ',
	sectionInstanceId: ' sql-instance ',
	sqlConnectionId: ' sql-connection ',
	database: ' Database ',
	targetGeneration: 7,
	serverUrl: ' tcp:server.example ',
} as const;

describe('SQL schema protocol', () => {
	it('accepts requests without normalizing identity or optional forceRefresh', () => {
		const requests = [
			{
				type: 'prefetchSqlSchema', sqlConnectionId: '', database: '', boxId: '',
				sectionInstanceId: '', targetGeneration: 0,
			},
			{
				type: 'prefetchSqlSchema', sqlConnectionId: ' connection ', database: ' database ',
				boxId: ' box ', sectionInstanceId: ' instance ', targetGeneration: 9,
				forceRefresh: false,
			},
		] as const;

		for (const request of requests) {
			expect(isSqlSchemaWebviewMessageType(request)).toBe(true);
			const parsed = parseSqlSchemaWebviewMessage(request);
			expect(parsed).toEqual({ ok: true, value: request });
			if (parsed.ok) expect(parsed.value).toBe(request);
		}
	});

	it('accepts canonical success and error deliveries without cloning nested values', () => {
		const schema = {
			tables: ['Events'],
			views: [],
			columnsByTable: { Events: { Id: 'int', Name: 'nvarchar' } },
			storedProcedures: [{
				name: 'RefreshEvents', schema: 'dbo', parametersText: '@force bit', body: 'SELECT 1',
			}],
		};
		const success = {
			type: 'sqlSchemaData',
			...identity,
			schema,
			schemaMeta: { fromCache: false, tablesCount: 1, columnsCount: 2 },
		} as const;
		const error = {
			type: 'sqlSchemaData',
			...identity,
			schema: null,
			schemaMeta: { error: true, errorMessage: '' },
		} as const;

		for (const delivery of [success, error]) {
			expect(isSqlSchemaHostMessageType(delivery)).toBe(true);
			const parsed = parseSqlSchemaHostMessage(delivery);
			expect(parsed).toEqual({ ok: true, value: delivery });
			if (parsed.ok) expect(parsed.value).toBe(delivery);
		}
		const parsedSuccess = parseSqlSchemaHostMessage(success);
		if (parsedSuccess.ok && parsedSuccess.value.schema) {
			expect(parsedSuccess.value.schema).toBe(schema);
			expect(parsedSuccess.value.schema.columnsByTable).toBe(schema.columnsByTable);
		}
	});

	it('preserves dense empty table and column collections', () => {
		const delivery = {
			type: 'sqlSchemaData', ...identity,
			schema: { tables: [], views: [], columnsByTable: {}, storedProcedures: [] },
			schemaMeta: { fromCache: true, tablesCount: 0, columnsCount: 0 },
		} as const;

		const parsed = parseSqlSchemaHostMessage(delivery);
		expect(parsed).toEqual({ ok: true, value: delivery });
		if (parsed.ok) expect(parsed.value).toBe(delivery);
	});

	it('rejects malformed recognized requests while preserving the discriminator claim', () => {
		const arrayRequest = Object.assign([], {
			type: 'prefetchSqlSchema', sqlConnectionId: 'connection', database: 'Db', boxId: 'box',
			sectionInstanceId: 'instance', targetGeneration: 1,
		});
		for (const request of [
			arrayRequest,
			{ type: 'prefetchSqlSchema', sqlConnectionId: 1, database: 'Db', boxId: 'box', sectionInstanceId: 'instance', targetGeneration: 1 },
			{ type: 'prefetchSqlSchema', sqlConnectionId: 'connection', database: null, boxId: 'box', sectionInstanceId: 'instance', targetGeneration: 1 },
			{ type: 'prefetchSqlSchema', sqlConnectionId: 'connection', database: 'Db', boxId: false, sectionInstanceId: 'instance', targetGeneration: 1 },
			{ type: 'prefetchSqlSchema', sqlConnectionId: 'connection', database: 'Db', boxId: 'box', sectionInstanceId: 2, targetGeneration: 1 },
			{ type: 'prefetchSqlSchema', sqlConnectionId: 'connection', database: 'Db', boxId: 'box', sectionInstanceId: 'instance', targetGeneration: -1 },
			{ type: 'prefetchSqlSchema', sqlConnectionId: 'connection', database: 'Db', boxId: 'box', sectionInstanceId: 'instance', targetGeneration: 1.5 },
			{ type: 'prefetchSqlSchema', sqlConnectionId: 'connection', database: 'Db', boxId: 'box', sectionInstanceId: 'instance', targetGeneration: 1, forceRefresh: 'yes' },
		]) {
			expect(isSqlSchemaWebviewMessageType(request)).toBe(true);
			expect(parseSqlSchemaWebviewMessage(request)).toMatchObject({ ok: false });
		}
	});

	it('rejects malformed delivery identity and success or error metadata', () => {
		const schema = { tables: ['Events'], columnsByTable: { Events: { Id: 'int' } } };
		const successMeta = { fromCache: false, tablesCount: 1, columnsCount: 1 };
		const arrayDelivery = Object.assign([], {
			type: 'sqlSchemaData', ...identity, schema, schemaMeta: successMeta,
		});
		for (const delivery of [
			arrayDelivery,
			{ type: 'sqlSchemaData', ...identity, boxId: 1, schema, schemaMeta: successMeta },
			{ type: 'sqlSchemaData', ...identity, sectionInstanceId: null, schema, schemaMeta: successMeta },
			{ type: 'sqlSchemaData', ...identity, sqlConnectionId: false, schema, schemaMeta: successMeta },
			{ type: 'sqlSchemaData', ...identity, database: undefined, schema, schemaMeta: successMeta },
			{ type: 'sqlSchemaData', ...identity, serverUrl: 42, schema, schemaMeta: successMeta },
			{ type: 'sqlSchemaData', ...identity, targetGeneration: Number.MAX_SAFE_INTEGER + 1, schema, schemaMeta: successMeta },
			{ type: 'sqlSchemaData', ...identity, schema, schemaMeta: null },
			{ type: 'sqlSchemaData', ...identity, schema, schemaMeta: { ...successMeta, fromCache: 'no' } },
			{ type: 'sqlSchemaData', ...identity, schema, schemaMeta: { ...successMeta, tablesCount: -1 } },
			{ type: 'sqlSchemaData', ...identity, schema, schemaMeta: { ...successMeta, columnsCount: 1.5 } },
			{ type: 'sqlSchemaData', ...identity, schema, schemaMeta: { ...successMeta, error: false } },
			{ type: 'sqlSchemaData', ...identity, schema, schemaMeta: { ...successMeta, errorMessage: 'failed' } },
			{ type: 'sqlSchemaData', ...identity, schema, schemaMeta: { error: true, errorMessage: 'failed' } },
			{ type: 'sqlSchemaData', ...identity, schema: null, schemaMeta: { error: 'yes', errorMessage: 'failed' } },
			{ type: 'sqlSchemaData', ...identity, schema: null, schemaMeta: { error: true, errorMessage: 9 } },
			{ type: 'sqlSchemaData', ...identity, schema: null, schemaMeta: { error: true, errorMessage: 'failed', fromCache: false } },
			{ type: 'sqlSchemaData', ...identity, schema: null, schemaMeta: { error: true, errorMessage: 'failed', tablesCount: 0 } },
			{ type: 'sqlSchemaData', ...identity, schema: null, schemaMeta: { error: true, errorMessage: 'failed', columnsCount: 0 } },
		]) {
			expect(isSqlSchemaHostMessageType(delivery)).toBe(true);
			expect(parseSqlSchemaHostMessage(delivery)).toMatchObject({ ok: false });
		}
	});

	it('rejects non-canonical schema arrays, column maps, and stored procedures', () => {
		const successMeta = { fromCache: false, tablesCount: 1, columnsCount: 1 };
		const sparseTables = new Array<string>(1);
		const inheritedTables = new Array<string>(1);
		const inheritedTablePrototype = Object.create(Array.prototype) as string[];
		inheritedTablePrototype[0] = 'InheritedEvents';
		Object.setPrototypeOf(inheritedTables, inheritedTablePrototype);
		const sparseProcedures = new Array<Record<string, string>>(1);
		for (const schema of [
			{ tables: sparseTables, columnsByTable: {} },
			{ tables: inheritedTables, columnsByTable: {} },
			{ tables: ['Events', 42], columnsByTable: {} },
			{ tables: ['Events'], views: ['CurrentView', 7], columnsByTable: {} },
			{ tables: ['Events'], columnsByTable: [] },
			{ tables: ['Events'], columnsByTable: { Events: ['Id'] } },
			{ tables: ['Events'], columnsByTable: { Events: { Id: 42 } } },
			{ tables: ['Events'], columnsByTable: {}, storedProcedures: sparseProcedures },
			{ tables: ['Events'], columnsByTable: {}, storedProcedures: [{ schema: 'dbo' }] },
			{ tables: ['Events'], columnsByTable: {}, storedProcedures: [{ name: 'Refresh', body: false }] },
		]) {
			const delivery = { type: 'sqlSchemaData', ...identity, schema, schemaMeta: successMeta };
			expect(parseSqlSchemaHostMessage(delivery)).toMatchObject({ ok: false });
		}
	});

	it('does not claim unrelated traffic and rejects unknown parser inputs', () => {
		expect(isSqlSchemaWebviewMessageType({ type: 'getSqlConnections' })).toBe(false);
		expect(isSqlSchemaHostMessageType({ type: 'sqlDatabasesData' })).toBe(false);
		expect(parseSqlSchemaWebviewMessage(null)).toMatchObject({ ok: false });
		expect(parseSqlSchemaWebviewMessage({ type: 'sqlSchemaData' })).toMatchObject({ ok: false });
		expect(parseSqlSchemaHostMessage([])).toMatchObject({ ok: false });
		expect(parseSqlSchemaHostMessage({ type: 'prefetchSqlSchema' })).toMatchObject({ ok: false });
	});
});
