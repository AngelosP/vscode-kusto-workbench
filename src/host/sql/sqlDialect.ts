import type { QueryResult } from '../kustoClient';

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

/** Connection credentials resolved at call time. */
export interface SqlCredentials {
	/** Azure AD access token (for AAD auth). */
	accessToken?: string;
	/** SQL login username. */
	username?: string;
	/** SQL login password. */
	password?: string;
}

/** Configuration needed to create a connection pool. */
export interface SqlPoolConfig {
	serverUrl: string;
	port?: number;
	database?: string;
	credentials: SqlCredentials;
	/** Client-side query timeout in milliseconds. */
	timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// SqlDialect interface
// ---------------------------------------------------------------------------

/**
 * Abstraction for a SQL backend (MSSQL, PostgreSQL, MySQL, etc.).
 *
 * Each dialect is a single-file implementation that knows how to create
 * connection pools, execute queries, retrieve schema, and classify errors
 * for one specific database engine.
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

	// ── Pool lifecycle ─────────────────────────────────────────────────

	/** Create (or return an existing) connection pool for the given config. */
	createPool(config: SqlPoolConfig): Promise<unknown>;
	/** Close and discard a previously created pool. */
	closePool(pool: unknown): Promise<void>;

	// ── Query execution ────────────────────────────────────────────────

	/**
	 * Execute a SQL query and return a `QueryResult` compatible with the
	 * Kusto result format so Chart / Transformation sections work unchanged.
	 *
	 * Cells in `rows` MUST be pre-formatted via `formatCellValue()`.
	 */
	executeQuery(pool: unknown, database: string, query: string, timeoutMs?: number): Promise<QueryResult>;

	/**
	 * Attempt to cancel a running query.  Best-effort — implementations
	 * may close the pool as a fallback.
	 */
	cancelQuery(pool: unknown): Promise<void>;

	// ── Schema introspection ───────────────────────────────────────────

	/** List available databases on the server. */
	getDatabases(pool: unknown): Promise<string[]>;
	/** Get schema (tables + columns) for a specific database. */
	getDatabaseSchema(pool: unknown, database: string): Promise<SqlDatabaseSchemaIndex>;

	// ── Error classification ───────────────────────────────────────────

	/** Format a raw error into a user-friendly message string. */
	formatError(error: unknown): string;
	/** Return `true` if the error indicates an authentication/authorization failure. */
	isAuthError(error: unknown): boolean;
	/** Return `true` if the error indicates the query was cancelled. */
	isCancelError(error: unknown): boolean;
}
