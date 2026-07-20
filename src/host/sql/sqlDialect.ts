// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

/** Descriptor for an authentication type supported by a dialect. */
export interface SqlAuthTypeDescriptor {
	id: string;
	label: string;
}

/** Database schema index for SQL — tables + columns by table. */
export interface SqlStoredProcedure {
	name: string;
	schema?: string;
	parametersText?: string;
	body?: string;
}

export interface SqlDatabaseSchemaIndex {
	tables: string[];
	views?: string[];
	columnsByTable: Record<string, Record<string, string>>;
	storedProcedures?: SqlStoredProcedure[];
}

// ---------------------------------------------------------------------------
// SqlDialect interface
// ---------------------------------------------------------------------------

/**
 * User-facing metadata for a persisted SQL dialect. Runtime connectivity is
 * provided by SQL Tools Service behind SqlQueryClient.
 */
export interface SqlDialect {
	/** Unique identifier (e.g. `'mssql'`, `'pg'`). */
	readonly id: string;
	/** Human-readable name (e.g. `'Azure SQL / SQL Server'`). */
	readonly displayName: string;
	/** Default TCP port for this engine. */
	readonly defaultPort: number;
	/** Authentication types this dialect supports. */
	readonly authTypes: SqlAuthTypeDescriptor[];
}
