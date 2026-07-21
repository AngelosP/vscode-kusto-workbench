import * as vscode from 'vscode';
import * as crypto from 'crypto';

import type { SqlConnection } from './sqlConnectionManager';
import { SqlQueryCancelledError, type SqlQueryClient } from './sqlClient';
import type { SqlDatabaseSchemaIndex } from './sql/sqlDialect';
import type { WorkbenchLogger } from './workbenchLogger';
import { normalizeSqlServerUrl, readSqlServerAccountMap } from './sql/sqlAuthState';
import { readCurrentSqlServerAccountMap } from './sql/sqlServerAccountMapStore';
import { sqlConnectionTargetSignature } from '../shared/sqlConnectionIdentity';
import { captureSqlSchemaCacheGeneration, publishSqlSchemaCacheFile } from './sqlSchemaCacheGeneration';

// ---------------------------------------------------------------------------
// Standalone SQL schema cache helpers (used by SqlSchemaService and CachedValuesViewer)
// ---------------------------------------------------------------------------

// Increment when the SQL schema cache shape changes.
// Used to detect stale entries cached before views/storedProcedures were added.
export const SQL_SCHEMA_CACHE_VERSION = 5;

export interface CachedSqlSchemaEntry {
	schema: SqlDatabaseSchemaIndex;
	timestamp: number;
	version?: number;
	serverUrl: string;
	database: string;
	connectionId: string;
	principalFingerprint: string;
	targetSignature: string;
	cacheGeneration: string;
}

export type SqlSchemaCacheOwner = {
	principalFingerprint: string;
	targetSignature: string;
};

export function getSqlSchemaCacheDirUri(globalStorageUri: vscode.Uri): vscode.Uri {
	return vscode.Uri.joinPath(globalStorageUri, 'sqlSchemaCache');
}

export function getSqlSchemaCacheFileUri(globalStorageUri: vscode.Uri, cacheKey: string): vscode.Uri {
	const hash = crypto.createHash('sha1').update(cacheKey, 'utf8').digest('hex');
	return vscode.Uri.joinPath(getSqlSchemaCacheDirUri(globalStorageUri), `${hash}.json`);
}

export function sqlSchemaPrincipalFingerprint(
	context: Pick<vscode.ExtensionContext, 'globalState'>,
	connection: SqlConnection,
): string | undefined {
	const authType = String(connection.authType || '').trim().toLowerCase();
	const principal = authType === 'aad'
		? readSqlServerAccountMap(context as vscode.ExtensionContext)[normalizeSqlServerUrl(connection.serverUrl)]
		: String(connection.username || '').trim();
	return sqlSchemaPrincipalFingerprintForPrincipal(connection, principal);
}

export async function readCurrentSqlSchemaPrincipalFingerprint(
	context: Pick<vscode.ExtensionContext, 'globalState'> & { globalStorageUri?: vscode.Uri },
	connection: SqlConnection,
): Promise<string | undefined> {
	const authType = String(connection.authType || '').trim().toLowerCase();
	const principal = authType === 'aad'
		? (await readCurrentSqlServerAccountMap(context as vscode.ExtensionContext, connection.serverUrl))[normalizeSqlServerUrl(connection.serverUrl)]
		: String(connection.username || '').trim();
	return sqlSchemaPrincipalFingerprintForPrincipal(connection, principal);
}

export function sqlSchemaPrincipalFingerprintForPrincipal(
	connection: SqlConnection,
	principal: string | undefined,
): string | undefined {
	const authType = String(connection.authType || '').trim().toLowerCase();
	const normalizedPrincipal = String(principal || '').trim();
	if (!authType || !normalizedPrincipal) return undefined;
	return crypto.createHash('sha256')
		.update(`${authType}\n${normalizeSqlServerUrl(connection.serverUrl)}\n${normalizedPrincipal}`, 'utf8')
		.digest('hex');
}

export function sqlSchemaTargetSignature(connection: SqlConnection): string {
	return sqlConnectionTargetSignature(connection);
}

/** Build the cache key for a SQL schema entry. SQL caches are credential-principal scoped. */
export function sqlSchemaCacheKey(database: string, connectionId: string, owner: SqlSchemaCacheOwner): string {
	return `${connectionId}|${owner.principalFingerprint}|${owner.targetSignature}|${database}`;
}

