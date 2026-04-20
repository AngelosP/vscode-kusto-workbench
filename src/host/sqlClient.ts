import * as vscode from 'vscode';
import type { QueryResult } from './kustoClient';
import type { SqlConnection, SqlConnectionManager } from './sqlConnectionManager';
import type { SqlDialect, SqlCredentials, SqlDatabaseSchemaIndex } from './sql/sqlDialect';
import { getDialect } from './sql/sqlDialectRegistry';
import { resolveSqlAadAccessToken } from './sql/sqlAuthState';

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export class SqlQueryCancelledError extends Error {
	readonly isCancelled = true;
	constructor(message: string = 'Query cancelled') {
		super(message);
		this.name = 'SqlQueryCancelledError';
	}
}

export class SqlQueryExecutionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'SqlQueryExecutionError';
	}
}

// ---------------------------------------------------------------------------
// SqlQueryClient
// ---------------------------------------------------------------------------

/**
 * Thin orchestrator that resolves a `SqlDialect` from the connection's dialect
 * identifier and delegates all operations.  Manages a pool cache and supports
 * cancelable query execution (mirroring KustoQueryClient's cancel race pattern).
 */
export class SqlQueryClient {
	/** Pool cache keyed by `connectionId`. */
	private pools = new Map<string, { pool: unknown; dialectId: string }>();
	/** Serialisation lock per connection to prevent duplicate pool creation. */
	private poolLocks = new Map<string, Promise<void>>();
	/** Cancelable pools: keyed by `clientKey`. */
	private cancelablePools = new Map<string, { pool: unknown; dialectId: string; database?: string }>();

	constructor(
		private readonly connectionManager: SqlConnectionManager,
		private readonly context: vscode.ExtensionContext,
	) {}

	// ── AAD auth helper ──────────────────────────────────────────────

	private async getAadToken(serverUrl: string): Promise<string> {
		const resolved = await resolveSqlAadAccessToken(this.context, serverUrl);
		if (!resolved.token) {
			throw new SqlQueryCancelledError('Sign-in cancelled');
		}
		return resolved.token;
	}

	// ── Credential resolution ────────────────────────────────────────

	private async resolveCredentials(connection: SqlConnection): Promise<SqlCredentials> {
		if (connection.authType === 'aad') {
			const accessToken = await this.getAadToken(connection.serverUrl);
			return { accessToken };
		}

		// SQL login — read password from SecretStorage.
		const password = await this.connectionManager.getPassword(connection.id);
		if (!password) {
			throw new SqlQueryExecutionError(
				'Password not found. Please re-enter your password for this connection.',
			);
		}
		return { username: connection.username, password };
	}

	// ── Dialect resolution ───────────────────────────────────────────

	private resolveDialect(dialectId: string): SqlDialect {
		const dialect = getDialect(dialectId);
		if (!dialect) {
			throw new SqlQueryExecutionError(`SQL dialect "${dialectId}" is not registered.`);
		}
		return dialect;
	}

	// ── Pool management ──────────────────────────────────────────────

	private async withPoolLock(connectionId: string, fn: () => Promise<void>): Promise<void> {
		const prev = this.poolLocks.get(connectionId) ?? Promise.resolve();
		const next = prev.then(() => fn(), () => fn());
		this.poolLocks.set(connectionId, next);
		try {
			await next;
		} finally {
			if (this.poolLocks.get(connectionId) === next) {
				this.poolLocks.delete(connectionId);
			}
		}
	}

	private async getOrCreatePool(connection: SqlConnection, database?: string): Promise<{ pool: unknown; dialect: SqlDialect }> {
		const dialect = this.resolveDialect(connection.dialect);
		const poolDb = database || connection.database;
		const poolKey = poolDb ? `${connection.id}|${poolDb}` : connection.id;
		const cached = this.pools.get(poolKey);
		if (cached && cached.dialectId === dialect.id) {
			return { pool: cached.pool, dialect };
		}

		// Serialise pool creation per connection.
		let result: { pool: unknown; dialect: SqlDialect } | undefined;
		await this.withPoolLock(poolKey, async () => {
			// Re-check after waiting.
			const reCached = this.pools.get(poolKey);
			if (reCached && reCached.dialectId === dialect.id) {
				result = { pool: reCached.pool, dialect };
				return;
			}

			const credentials = await this.resolveCredentials(connection);
			const timeoutMs = this.getTimeoutMs();
			const pool = await dialect.createPool({
				serverUrl: connection.serverUrl,
				port: connection.port,
				database: poolDb,
				credentials,
				timeoutMs,
			});
			this.pools.set(poolKey, { pool, dialectId: dialect.id });
			result = { pool, dialect };
		});

		if (!result) {
			throw new SqlQueryExecutionError('Failed to create connection pool.');
		}
		return result;
	}

	private async getOrCreateCancelablePool(
		connection: SqlConnection,
		clientKey: string,
		database?: string,
	): Promise<{ pool: unknown; dialect: SqlDialect }> {
		const dialect = this.resolveDialect(connection.dialect);
		const poolDb = database || connection.database;
		const cached = this.cancelablePools.get(clientKey);
		if (cached && cached.dialectId === dialect.id && cached.database === poolDb) {
			return { pool: cached.pool, dialect };
		}
		// Close previous pool for this key if dialect or database changed.
		if (cached) {
			const oldDialect = getDialect(cached.dialectId);
			if (oldDialect) {
				try { await oldDialect.closePool(cached.pool); } catch { /* ignore */ }
			}
			this.cancelablePools.delete(clientKey);
		}

		const credentials = await this.resolveCredentials(connection);
		const timeoutMs = this.getTimeoutMs();
		const pool = await dialect.createPool({
			serverUrl: connection.serverUrl,
			port: connection.port,
			database: poolDb,
			credentials,
			timeoutMs,
		});
		this.cancelablePools.set(clientKey, { pool, dialectId: dialect.id, database: poolDb });
		return { pool, dialect };
	}

