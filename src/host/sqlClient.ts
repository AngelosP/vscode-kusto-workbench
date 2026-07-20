import * as vscode from 'vscode';
import type { QueryResult } from './kustoClient';
import type { SqlConnection } from './sqlConnectionManager';
import type { SqlDatabaseSchemaIndex } from './sql/sqlDialect';
import { MSSQL_STORED_PROCEDURE_SCHEMA_QUERY, MSSQL_TABLE_SCHEMA_QUERY, parseMssqlSchemaRows } from './sql/mssqlSchema';
import { SqlQueryExecutionError } from './sql/sqlErrors';
import type { StsQueryService } from './sql/stsQueryService';

export { SqlQueryCancelledError, SqlQueryExecutionError } from './sql/sqlErrors';

// ---------------------------------------------------------------------------
// SqlQueryClient
// ---------------------------------------------------------------------------

/**
 * Stable SQL data-plane facade. SQL Tools Service owns connectivity, execution,
 * cancellation, and result buffering; callers remain transport-independent.
 */
export class SqlQueryClient {
	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly queryService: StsQueryService,
	) {}

	// ── Public API ───────────────────────────────────────────────────

	async getDatabases(connection: SqlConnection, options?: { passwordOverride?: string; allowUncommittedTarget?: boolean; signal?: AbortSignal }): Promise<string[]> {
		this.assertMssql(connection);
		return this.queryService.getDatabases(connection, options?.passwordOverride, options?.allowUncommittedTarget, options?.signal);
	}

	async getDatabaseSchema(connection: SqlConnection, database: string, options?: { signal?: AbortSignal }): Promise<SqlDatabaseSchemaIndex> {
		this.assertMssql(connection);
		const tableResultPromise = this.queryService.executeQuery(connection, database, MSSQL_TABLE_SCHEMA_QUERY, this.getTimeoutMs(), options?.signal);
		const procedureResultPromise = this.queryService.executeQuery(connection, database, MSSQL_STORED_PROCEDURE_SCHEMA_QUERY, this.getTimeoutMs(), options?.signal);
		const [tableResult, procedureResult] = await Promise.all([tableResultPromise, procedureResultPromise]);
		return parseMssqlSchemaRows(this.toRecords(tableResult), this.toRecords(procedureResult));
	}

	async executeQuery(connection: SqlConnection, database: string, query: string, options?: { signal?: AbortSignal }): Promise<QueryResult> {
		this.assertMssql(connection);
		return this.queryService.executeQuery(connection, database, query, this.getTimeoutMs(), options?.signal);
	}

	/**
	 * Execute a SQL query with cancel support.
	 * Mirrors KustoQueryClient.executeQueryCancelable — the cancel() function
	 * immediately rejects the returned promise via a deferred race.
	 */
	executeQueryCancelable(
		connection: SqlConnection,
		database: string,
		query: string,
	): { promise: Promise<QueryResult>; cancel: () => void } {
		this.assertMssql(connection);
		return this.queryService.executeQueryCancelable(connection, database, query, this.getTimeoutMs());
	}

	// ── Private helpers ──────────────────────────────────────────────

	private getTimeoutMs(): number | undefined {
		const minutes = vscode.workspace.getConfiguration('kustoWorkbench').get<number>('sqlQueryTimeout', 20);
		return minutes > 0 ? minutes * 60 * 1000 : undefined;
	}

	private assertMssql(connection: SqlConnection): void {
		if (connection.dialect !== 'mssql') {
			throw new SqlQueryExecutionError(`SQL dialect "${connection.dialect}" is not registered.`);
		}
	}

	private toRecords(result: QueryResult): Array<Record<string, unknown>> {
		const names = result.columns.map(column => typeof column === 'string' ? column : column.name);
		return result.rows.map(row => Object.fromEntries(names.map((name, index) => {
			const cell = row[index];
			if (cell && typeof cell === 'object' && 'isNull' in cell && cell.isNull) return [name, null];
			if (cell && typeof cell === 'object' && 'full' in cell) return [name, cell.full];
			return [name, cell];
		})));
	}
}