export async function readCachedSqlSchemaFromDisk(
	globalStorageUri: vscode.Uri,
	cacheKey: string,
	expectedOwner?: { connectionId: string } & SqlSchemaCacheOwner,
	expectedGeneration?: string,
): Promise<CachedSqlSchemaEntry | undefined> {
	try {
		const cacheGeneration = expectedGeneration ?? await captureSqlSchemaCacheGeneration(globalStorageUri);
		const uri = getSqlSchemaCacheFileUri(globalStorageUri, cacheKey);
		const buf = await vscode.workspace.fs.readFile(uri);
		const parsed = JSON.parse(Buffer.from(buf).toString('utf8'));
		if (
			!parsed?.schema
			|| parsed.version !== SQL_SCHEMA_CACHE_VERSION
			|| typeof parsed.timestamp !== 'number'
			|| typeof parsed.serverUrl !== 'string'
			|| typeof parsed.database !== 'string'
			|| typeof parsed.connectionId !== 'string'
			|| !parsed.connectionId.trim()
			|| typeof parsed.principalFingerprint !== 'string'
			|| !parsed.principalFingerprint.trim()
			|| typeof parsed.targetSignature !== 'string'
			|| !parsed.targetSignature
			|| typeof parsed.cacheGeneration !== 'string'
			|| !parsed.cacheGeneration
			|| parsed.cacheGeneration !== cacheGeneration
		) {
			return undefined;
		}
		if (expectedOwner && (
			parsed.connectionId !== expectedOwner.connectionId
			|| parsed.principalFingerprint !== expectedOwner.principalFingerprint
			|| parsed.targetSignature !== expectedOwner.targetSignature
		)) return undefined;
		return {
			schema: parsed.schema,
			timestamp: parsed.timestamp,
			version: typeof parsed.version === 'number' ? parsed.version : undefined,
			serverUrl: parsed.serverUrl,
			database: parsed.database,
			connectionId: parsed.connectionId,
			principalFingerprint: parsed.principalFingerprint,
			targetSignature: parsed.targetSignature,
			cacheGeneration: parsed.cacheGeneration,
		};
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
	readonly output: WorkbenchLogger;
	assertSqlConnectionAllowed?(connectionId: string): Promise<void>;
	getCurrentSqlConnection?(connectionId: string): SqlConnection | undefined;
	postMessage(message: unknown): void;
}

export class SqlSchemaService {
	private readonly CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 1 day
	/** In-memory cache: `serverUrl|database` → schema. */
	private readonly memoryCache = new Map<string, { entry: CachedSqlSchemaEntry; generation: string }>();

	constructor(private readonly host: SqlSchemaServiceHost) {}

	// ── Public API ──────────────────────────────────────────────────────

	async getDatabases(connection: SqlConnection): Promise<string[]> {
		await this.host.assertSqlConnectionAllowed?.(connection.id);
		return this.host.sqlClient.getDatabases(this.resolveCurrentConnection(connection));
	}

	async getSchema(
		connection: SqlConnection,
		database: string,
		forceRefresh = false,
		options?: { signal?: AbortSignal; expectedOwner?: SqlSchemaCacheOwner },
	): Promise<{ schema: SqlDatabaseSchemaIndex; fromCache: boolean }> {
		const capturedConnection = { ...connection };
		const targetSignature = sqlSchemaTargetSignature(capturedConnection);
		if (options?.expectedOwner && options.expectedOwner.targetSignature !== targetSignature) {
			throw new Error('SQL schema target changed before refresh.');
		}
		const principalPromise = options?.expectedOwner
			? Promise.resolve(options.expectedOwner.principalFingerprint)
			: readCurrentSqlSchemaPrincipalFingerprint(this.host.context, capturedConnection);
		this.throwIfAborted(options?.signal);
		await this.host.assertSqlConnectionAllowed?.(capturedConnection.id);
		this.throwIfAborted(options?.signal);
		const principalFingerprint = await principalPromise;
		const owner = principalFingerprint ? { principalFingerprint, targetSignature } : undefined;
		if (!owner) throw new Error('SQL schema identity is unavailable.');
		await this.assertCurrentOwner(capturedConnection, owner);
		this.throwIfAborted(options?.signal);
		const cacheKey = this.cacheKey(capturedConnection, database, owner);
		let cacheGeneration = await captureSqlSchemaCacheGeneration(this.host.context.globalStorageUri);

		// Memory cache.
		if (!forceRefresh) {
			const mem = this.memoryCache.get(cacheKey);
			if (mem && mem.generation === cacheGeneration && (Date.now() - mem.entry.timestamp) < this.CACHE_TTL_MS) {
				await this.assertCurrentOwner(capturedConnection, owner);
				this.throwIfAborted(options?.signal);
				const currentGeneration = await captureSqlSchemaCacheGeneration(this.host.context.globalStorageUri);
				if (currentGeneration === mem.generation) return { schema: mem.entry.schema, fromCache: true };
				cacheGeneration = currentGeneration;
			}
			if (mem && mem.generation !== cacheGeneration) this.memoryCache.delete(cacheKey);
		}

		// Disk cache.
		if (!forceRefresh) {
			this.throwIfAborted(options?.signal);
			const disk = await this.readDiskCache(cacheKey, capturedConnection.id, owner);
			if (disk && (Date.now() - disk.timestamp) < this.CACHE_TTL_MS) {
				await this.assertCurrentOwner(capturedConnection, owner);
				this.throwIfAborted(options?.signal);
				const currentGeneration = await captureSqlSchemaCacheGeneration(this.host.context.globalStorageUri);
				if (currentGeneration === cacheGeneration) {
					this.memoryCache.set(cacheKey, { entry: disk, generation: cacheGeneration });
					return { schema: disk.schema, fromCache: true };
				}
				cacheGeneration = currentGeneration;
			}
		}

		// Fetch from server.
		await this.assertCurrentOwner(capturedConnection, owner);
		this.throwIfAborted(options?.signal);
		const schema = await this.host.sqlClient.getDatabaseSchema(capturedConnection, database, { signal: options?.signal });
		this.throwIfAborted(options?.signal);
		await this.assertCurrentOwner(capturedConnection, owner);
		const entry: CachedSqlSchemaEntry = {
			schema,
			timestamp: Date.now(),
			serverUrl: capturedConnection.serverUrl,
			database,
			connectionId: capturedConnection.id,
			principalFingerprint: owner.principalFingerprint,
			targetSignature,
			cacheGeneration,
		};
		await this.writeDiskCache(cacheKey, entry, capturedConnection, cacheGeneration);
		this.throwIfAborted(options?.signal);
		await this.assertCurrentOwner(capturedConnection, owner);
		if (await captureSqlSchemaCacheGeneration(this.host.context.globalStorageUri) !== cacheGeneration) {
			throw new Error('SQL schema cache was cleared while the refresh was running.');
		}
		this.memoryCache.set(cacheKey, { entry, generation: cacheGeneration });
		return { schema, fromCache: false };
	}

	private throwIfAborted(signal?: AbortSignal): void {
		if (signal?.aborted) throw new SqlQueryCancelledError('SQL schema request cancelled.');
	}

	// ── Disk cache helpers ──────────────────────────────────────────────

	private getCacheDirUri(): vscode.Uri {
		return getSqlSchemaCacheDirUri(this.host.context.globalStorageUri);
	}

	private getCacheFileUri(cacheKey: string): vscode.Uri {
		return getSqlSchemaCacheFileUri(this.host.context.globalStorageUri, cacheKey);
	}

	private async readDiskCache(cacheKey: string, connectionId: string, owner: SqlSchemaCacheOwner): Promise<CachedSqlSchemaEntry | undefined> {
		return readCachedSqlSchemaFromDisk(this.host.context.globalStorageUri, cacheKey, { connectionId, ...owner });
	}

	private async writeDiskCache(cacheKey: string, entry: CachedSqlSchemaEntry, connection: SqlConnection, cacheGeneration: string): Promise<void> {
		const dir = this.getCacheDirUri();
		const uri = this.getCacheFileUri(cacheKey);
		const tempUri = vscode.Uri.joinPath(dir, `${crypto.randomUUID()}.tmp`);
		try {
			await vscode.workspace.fs.createDirectory(dir);
			const enriched = {
				...entry,
				version: SQL_SCHEMA_CACHE_VERSION,
			};
			const json = JSON.stringify(enriched);
			await vscode.workspace.fs.writeFile(tempUri, Buffer.from(json, 'utf8'));
		} catch {
			try { await vscode.workspace.fs.delete(tempUri, { useTrash: false }); } catch { /* ignore */ }
			return;
		}
		let published = false;
		try {
			published = await publishSqlSchemaCacheFile(
				this.host.context.globalStorageUri,
				cacheGeneration,
				tempUri,
				uri,
				() => this.assertCurrentOwner(connection, entry),
			);
			if (!published) {
				try { await vscode.workspace.fs.delete(tempUri, { useTrash: false }); } catch { /* ignore */ }
				throw new Error('SQL schema cache was cleared while the refresh was running.');
			}
		} catch (error) {
			try { await vscode.workspace.fs.delete(published ? uri : tempUri, { useTrash: false }); } catch { /* ignore */ }
			throw error;
		}
	}

	private cacheKey(connection: SqlConnection, database: string, owner: SqlSchemaCacheOwner): string {
		return sqlSchemaCacheKey(database, connection.id, owner);
	}

	private async assertCurrentOwner(connection: SqlConnection, owner: SqlSchemaCacheOwner): Promise<void> {
		await this.host.assertSqlConnectionAllowed?.(connection.id);
		const currentConnection = this.resolveCurrentConnection(connection);
		if (await readCurrentSqlSchemaPrincipalFingerprint(this.host.context, currentConnection) !== owner.principalFingerprint
			|| sqlSchemaTargetSignature(currentConnection) !== owner.targetSignature) {
			throw new Error('SQL schema identity changed during refresh.');
		}
	}

	private resolveCurrentConnection(connection: SqlConnection): SqlConnection {
		if (!this.host.getCurrentSqlConnection) return connection;
		const current = this.host.getCurrentSqlConnection(connection.id);
		if (!current) throw new Error('SQL connection changed during schema access.');
		return current;
	}
}

// ---------------------------------------------------------------------------
// SQL schema cache enumeration & search (mirrors Kusto's schemaCache.ts)
// ---------------------------------------------------------------------------

export type SqlSchemaSearchMatch = {
	connectionId: string;
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
	allowedOwners?: ReadonlyMap<string, SqlSchemaCacheOwner>,
): Promise<Array<{ connectionId: string; serverUrl: string; database: string; schema: SqlDatabaseSchemaIndex; owner: SqlSchemaCacheOwner }>> {
	const results: Array<{ connectionId: string; serverUrl: string; database: string; schema: SqlDatabaseSchemaIndex; owner: SqlSchemaCacheOwner }> = [];
	const cacheGeneration = await captureSqlSchemaCacheGeneration(globalStorageUri);
	try {
		const cacheDir = getSqlSchemaCacheDirUri(globalStorageUri);
		const files = await vscode.workspace.fs.readDirectory(cacheDir);
		for (const [fileName] of files) {
			if (!fileName.endsWith('.json')) continue;
			try {
				const fileUri = vscode.Uri.joinPath(cacheDir, fileName);
				const buf = await vscode.workspace.fs.readFile(fileUri);
				const parsed = JSON.parse(Buffer.from(buf).toString('utf8')) as Partial<CachedSqlSchemaEntry>;
				if (!parsed?.schema || parsed.version !== SQL_SCHEMA_CACHE_VERSION || parsed.cacheGeneration !== cacheGeneration) continue;
				const serverUrl = typeof parsed.serverUrl === 'string' ? parsed.serverUrl : '';
				const database = typeof parsed.database === 'string' ? parsed.database : '';
				const connectionId = typeof parsed.connectionId === 'string' ? parsed.connectionId : '';
				const principalFingerprint = typeof parsed.principalFingerprint === 'string' ? parsed.principalFingerprint : '';
				const targetSignature = typeof parsed.targetSignature === 'string' ? parsed.targetSignature : '';
				if (!connectionId || !principalFingerprint || !targetSignature || !serverUrl || !database) continue;
				const owner = { principalFingerprint, targetSignature };
				const allowedOwner = allowedOwners?.get(connectionId);
				if (allowedOwner && (allowedOwner.principalFingerprint !== principalFingerprint || allowedOwner.targetSignature !== targetSignature)) continue;
				if (allowedOwners && !allowedOwner) continue;
				results.push({ connectionId, serverUrl, database, schema: parsed.schema, owner });
			} catch { /* skip invalid files */ }
		}
	} catch { /* cache directory doesn't exist */ }
	return await captureSqlSchemaCacheGeneration(globalStorageUri) === cacheGeneration ? results : [];
}

/**
 * Searches all cached SQL schemas for tables, views, columns, stored procedures
 * matching a user-supplied regex pattern.
 */
export async function searchCachedSqlSchemas(
	globalStorageUri: vscode.Uri,
	pattern: string,
	maxResults: number = 500,
	allowedOwners?: ReadonlyMap<string, SqlSchemaCacheOwner>,
): Promise<SqlSchemaSearchMatch[]> {
	let re: RegExp;
	try { re = new RegExp(pattern, 'i'); } catch { return []; }

	const matches: SqlSchemaSearchMatch[] = [];
	const entries = await readAllCachedSqlSchemasFromDisk(globalStorageUri, allowedOwners);

	for (const { connectionId, serverUrl, database, schema } of entries) {
		if (matches.length >= maxResults) break;
		const base = { connectionId, serverUrl, database };
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
