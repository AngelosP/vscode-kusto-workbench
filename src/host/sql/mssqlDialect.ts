import type { ConnectionPool as MssqlConnectionPool, IColumnMetadata } from 'mssql';
import type { QueryResult } from '../kustoClient';
import { formatCellValue } from '../kustoClientUtils';
import type {
	SqlDialect,
	SqlAuthTypeDescriptor,
	SqlPoolConfig,
	SqlDatabaseSchemaIndex,
	SqlStoredProcedure,
} from './sqlDialect';

/**
 * Dynamic-import helper that handles ESM/CJS interop.
 * `import('mssql')` in a CJS bundle returns `{ default: <module> }`,
 * so named exports like `ConnectionPool` live on `.default`.
 */
async function loadMssql(): Promise<typeof import('mssql')> {
	const mod = await import('mssql') as any;
	return mod.default ?? mod;
}

// ---------------------------------------------------------------------------
// MSSQL Dialect — Azure SQL / SQL Server (T-SQL)
// ---------------------------------------------------------------------------

/**
 * `SqlDialect` implementation for Microsoft SQL Server and Azure SQL Database.
 *
 * Uses the `mssql` npm package (which wraps `tedious`) for connection pooling
 * and query execution.  The package is **dynamically imported** to keep start-up
 * cost low and must be listed as `external` in esbuild.
 */
export class MssqlDialect implements SqlDialect {
	readonly id = 'mssql';
	readonly displayName = 'Azure SQL / SQL Server';
	readonly defaultPort = 1433;
	readonly authTypes: SqlAuthTypeDescriptor[] = [
		{ id: 'aad', label: 'Azure AD (Entra ID)' },
		{ id: 'sql-login', label: 'SQL Login (username / password)' },
	];

	// ── Pool lifecycle ─────────────────────────────────────────────────

	async createPool(config: SqlPoolConfig): Promise<MssqlConnectionPool> {
		const { ConnectionPool } = await loadMssql();

		const poolConfig: import('mssql').config = {
			server: config.serverUrl,
			port: config.port ?? this.defaultPort,
			database: config.database ?? 'master',
			options: {
				encrypt: true,
				trustServerCertificate: false,
			},
			requestTimeout: config.timeoutMs ?? 120_000,
			connectionTimeout: 30_000,
		};

		if (config.credentials.accessToken) {
			// Azure AD token-based authentication
			poolConfig.authentication = {
				type: 'azure-active-directory-access-token',
				options: { token: config.credentials.accessToken },
			};
		} else if (config.credentials.username && config.credentials.password) {
			// SQL Login authentication
			poolConfig.user = config.credentials.username;
			poolConfig.password = config.credentials.password;
		} else {
			throw new Error('No credentials provided. Supply an Azure AD token or SQL login credentials.');
		}

		const pool = new ConnectionPool(poolConfig);
		await pool.connect();
		return pool;
	}

	async closePool(pool: unknown): Promise<void> {
		try {
			const p = pool as MssqlConnectionPool;
			await p.close();
		} catch {
			// Best-effort — pool may already be closed.
		}
	}

	// ── Query execution ────────────────────────────────────────────────

	async executeQuery(pool: unknown, database: string, query: string, timeoutMs?: number): Promise<QueryResult> {
		const { Request } = await loadMssql();
		const p = pool as MssqlConnectionPool;

		const startTime = Date.now();

		const request = new Request(p);
		if (timeoutMs && timeoutMs > 0) {
			request.timeout = timeoutMs;
		}

		// USE [database] is not supported in Azure SQL Database — the pool is
		// already connected to the target database, so we query directly.
		const result = await request.query(query);

		const executionTime = ((Date.now() - startTime) / 1000).toFixed(3) + 's';

		// `result.recordset` is the primary result set.
		const recordset = result.recordset ?? [];
		const columnMeta: Array<{ name: string; type: string }> = [];

		if (result.recordset?.columns) {
			for (const [colName, colInfo] of Object.entries(result.recordset.columns)) {
				const typeName = this.mapMssqlType(colInfo);
				columnMeta.push({ name: colName, type: typeName });
			}
		}

		const rows: unknown[][] = [];
		for (const row of recordset) {
			const arr: unknown[] = [];
			for (const col of columnMeta) {
				arr.push(formatCellValue((row as Record<string, unknown>)[col.name]));
			}
			rows.push(arr);
		}

		return {
			columns: columnMeta,
			rows,
			metadata: {
				cluster: `sql://${p.config?.server ?? 'unknown'}`,
				database,
				executionTime,
			},
		};
	}

	async cancelQuery(pool: unknown): Promise<void> {
		// mssql doesn't expose per-request cancellation.
		// Closing the pool is the only reliable way to abort.
		await this.closePool(pool);
	}

	// ── Schema introspection ───────────────────────────────────────────

	async getDatabases(pool: unknown): Promise<string[]> {
		const { Request } = await loadMssql();
		const p = pool as MssqlConnectionPool;
		const request = new Request(p);
		const result = await request.query(
			`SELECT name FROM sys.databases WHERE state_desc = 'ONLINE' ORDER BY name`
		);
		return (result.recordset ?? []).map((r: Record<string, unknown>) => String(r.name));
	}