	/** Evict and close the pool for a connection (e.g., after auth failure). */
	private async evictPool(connectionId: string): Promise<void> {
		const cached = this.pools.get(connectionId);
		if (cached) {
			this.pools.delete(connectionId);
			const dialect = this.resolveDialect(cached.dialectId);
			try { await dialect.closePool(cached.pool); } catch { /* ignore */ }
		}
	}

	/** Evict and close a cancelable pool. */
	private async evictCancelablePool(clientKey: string): Promise<void> {
		const cached = this.cancelablePools.get(clientKey);
		if (cached) {
			this.cancelablePools.delete(clientKey);
			const dialect = this.resolveDialect(cached.dialectId);
			try { await dialect.closePool(cached.pool); } catch { /* ignore */ }
		}
	}

	// ── Public API ───────────────────────────────────────────────────

	async getDatabases(connection: SqlConnection): Promise<string[]> {
		const { pool, dialect } = await this.getOrCreatePool(connection);
		try {
			return await dialect.getDatabases(pool);
		} catch (error) {
			if (dialect.isAuthError(error)) {
				await this.evictPool(connection.id);
			}
			throw new SqlQueryExecutionError(dialect.formatError(error));
		}
	}

	async getDatabaseSchema(connection: SqlConnection, database: string): Promise<SqlDatabaseSchemaIndex> {
		const { pool, dialect } = await this.getOrCreatePool(connection, database);
		try {
			return await dialect.getDatabaseSchema(pool, database);
		} catch (error) {
			if (dialect.isAuthError(error)) {
				await this.evictPool(`${connection.id}|${database}`);
			}
			throw new SqlQueryExecutionError(dialect.formatError(error));
		}
	}

	async executeQuery(connection: SqlConnection, database: string, query: string): Promise<QueryResult> {
		const { pool, dialect } = await this.getOrCreatePool(connection, database);
		try {
			return await dialect.executeQuery(pool, database, query, this.getTimeoutMs());
		} catch (error) {
			if (dialect.isCancelError(error)) {
				throw new SqlQueryCancelledError();
			}
			if (dialect.isAuthError(error)) {
				await this.evictPool(`${connection.id}|${database}`);
			}
			throw new SqlQueryExecutionError(dialect.formatError(error));
		}
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
		clientKey?: string,
	): { promise: Promise<QueryResult>; cancel: () => void } {
		const key = String(clientKey || connection.id || '').trim() || 'default';
		let cancelled = false;

		let rejectWithCancel: ((err: Error) => void) | undefined;
		const cancelPromise = new Promise<never>((_resolve, reject) => {
			rejectWithCancel = reject;
		});
		// Prevent unhandled-rejection noise.
		cancelPromise.catch(() => { /* intentionally ignored */ });

		const cancel = () => {
			cancelled = true;
			try { rejectWithCancel?.(new SqlQueryCancelledError()); } catch { /* ignore */ }
			void this.evictCancelablePool(key);
		};

		const executeAsync = async (): Promise<QueryResult> => {
			if (cancelled) {
				throw new SqlQueryCancelledError();
			}
			const { pool, dialect } = await this.getOrCreateCancelablePool(connection, key, database);
			if (cancelled) {
				throw new SqlQueryCancelledError();
			}
			try {
				return await dialect.executeQuery(pool, database, query, this.getTimeoutMs());
			} catch (error) {
				if (cancelled || dialect.isCancelError(error)) {
					throw new SqlQueryCancelledError();
				}
				if (dialect.isAuthError(error)) {
					await this.evictCancelablePool(key);
				}
				throw new SqlQueryExecutionError(dialect.formatError(error));
			}
		};

		const promise = Promise.race([executeAsync(), cancelPromise]);

		return { promise, cancel };
	}

	// ── Cleanup ──────────────────────────────────────────────────────

	/** Close all pools. Call on extension deactivation. */
	async closeAllPools(): Promise<void> {
		const closing: Promise<void>[] = [];
		for (const [, entry] of this.pools) {
			const dialect = getDialect(entry.dialectId);
			if (dialect) {
				closing.push(dialect.closePool(entry.pool).catch(() => { /* ignore */ }));
			}
		}
		for (const [, entry] of this.cancelablePools) {
			const dialect = getDialect(entry.dialectId);
			if (dialect) {
				closing.push(dialect.closePool(entry.pool).catch(() => { /* ignore */ }));
			}
		}
		this.pools.clear();
		this.cancelablePools.clear();
		await Promise.allSettled(closing);
	}

	// ── Private helpers ──────────────────────────────────────────────

	private getTimeoutMs(): number | undefined {
		const minutes = vscode.workspace.getConfiguration('kustoWorkbench').get<number>('sqlQueryTimeout', 20);
		return minutes > 0 ? minutes * 60 * 1000 : undefined;
	}
}
