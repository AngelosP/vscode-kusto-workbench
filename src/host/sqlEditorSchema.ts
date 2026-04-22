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
	serverUrl?: string;
	database?: string;
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
			// Enrich with serverUrl/database so enumeration/search can identify origins
			// without reversing the SHA1 filename hash.
			const pipeIdx = cacheKey.indexOf('|');
			const enriched = {
				...entry,
				version: SQL_SCHEMA_CACHE_VERSION,
				serverUrl: entry.serverUrl ?? (pipeIdx >= 0 ? cacheKey.slice(0, pipeIdx) : undefined),
				database: entry.database ?? (pipeIdx >= 0 ? cacheKey.slice(pipeIdx + 1) : undefined),
			};
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

// ---------------------------------------------------------------------------
// SQL schema cache enumeration & search (mirrors Kusto's schemaCache.ts)
// ---------------------------------------------------------------------------

export type SqlSchemaSearchMatch = {
	serverUrl: string;
	database: string;
	/** 'table' | 'view' | 'column' | 'storedProcedure' | 'spBody' | 'spParameter' */
	kind: string;
	name: string;
	table?: string;
	type?: string;
	parametersText?: string;
};

/**
 * Enumerates all cached SQL schemas from disk.
 * Only entries with embedded serverUrl/database metadata are returned.
 */
export async function readAllCachedSqlSchemasFromDisk(
	globalStorageUri: vscode.Uri,
): Promise<Array<{ serverUrl: string; database: string; schema: SqlDatabaseSchemaIndex }>> {
	const results: Array<{ serverUrl: string; database: string; schema: SqlDatabaseSchemaIndex }> = [];
	try {
		const cacheDir = getSqlSchemaCacheDirUri(globalStorageUri);
		const files = await vscode.workspace.fs.readDirectory(cacheDir);
		for (const [fileName] of files) {
			if (!fileName.endsWith('.json')) continue;
			try {
				const fileUri = vscode.Uri.joinPath(cacheDir, fileName);
				const buf = await vscode.workspace.fs.readFile(fileUri);
				const parsed = JSON.parse(Buffer.from(buf).toString('utf8')) as Partial<CachedSqlSchemaEntry>;
				if (!parsed?.schema) continue;
				const serverUrl = typeof parsed.serverUrl === 'string' ? parsed.serverUrl : '';
				const database = typeof parsed.database === 'string' ? parsed.database : '';
				if (!serverUrl || !database) continue;
				results.push({ serverUrl, database, schema: parsed.schema });
			} catch { /* skip invalid files */ }
		}
	} catch { /* cache directory doesn't exist */ }
	return results;
}

/**
 * Searches all cached SQL schemas for tables, views, columns, stored procedures
 * matching a user-supplied regex pattern.
 */
export async function searchCachedSqlSchemas(
	globalStorageUri: vscode.Uri,
	pattern: string,
	maxResults: number = 500,
): Promise<SqlSchemaSearchMatch[]> {
	let re: RegExp;
	try { re = new RegExp(pattern, 'i'); } catch { return []; }

	const matches: SqlSchemaSearchMatch[] = [];
	const entries = await readAllCachedSqlSchemasFromDisk(globalStorageUri);

	for (const { serverUrl, database, schema } of entries) {
		if (matches.length >= maxResults) break;
		const base = { serverUrl, database };
		const matchedTables = new Set<string>();

		// Tables
		for (const table of schema.tables ?? []) {
			if (matches.length >= maxResults) break;
			if (re.test(table)) {
				matchedTables.add(table);
				matches.push({ ...base, kind: 'table', name: table });
			}
		}

		// Views
		for (const view of schema.views ?? []) {
			if (matches.length >= maxResults) break;
			if (re.test(view)) {
				matches.push({ ...base, kind: 'view', name: view });
			}
		}

		// Columns
		for (const [table, cols] of Object.entries(schema.columnsByTable ?? {})) {
			if (matches.length >= maxResults) break;
			for (const [col, colType] of Object.entries(cols)) {
				if (matches.length >= maxResults) break;
				if (re.test(col) || re.test(colType)) {
					matches.push({ ...base, kind: 'column', name: col, table, type: colType });
				}
			}
		}

		// Stored Procedures
		for (const sp of schema.storedProcedures ?? []) {
			if (matches.length >= maxResults) break;
			let matchKind: string | undefined;
			if (re.test(sp.name)) {
				matchKind = 'storedProcedure';
			} else if (sp.parametersText && re.test(sp.parametersText)) {
				matchKind = 'spParameter';
			} else if (sp.body && re.test(sp.body)) {
				matchKind = 'spBody';
			}
			if (matchKind) {
				matches.push({
					...base,
					kind: matchKind,
					name: sp.name,
					...(sp.parametersText ? { parametersText: sp.parametersText } : {}),
				});
			}
		}
	}

	return matches;
}
