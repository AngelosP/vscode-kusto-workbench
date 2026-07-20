import type { SqlDatabaseSchemaIndex, SqlStoredProcedure } from './sqlDialect';

export const MSSQL_TABLE_SCHEMA_QUERY =
	`SELECT c.TABLE_SCHEMA, c.TABLE_NAME, c.COLUMN_NAME, c.DATA_TYPE, t.TABLE_TYPE ` +
	`FROM INFORMATION_SCHEMA.COLUMNS c ` +
	`JOIN INFORMATION_SCHEMA.TABLES t ON c.TABLE_SCHEMA = t.TABLE_SCHEMA AND c.TABLE_NAME = t.TABLE_NAME ` +
	`ORDER BY c.TABLE_SCHEMA, c.TABLE_NAME, c.ORDINAL_POSITION`;

export const MSSQL_STORED_PROCEDURE_SCHEMA_QUERY =
	`SELECT r.ROUTINE_SCHEMA, r.ROUTINE_NAME, r.ROUTINE_DEFINITION, ` +
	`p.PARAMETER_NAME, p.DATA_TYPE AS PARAM_TYPE, p.PARAMETER_MODE ` +
	`FROM INFORMATION_SCHEMA.ROUTINES r ` +
	`LEFT JOIN INFORMATION_SCHEMA.PARAMETERS p ` +
	`ON r.ROUTINE_SCHEMA = p.SPECIFIC_SCHEMA AND r.ROUTINE_NAME = p.SPECIFIC_NAME ` +
	`WHERE r.ROUTINE_TYPE = 'PROCEDURE' ` +
	`ORDER BY r.ROUTINE_SCHEMA, r.ROUTINE_NAME, p.ORDINAL_POSITION`;

export function parseMssqlSchemaRows(
	tableRows: ReadonlyArray<Record<string, unknown>>,
	procedureRows: ReadonlyArray<Record<string, unknown>>,
): SqlDatabaseSchemaIndex {
	const tables: string[] = [];
	const views: string[] = [];
	const columnsByTable: Record<string, Record<string, string>> = {};

	for (const row of tableRows) {
		const schema = String(row.TABLE_SCHEMA ?? '');
		const rawTable = String(row.TABLE_NAME ?? '');
		const tableType = String(row.TABLE_TYPE ?? '');
		const column = String(row.COLUMN_NAME ?? '');
		const dataType = String(row.DATA_TYPE ?? '');
		if (!rawTable || !column) continue;

		const table = schema.toLowerCase() === 'dbo' || !schema ? rawTable : `${schema}.${rawTable}`;
		if (!columnsByTable[table]) {
			columnsByTable[table] = {};
			if (tableType === 'VIEW') {
				views.push(table);
			} else {
				tables.push(table);
			}
		}
		columnsByTable[table][column] = dataType;
	}

	const procedures = new Map<string, SqlStoredProcedure>();
	for (const row of procedureRows) {
		const schema = String(row.ROUTINE_SCHEMA ?? '');
		const rawName = String(row.ROUTINE_NAME ?? '');
		if (!rawName) continue;
		const name = schema.toLowerCase() === 'dbo' || !schema ? rawName : `${schema}.${rawName}`;

		if (!procedures.has(name)) {
			procedures.set(name, {
				name,
				schema: schema || undefined,
				body: row.ROUTINE_DEFINITION ? String(row.ROUTINE_DEFINITION) : undefined,
			});
		}
		if (row.PARAMETER_NAME) {
			const procedure = procedures.get(name)!;
			const parameter = `${String(row.PARAMETER_NAME)} ${String(row.PARAM_TYPE ?? '')}`.trim();
			procedure.parametersText = procedure.parametersText
				? `${procedure.parametersText}, ${parameter}`
				: parameter;
		}
	}

	return { tables, views, columnsByTable, storedProcedures: [...procedures.values()] };
}