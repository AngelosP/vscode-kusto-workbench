import { describe, expect, it } from 'vitest';
import {
	MSSQL_STORED_PROCEDURE_SCHEMA_QUERY,
	MSSQL_TABLE_SCHEMA_QUERY,
	parseMssqlSchemaRows,
} from '../../../src/host/sql/mssqlSchema';

describe('MSSQL schema contract', () => {
	it('preserves the existing catalog queries', () => {
		expect(MSSQL_TABLE_SCHEMA_QUERY).toContain('INFORMATION_SCHEMA.COLUMNS');
		expect(MSSQL_TABLE_SCHEMA_QUERY).toContain('ORDER BY c.TABLE_SCHEMA, c.TABLE_NAME, c.ORDINAL_POSITION');
		expect(MSSQL_STORED_PROCEDURE_SCHEMA_QUERY).toContain("WHERE r.ROUTINE_TYPE = 'PROCEDURE'");
		expect(MSSQL_STORED_PROCEDURE_SCHEMA_QUERY).toContain('ORDER BY r.ROUTINE_SCHEMA, r.ROUTINE_NAME, p.ORDINAL_POSITION');
	});

	it('parses tables, views, qualified names, columns, and procedures', () => {
		const schema = parseMssqlSchemaRows([
			{ TABLE_SCHEMA: 'dbo', TABLE_NAME: 'Users', COLUMN_NAME: 'Id', DATA_TYPE: 'int', TABLE_TYPE: 'BASE TABLE' },
			{ TABLE_SCHEMA: 'dbo', TABLE_NAME: 'Users', COLUMN_NAME: 'Name', DATA_TYPE: 'nvarchar', TABLE_TYPE: 'BASE TABLE' },
			{ TABLE_SCHEMA: 'Sales', TABLE_NAME: 'Orders', COLUMN_NAME: 'Total', DATA_TYPE: 'decimal', TABLE_TYPE: 'BASE TABLE' },
			{ TABLE_SCHEMA: 'reporting', TABLE_NAME: 'ActiveUsers', COLUMN_NAME: 'UserId', DATA_TYPE: 'int', TABLE_TYPE: 'VIEW' },
		], [
			{ ROUTINE_SCHEMA: 'dbo', ROUTINE_NAME: 'GetUsers', ROUTINE_DEFINITION: 'SELECT * FROM dbo.Users', PARAMETER_NAME: '@limit', PARAM_TYPE: 'int' },
			{ ROUTINE_SCHEMA: 'dbo', ROUTINE_NAME: 'GetUsers', ROUTINE_DEFINITION: 'SELECT * FROM dbo.Users', PARAMETER_NAME: '@name', PARAM_TYPE: 'nvarchar' },
			{ ROUTINE_SCHEMA: 'Sales', ROUTINE_NAME: 'GetOrders', ROUTINE_DEFINITION: null, PARAMETER_NAME: null, PARAM_TYPE: null },
		]);

		expect(schema.tables).toEqual(['Users', 'Sales.Orders']);
		expect(schema.views).toEqual(['reporting.ActiveUsers']);
		expect(schema.columnsByTable).toEqual({
			Users: { Id: 'int', Name: 'nvarchar' },
			'Sales.Orders': { Total: 'decimal' },
			'reporting.ActiveUsers': { UserId: 'int' },
		});
		expect(schema.storedProcedures).toEqual([
			{ name: 'GetUsers', schema: 'dbo', body: 'SELECT * FROM dbo.Users', parametersText: '@limit int, @name nvarchar' },
			{ name: 'Sales.GetOrders', schema: 'Sales', body: undefined },
		]);
	});
});