	async getDatabaseSchema(pool: unknown, _database: string): Promise<SqlDatabaseSchemaIndex> {
		const { Request } = await loadMssql();
		const p = pool as MssqlConnectionPool;
		const request = new Request(p);
		// Pool is already connected to the target database — query directly.
		// (USE [database] is not supported in Azure SQL Database.)
		// Include TABLE_SCHEMA so non-dbo tables get their schema prefix.
		const result = await request.query(
			`SELECT c.TABLE_SCHEMA, c.TABLE_NAME, c.COLUMN_NAME, c.DATA_TYPE, t.TABLE_TYPE ` +
			`FROM INFORMATION_SCHEMA.COLUMNS c ` +
			`JOIN INFORMATION_SCHEMA.TABLES t ON c.TABLE_SCHEMA = t.TABLE_SCHEMA AND c.TABLE_NAME = t.TABLE_NAME ` +
			`ORDER BY c.TABLE_SCHEMA, c.TABLE_NAME, c.ORDINAL_POSITION`
		);

		const tables: string[] = [];
		const views: string[] = [];
		const columnsByTable: Record<string, Record<string, string>> = {};

		for (const row of result.recordset ?? []) {
			const r = row as Record<string, unknown>;
			const schema = String(r.TABLE_SCHEMA);
			const rawTable = String(r.TABLE_NAME);
			const tableType = String(r.TABLE_TYPE);
			// Use schema-qualified name for non-dbo schemas (e.g. SalesLT.Product).
			const table = schema.toLowerCase() === 'dbo' ? rawTable : `${schema}.${rawTable}`;
			const column = String(r.COLUMN_NAME);
			const dataType = String(r.DATA_TYPE);

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

		// Fetch stored procedures
		const spRequest = new Request(p);
		const spResult = await spRequest.query(
			`SELECT r.ROUTINE_SCHEMA, r.ROUTINE_NAME, r.ROUTINE_DEFINITION, ` +
			`p.PARAMETER_NAME, p.DATA_TYPE AS PARAM_TYPE, p.PARAMETER_MODE ` +
			`FROM INFORMATION_SCHEMA.ROUTINES r ` +
			`LEFT JOIN INFORMATION_SCHEMA.PARAMETERS p ` +
			`ON r.ROUTINE_SCHEMA = p.SPECIFIC_SCHEMA AND r.ROUTINE_NAME = p.SPECIFIC_NAME ` +
			`WHERE r.ROUTINE_TYPE = 'PROCEDURE' ` +
			`ORDER BY r.ROUTINE_SCHEMA, r.ROUTINE_NAME, p.ORDINAL_POSITION`
		);

		const spMap = new Map<string, SqlStoredProcedure>();
		for (const row of spResult.recordset ?? []) {
			const r = row as Record<string, unknown>;
			const spSchema = String(r.ROUTINE_SCHEMA);
			const rawName = String(r.ROUTINE_NAME);
			const spName = spSchema.toLowerCase() === 'dbo' ? rawName : `${spSchema}.${rawName}`;

			if (!spMap.has(spName)) {
				spMap.set(spName, {
					name: spName,
					schema: spSchema,
					body: r.ROUTINE_DEFINITION ? String(r.ROUTINE_DEFINITION) : undefined,
				});
			}
			if (r.PARAMETER_NAME) {
				const sp = spMap.get(spName)!;
				const paramName = String(r.PARAMETER_NAME);
				const paramType = String(r.PARAM_TYPE);
				const existing = sp.parametersText || '';
				sp.parametersText = existing ? `${existing}, ${paramName} ${paramType}` : `${paramName} ${paramType}`;
			}
		}

		const storedProcedures = [...spMap.values()];

		return { tables, views, columnsByTable, storedProcedures };
	}

	// ── Error classification ───────────────────────────────────────────

	formatError(error: unknown): string {
		if (error instanceof Error) {
			// mssql errors often have a `number` property with the SQL error code.
			const sqlError = error as Error & { number?: number; code?: string };
			const parts: string[] = [];
			if (sqlError.number) {
				parts.push(`SQL Error ${sqlError.number}`);
			}
			if (sqlError.code) {
				parts.push(`[${sqlError.code}]`);
			}
			parts.push(sqlError.message);
			return parts.join(': ');
		}
		return String(error);
	}

	isAuthError(error: unknown): boolean {
		if (!(error instanceof Error)) {
			return false;
		}
		const sqlError = error as Error & { number?: number; code?: string };
		// SQL Server login failure error numbers.
		if (sqlError.number === 18456 || sqlError.number === 18452) {
			return true;
		}
		const msg = sqlError.message.toLowerCase();
		if (msg.includes('login failed') || msg.includes('unauthorized') || msg.includes('authentication')) {
			return true;
		}
		if (sqlError.code === 'ELOGIN') {
			return true;
		}
		return false;
	}

	isCancelError(error: unknown): boolean {
		if (!(error instanceof Error)) {
			return false;
		}
		const sqlError = error as Error & { code?: string };
		if (sqlError.code === 'ECANCEL' || sqlError.code === 'EABORT') {
			return true;
		}
		const msg = sqlError.message.toLowerCase();
		return msg.includes('cancelled') || msg.includes('canceled') || msg.includes('aborted');
	}

	// ── Private helpers ────────────────────────────────────────────────

	/**
	 * Wrap a SQL identifier in square brackets, escaping any embedded `]`.
	 * Prevents SQL injection for database / table names injected into queries.
	 */
	private bracketIdentifier(name: string): string {
		return `[${name.replace(/\]/g, ']]')}]`;
	}

	/**
	 * Map an mssql column metadata entry to a human-readable type name.
	 */
	private mapMssqlType(colInfo: IColumnMetadata): string {
		const type = colInfo.type;
		if (type && typeof type === 'function') {
			const decl = (type as unknown as { declaration?: string }).declaration;
			if (typeof decl === 'string') {
				return decl;
			}
		}
		if (typeof type === 'string') {
			return type;
		}
		return 'unknown';
	}
}
