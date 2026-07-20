import type { SqlAuthTypeDescriptor, SqlDialect } from './sqlDialect';

// ---------------------------------------------------------------------------
// MSSQL Dialect — Azure SQL / SQL Server (T-SQL)
// ---------------------------------------------------------------------------

/**
 * Persisted/UI metadata for Microsoft SQL Server and Azure SQL Database.
 * SQL Tools Service provides the runtime data plane.
 */
export class MssqlDialect implements SqlDialect {
	readonly id = 'mssql';
	readonly displayName = 'Azure SQL / SQL Server';
	readonly defaultPort = 1433;
	readonly authTypes: SqlAuthTypeDescriptor[] = [
		{ id: 'aad', label: 'Azure AD (Entra ID)' },
		{ id: 'sql-login', label: 'SQL Login (username / password)' },
	];
}
