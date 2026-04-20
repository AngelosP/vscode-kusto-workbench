import * as vscode from 'vscode';
import * as crypto from 'crypto';

import type { SqlConnection } from './sqlConnectionManager';
import type { SqlQueryClient } from './sqlClient';
import type { SqlDatabaseSchemaIndex } from './sql/sqlDialect';

// ---------------------------------------------------------------------------
// Standalone SQL schema cache helpers (used by SqlSchemaService and CachedValuesViewer)
// ---------------------------------------------------------------------------

// Increment when the SQL schema cache shape changes.
// Used to detect stale entries cached before views/storedProcedures were added.
export const SQL_SCHEMA_CACHE_VERSION = 1;

export interface CachedSqlSchemaEntry {
	schema: SqlDatabaseSchemaIndex;
	timestamp: number;
	version?: number;
}

export function getSqlSchemaCacheDirUri(globalStorageUri: vscode.Uri): vscode.Uri {
	return vscode.Uri.joinPath(globalStorageUri, 'sqlSchemaCache');
}

export function getSqlSchemaCacheFileUri(globalStorageUri: vscode.Uri, cacheKey: string): vscode.Uri {
	const hash = crypto.createHash('sha1').update(cacheKey, 'utf8').digest('hex');
	return vscode.Uri.joinPath(getSqlSchemaCacheDirUri(globalStorageUri), `${hash}.json`);
}

/** Build the cache key for a SQL schema entry. Both parts are lowercased. */
export function sqlSchemaCacheKey(serverUrl: string, database: string): string {
	return `${serverUrl.toLowerCase()}|${database.toLowerCase()}`;
}

export async function readCachedSqlSchemaFromDisk(
	globalStorageUri: vscode.Uri,
	cacheKey: string,
): Promise<CachedSqlSchemaEntry | undefined> {
	try {
		const uri = getSqlSchemaCacheFileUri(globalStorageUri, cacheKey);
		const buf = await vscode.workspace.fs.readFile(uri);
		const parsed = JSON.parse(Buffer.from(buf).toString('utf8'));
		if (!parsed?.schema || typeof parsed.timestamp !== 'number') {
			return undefined;
		}
		return { schema: parsed.schema, timestamp: parsed.timestamp };
	} catch {
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// SqlSchemaService — schema fetching & disk caching for SQL connections
// ---------------------------------------------------------------------------

interface SqlSchemaServiceHost {
	readonly context: vscode.ExtensionContext;
	readonly sqlClient: SqlQueryClient;
	readonly output: vscode.OutputChannel;
	postMessage(message: unknown): void;
}

export class SqlSchemaService {
	private readonly CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 1 day
	/** In-memory cache: `serverUrl|database` → schema. */
	private readonly memoryCache = new Map<string, CachedSqlSchemaEntry>();

	constructor(private readonly host: SqlSchemaServiceHost) {}

	// ── Public API ──────────────────────────────────────────────────────

	async getDatabases(connection: SqlConnection): Promise<string[]> {
		return this.host.sqlClient.getDatabases(connection);
	}

	async getSchema(
		connection: SqlConnection,
		database: string,
		forceRefresh = false,
	): Promise<{ schema: SqlDatabaseSchemaIndex; fromCache: boolean }> {
		const cacheKey = this.cacheKey(connection.serverUrl, database);

		// Memory cache.
		if (!forceRefresh) {
			const mem = this.memoryCache.get(cacheKey);
			if (mem && (Date.now() - mem.timestamp) < this.CACHE_TTL_MS) {
				return { schema: mem.schema, fromCache: true };
			}
		}

		// Disk cache.
		if (!forceRefresh) {
			const disk = await this.readDiskCache(cacheKey);
			if (disk && (Date.now() - disk.timestamp) < this.CACHE_TTL_MS) {
				this.memoryCache.set(cacheKey, disk);
				return { schema: disk.schema, fromCache: true };
			}
		}

		// Fetch from server.
		const schema = await this.host.sqlClient.getDatabaseSchema(connection, database);
		const entry: CachedSqlSchemaEntry = { schema, timestamp: Date.now() };
		this.memoryCache.set(cacheKey, entry);
		void this.writeDiskCache(cacheKey, entry);
		return { schema, fromCache: false };
	}

	// ── Disk cache helpers ──────────────────────────────────────────────

	private getCacheDirUri(): vscode.Uri {
		return getSqlSchemaCacheDirUri(this.host.context.globalStorageUri);
	}

	private getCacheFileUri(cacheKey: string): vscode.Uri {
		return getSqlSchemaCacheFileUri(this.host.context.globalStorageUri, cacheKey);
	}

	private async readDiskCache(cacheKey: string): Promise<CachedSqlSchemaEntry | undefined> {
		return readCachedSqlSchemaFromDisk(this.host.context.globalStorageUri, cacheKey);
	}

	private async writeDiskCache(cacheKey: string, entry: CachedSqlSchemaEntry): Promise<void> {
		try {
			const dir = this.getCacheDirUri();
			await vscode.workspace.fs.createDirectory(dir);
			const uri = this.getCacheFileUri(cacheKey);
			const enriched = { ...entry, version: SQL_SCHEMA_CACHE_VERSION };
			const json = JSON.stringify(enriched);
			await vscode.workspace.fs.writeFile(uri, Buffer.from(json, 'utf8'));
		} catch {
			// Best-effort — disk cache failure is not fatal.
		}
	}

	private cacheKey(serverUrl: string, database: string): string {
		return sqlSchemaCacheKey(serverUrl, database);
	}
}
