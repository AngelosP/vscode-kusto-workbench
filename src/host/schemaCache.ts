import * as vscode from 'vscode';
import * as crypto from 'crypto';

import { DatabaseSchemaIndex, KustoFunctionInfo } from './kustoClient';
import { exportKustoClusterEndpoint, kustoClusterKey, kustoDatabaseKey } from '../shared/kustoClusterUrls';

// Increment when the persisted schema JSON shape or semantics change.
// Used to automatically refresh stale cache entries created by older extension versions.
// Version 5: bind every schema to a connection and effective account partition.
export const SCHEMA_CACHE_VERSION = 5;
export const SCHEMA_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export type SchemaCacheGeneration = Readonly<{ global: number; connection: number; partition: number }>;
type SchemaCacheMutationState = {
	globalGeneration: number;
	connectionGenerations: Map<string, number>;
	partitionGenerations: Map<string, number>;
	tail: Promise<unknown>;
};
const schemaCacheMutations = new Map<string, SchemaCacheMutationState>();

function schemaCacheOwnerKey(globalStorageUri: vscode.Uri): string {
	return globalStorageUri.toString();
}

function getSchemaCacheMutationState(globalStorageUri: vscode.Uri): SchemaCacheMutationState {
	const key = schemaCacheOwnerKey(globalStorageUri);
	let state = schemaCacheMutations.get(key);
	if (!state) {
		state = { globalGeneration: 0, connectionGenerations: new Map(), partitionGenerations: new Map(), tail: Promise.resolve() };
		schemaCacheMutations.set(key, state);
	}
	return state;
}

function enqueueSchemaCacheMutation<T>(globalStorageUri: vscode.Uri, operation: () => Promise<T>): Promise<T> {
	const state = getSchemaCacheMutationState(globalStorageUri);
	const next = state.tail.then(operation, operation);
	state.tail = next.catch(() => undefined);
	return next;
}

export function captureSchemaCacheGeneration(globalStorageUri: vscode.Uri, connectionId: string = '', accountPartition: string = ''): SchemaCacheGeneration {
	const state = getSchemaCacheMutationState(globalStorageUri);
	return {
		global: state.globalGeneration,
		connection: state.connectionGenerations.get(String(connectionId || '').trim()) ?? 0,
		partition: state.partitionGenerations.get(String(accountPartition || '').trim()) ?? 0,
	};
}

function isSchemaCacheGenerationCurrent(globalStorageUri: vscode.Uri, connectionId: string, accountPartition: string, expected: SchemaCacheGeneration): boolean {
	const current = captureSchemaCacheGeneration(globalStorageUri, connectionId, accountPartition);
	return current.global === expected.global && current.connection === expected.connection && current.partition === expected.partition;
}

export type CachedSchemaEntry = {
	schema: DatabaseSchemaIndex;
	timestamp: number;
	version: number;
	clusterUrl?: string;
	database?: string;
	connectionId?: string;
	accountPartition?: string;
};
export type CachedSchemaClassification = {
	exists: boolean;
	cacheAgeMs?: number;
	isFresh: boolean;
	isLatestVersion: boolean;
	isUsable: boolean;
};

export const classifyCachedSchema = (
	entry: CachedSchemaEntry | undefined,
	now: number = Date.now()
): CachedSchemaClassification => {
	if (!entry || !entry.schema || typeof entry.timestamp !== 'number') {
		return { exists: false, isFresh: false, isLatestVersion: false, isUsable: false };
	}
	const cacheAgeMs = Math.max(0, now - entry.timestamp);
	const isLatestVersion = (entry.version ?? 0) === SCHEMA_CACHE_VERSION;
	const hasPrincipalIdentity = !!String(entry.connectionId || '').trim() && !!String(entry.accountPartition || '').trim();
	return {
		exists: true,
		cacheAgeMs,
		isFresh: cacheAgeMs < SCHEMA_CACHE_TTL_MS,
		isLatestVersion,
		isUsable: isLatestVersion && hasPrincipalIdentity,
	};
};

export const getSchemaCacheDirUri = (globalStorageUri: vscode.Uri): vscode.Uri => {
	return vscode.Uri.joinPath(globalStorageUri, 'schemaCache');
};

export const getSchemaCacheFileUri = (globalStorageUri: vscode.Uri, cacheKey: string): vscode.Uri => {
	const hash = crypto.createHash('sha1').update(cacheKey, 'utf8').digest('hex');
	return vscode.Uri.joinPath(getSchemaCacheDirUri(globalStorageUri), `${hash}.json`);
};

export const schemaCacheKey = (
	clusterUrl: unknown,
	database: unknown,
	connectionId: unknown,
	accountPartition: unknown,
): string => {
	const physicalKey = kustoDatabaseKey(clusterUrl, database);
	const id = String(connectionId || '').trim();
	const partition = String(accountPartition || '').trim();
	if (!physicalKey || !id || !partition) return '';
	return `v5|${encodeURIComponent(id)}|${partition}|${physicalKey}`;
};

export const schemaPrincipalIdentity = (connectionId: unknown, accountPartition: unknown): string => {
	const id = String(connectionId || '').trim();
	const partition = String(accountPartition || '').trim();
	return id && partition ? `${encodeURIComponent(id)}|${partition}` : '';
};

export const getLegacySchemaCacheKeys = (clusterUrl: unknown, database: unknown): string[] => {
	const db = String(database || '').trim();
	const rawCluster = String(clusterUrl || '').trim();
	if (!db || !rawCluster) return [];
	const keys = [
		kustoDatabaseKey(clusterUrl, db),
		`${rawCluster}|${db}`,
		`${rawCluster.replace(/\/+$/g, '')}|${db}`,
		`${exportKustoClusterEndpoint(clusterUrl)}|${db}`,
	].map(key => String(key || '').trim()).filter(Boolean);
	return [...new Set(keys)];
};

export const readCachedSchemaFromDisk = async (
	globalStorageUri: vscode.Uri,
	cacheKey: string
): Promise<CachedSchemaEntry | undefined> => {
	try {
		const fileUri = getSchemaCacheFileUri(globalStorageUri, cacheKey);
		const buf = await vscode.workspace.fs.readFile(fileUri);
		const parsed = JSON.parse(Buffer.from(buf).toString('utf8')) as Partial<CachedSchemaEntry>;
		if (!parsed || !parsed.schema || typeof parsed.timestamp !== 'number') {
			return undefined;
		}
		const version = typeof parsed.version === 'number' && isFinite(parsed.version) ? parsed.version : 0;
		return {
			schema: parsed.schema,
			timestamp: parsed.timestamp,
			version,
			clusterUrl: typeof parsed.clusterUrl === 'string' ? parsed.clusterUrl : undefined,
			database: typeof parsed.database === 'string' ? parsed.database : undefined,
			connectionId: typeof parsed.connectionId === 'string' ? parsed.connectionId : undefined,
			accountPartition: typeof parsed.accountPartition === 'string' ? parsed.accountPartition : undefined,
		};
	} catch {
		return undefined;
	}
};

export const readCachedSchemaFromDiskByCluster = async (
	globalStorageUri: vscode.Uri,
	clusterUrl: unknown,
	database: unknown,
	connectionId: unknown,
	accountPartition: unknown,
): Promise<CachedSchemaEntry | undefined> => {
	const id = String(connectionId || '').trim();
	const partition = String(accountPartition || '').trim();
	const key = schemaCacheKey(clusterUrl, database, id, partition);
	if (!key) return undefined;
	const cached = await readCachedSchemaFromDisk(globalStorageUri, key);
	if (!cached || !classifyCachedSchema(cached).isUsable) return undefined;
	if (cached.connectionId !== id || cached.accountPartition !== partition) return undefined;
	return cached;
};

export const writeCachedSchemaToDisk = async (
	globalStorageUri: vscode.Uri,
	cacheKey: string,
	entry: CachedSchemaEntry,
	expectedGeneration: SchemaCacheGeneration = captureSchemaCacheGeneration(globalStorageUri, entry.connectionId, entry.accountPartition),
): Promise<boolean> => {
	if (!cacheKey || !classifyCachedSchema(entry).isUsable || !entry.clusterUrl || !entry.database) {
		throw new Error('Kusto schema cache entries require version 5 connection and account identity metadata.');
	}
	return enqueueSchemaCacheMutation(globalStorageUri, async () => {
		if (!isSchemaCacheGenerationCurrent(globalStorageUri, entry.connectionId || '', entry.accountPartition || '', expectedGeneration)) return false;
		const dir = getSchemaCacheDirUri(globalStorageUri);
		await vscode.workspace.fs.createDirectory(dir);
		if (!isSchemaCacheGenerationCurrent(globalStorageUri, entry.connectionId || '', entry.accountPartition || '', expectedGeneration)) return false;
		const fileUri = getSchemaCacheFileUri(globalStorageUri, cacheKey);
		await vscode.workspace.fs.writeFile(fileUri, Buffer.from(JSON.stringify(entry), 'utf8'));
		return isSchemaCacheGenerationCurrent(globalStorageUri, entry.connectionId || '', entry.accountPartition || '', expectedGeneration);
	});
};

export const clearCachedSchemas = async (globalStorageUri: vscode.Uri): Promise<void> => {
	const state = getSchemaCacheMutationState(globalStorageUri);
	state.globalGeneration++;
	await enqueueSchemaCacheMutation(globalStorageUri, async () => {
		try {
			await vscode.workspace.fs.delete(getSchemaCacheDirUri(globalStorageUri), { recursive: true, useTrash: false });
		} catch {
			// The schema cache directory may not exist yet.
		}
	});
};

const deleteCachedSchemasMatching = async (
	globalStorageUri: vscode.Uri,
	matches: (entry: Partial<CachedSchemaEntry>) => boolean,
): Promise<number> => {
	return enqueueSchemaCacheMutation(globalStorageUri, async () => {
		let deleted = 0;
		try {
			const cacheDir = getSchemaCacheDirUri(globalStorageUri);
			const files = await vscode.workspace.fs.readDirectory(cacheDir);
			for (const [fileName] of files) {
				if (!fileName.endsWith('.json')) continue;
				const fileUri = vscode.Uri.joinPath(cacheDir, fileName);
				try {
					const bytes = await vscode.workspace.fs.readFile(fileUri);
					const parsed = JSON.parse(Buffer.from(bytes).toString('utf8')) as Partial<CachedSchemaEntry>;
					if (!matches(parsed)) continue;
					await vscode.workspace.fs.delete(fileUri, { recursive: false, useTrash: false });
					deleted++;
				} catch {
					// Ignore malformed or concurrently removed cache files.
				}
			}
		} catch {
			// The schema cache directory may not exist yet.
		}
		return deleted;
	});
};

export const deleteCachedSchemasForAccountPartitions = async (
	globalStorageUri: vscode.Uri,
	accountPartitions: ReadonlySet<string>,
): Promise<number> => {
	const partitions = new Set(
		[...accountPartitions].map(partition => String(partition || '').trim()).filter(Boolean),
	);
	if (partitions.size === 0) return 0;
	const state = getSchemaCacheMutationState(globalStorageUri);
	for (const partition of partitions) state.partitionGenerations.set(partition, (state.partitionGenerations.get(partition) ?? 0) + 1);
	return deleteCachedSchemasMatching(globalStorageUri, entry => partitions.has(String(entry.accountPartition || '').trim()));
};

export const deleteCachedSchemasForConnections = async (
	globalStorageUri: vscode.Uri,
	connectionIds: ReadonlySet<string>,
): Promise<number> => {
	const ids = new Set([...connectionIds].map(connectionId => String(connectionId || '').trim()).filter(Boolean));
	if (ids.size === 0) return 0;
	const state = getSchemaCacheMutationState(globalStorageUri);
	for (const id of ids) state.connectionGenerations.set(id, (state.connectionGenerations.get(id) ?? 0) + 1);
	return deleteCachedSchemasMatching(globalStorageUri, entry => ids.has(String(entry.connectionId || '').trim()));
};

/**
 * Enumerates all cached schemas from disk. Each file may contain optional clusterUrl
 * and database fields that identify the origin of the schema.
 */
export const readAllCachedSchemasFromDisk = async (
	globalStorageUri: vscode.Uri,
	filterClusterUrl?: string,
	filterDatabase?: string,
	allowedPrincipalIdentities?: ReadonlySet<string>,
): Promise<Array<{ connectionId: string; clusterUrl: string; database: string; tables: string[]; functions: string[] }>> => {
	const resultsByKey = new Map<string, { timestamp: number; value: { connectionId: string; clusterUrl: string; database: string; tables: string[]; functions: string[] } }>();
	const filterClusterKey = filterClusterUrl ? kustoClusterKey(filterClusterUrl) : '';
	try {
		const cacheDir = getSchemaCacheDirUri(globalStorageUri);
		const files = await vscode.workspace.fs.readDirectory(cacheDir);
		for (const [fileName] of files) {
			if (!fileName.endsWith('.json')) continue;
			try {
				const fileUri = vscode.Uri.joinPath(cacheDir, fileName);
				const buf = await vscode.workspace.fs.readFile(fileUri);
				const parsed = JSON.parse(Buffer.from(buf).toString('utf8')) as Partial<CachedSchemaEntry>;
				if (!parsed?.schema) continue;

				const entryCluster = typeof parsed.clusterUrl === 'string' ? parsed.clusterUrl : '';
				const entryDatabase = typeof parsed.database === 'string' ? parsed.database : '';
				const connectionId = typeof parsed.connectionId === 'string' ? parsed.connectionId : '';
				const accountPartition = typeof parsed.accountPartition === 'string' ? parsed.accountPartition : '';
				const principalIdentity = schemaPrincipalIdentity(connectionId, accountPartition);

				// Skip entries that don't have origin metadata — they are from an older
				// cache version and cannot be reliably identified.
				if (!entryCluster || !entryDatabase || !principalIdentity || !classifyCachedSchema(parsed as CachedSchemaEntry).isUsable) continue;
				if (allowedPrincipalIdentities && !allowedPrincipalIdentities.has(principalIdentity)) continue;

				// Apply optional filters
				if (filterClusterKey && kustoClusterKey(entryCluster) !== filterClusterKey) continue;
				if (filterDatabase && entryDatabase.toLowerCase() !== filterDatabase.toLowerCase()) continue;

				const schema = parsed.schema;
				const tables = schema.tables || [];
				const functions = (schema.functions || []).map(f => typeof f === 'string' ? f : (f as { name?: string }).name || '').filter(Boolean);
				const identityKey = schemaCacheKey(entryCluster, entryDatabase, connectionId, accountPartition);
				if (!identityKey) continue;
				const timestamp = typeof parsed.timestamp === 'number' && isFinite(parsed.timestamp) ? parsed.timestamp : 0;
				const existing = resultsByKey.get(identityKey);
				if (!existing || timestamp >= existing.timestamp) {
					resultsByKey.set(identityKey, { timestamp, value: { connectionId, clusterUrl: entryCluster, database: entryDatabase, tables, functions } });
				}
			} catch {
				// Skip invalid cache files
			}
		}
	} catch {
		// Cache directory doesn't exist or can't be read
	}
	return Array.from(resultsByKey.values()).map(entry => entry.value);
};

export type SchemaSearchMatch = {
	connectionId: string;
	clusterUrl: string;
	database: string;
	/** 'table' | 'column' | 'function' | 'tableDocString' | 'columnDocString' | 'functionDocString' */
	kind: string;
	/** The table, column, or function name that matched */
	name: string;
	/** For columns: the owning table name */
	table?: string;
	/** For columns: the column type */
	type?: string;
	/** The matched docstring text (if kind is a docstring match) */
	docString?: string;
	/** For functions: parameter signature text */
	parametersText?: string;
};

/**
 * Searches all cached schemas for tables, columns, functions, docstrings,
 * folder paths, column types, function bodies, parameters, and any other
 * metadata matching a user-supplied regex pattern.
 * Returns up to `maxResults` matches across all cached databases.
 */
export const searchCachedSchemas = async (
	globalStorageUri: vscode.Uri,
	pattern: string,
	maxResults: number = 200,
	allowedPrincipalIdentities?: ReadonlySet<string>,
): Promise<SchemaSearchMatch[]> => {
	let re: RegExp;
	try {
		re = new RegExp(pattern, 'i');
	} catch {
		return [];
	}

	const matches: SchemaSearchMatch[] = [];

	try {
		const cacheDir = getSchemaCacheDirUri(globalStorageUri);
		const files = await vscode.workspace.fs.readDirectory(cacheDir);
		for (const [fileName] of files) {
			if (matches.length >= maxResults) break;
			if (!fileName.endsWith('.json')) continue;
			try {
				const fileUri = vscode.Uri.joinPath(cacheDir, fileName);
				const buf = await vscode.workspace.fs.readFile(fileUri);
				const parsed = JSON.parse(Buffer.from(buf).toString('utf8')) as Partial<CachedSchemaEntry>;
				if (!parsed?.schema) continue;

				const cluster = typeof parsed.clusterUrl === 'string' ? parsed.clusterUrl : '';
				const database = typeof parsed.database === 'string' ? parsed.database : '';
				const connectionId = typeof parsed.connectionId === 'string' ? parsed.connectionId : '';
				const accountPartition = typeof parsed.accountPartition === 'string' ? parsed.accountPartition : '';
				const principalIdentity = schemaPrincipalIdentity(connectionId, accountPartition);
				if (!cluster || !database || !principalIdentity || !classifyCachedSchema(parsed as CachedSchemaEntry).isUsable) continue;
				if (allowedPrincipalIdentities && !allowedPrincipalIdentities.has(principalIdentity)) continue;

				const schema = parsed.schema;
				const base = { connectionId, clusterUrl: cluster, database };

				// Track what has already matched to avoid duplicates
				const matchedTables = new Set<string>();
				const matchedColumns = new Set<string>();	// "table.column"
				const matchedFunctions = new Set<string>();

				// Search tables (name match)
				for (const table of schema.tables || []) {
					if (matches.length >= maxResults) break;
					if (re.test(table)) {
						matchedTables.add(table);
						const docString = schema.tableDocStrings?.[table];
						matches.push({ ...base, kind: 'table', name: table, ...(docString ? { docString } : {}) });
					}
				}

				// Search table docstrings (when the table name itself didn't match)
				if (schema.tableDocStrings) {
					for (const [table, doc] of Object.entries(schema.tableDocStrings)) {
						if (matches.length >= maxResults) break;
						if (matchedTables.has(table)) continue;
						if (doc && re.test(doc)) {
							matchedTables.add(table);
							matches.push({ ...base, kind: 'tableDocString', name: table, docString: doc });
						}
					}
				}

				// Search table folders (when the table didn't already match)
				if (schema.tableFolders) {
					for (const [table, folder] of Object.entries(schema.tableFolders)) {
						if (matches.length >= maxResults) break;
						if (matchedTables.has(table)) continue;
						if (folder && re.test(folder)) {
							matchedTables.add(table);
							const docString = schema.tableDocStrings?.[table];
							matches.push({ ...base, kind: 'tableFolder', name: table, ...(docString ? { docString } : {}) });
						}
					}
				}

				// Search columns (name match)
				for (const [table, cols] of Object.entries(schema.columnTypesByTable || {})) {
					if (matches.length >= maxResults) break;
					for (const [col, colType] of Object.entries(cols)) {
						if (matches.length >= maxResults) break;
						if (re.test(col)) {
							matchedColumns.add(`${table}.${col}`);
							const docString = schema.columnDocStrings?.[`${table}.${col}`];
							matches.push({ ...base, kind: 'column', name: col, table, type: colType, ...(docString ? { docString } : {}) });
						}
					}
				}

				// Search column types (when the column name itself didn't match)
				for (const [table, cols] of Object.entries(schema.columnTypesByTable || {})) {
					if (matches.length >= maxResults) break;
					for (const [col, colType] of Object.entries(cols)) {
						if (matches.length >= maxResults) break;
						const key = `${table}.${col}`;
						if (matchedColumns.has(key)) continue;
						if (colType && re.test(colType)) {
							matchedColumns.add(key);
							const docString = schema.columnDocStrings?.[key];
							matches.push({ ...base, kind: 'columnType', name: col, table, type: colType, ...(docString ? { docString } : {}) });
						}
					}
				}

				// Search column docstrings (when the column name/type didn't match)
				if (schema.columnDocStrings) {
					for (const [key, doc] of Object.entries(schema.columnDocStrings)) {
						if (matches.length >= maxResults) break;
						if (matchedColumns.has(key)) continue;
						if (!doc || !re.test(doc)) continue;
						const dotIdx = key.indexOf('.');
						const table = dotIdx >= 0 ? key.slice(0, dotIdx) : '';
						const col = dotIdx >= 0 ? key.slice(dotIdx + 1) : key;
						matchedColumns.add(key);
						const colType = table && schema.columnTypesByTable?.[table]?.[col];
						matches.push({ ...base, kind: 'columnDocString', name: col, table: table || undefined, ...(colType ? { type: colType } : {}), docString: doc });
					}
				}

				// Search functions — name, docString, folder, parametersText, body, parameter names
				const functions: KustoFunctionInfo[] = (schema.functions || []) as KustoFunctionInfo[];
				for (const fn of functions) {
					if (matches.length >= maxResults) break;
					const fnName = typeof fn === 'string' ? fn : fn?.name;
					if (!fnName) continue;
					if (matchedFunctions.has(fnName)) continue;
					const fnObj = typeof fn === 'object' ? fn : undefined;

					// Check all searchable fields of the function
					let matchKind: string | undefined;
					if (re.test(fnName)) {
						matchKind = 'function';
					} else if (fnObj?.docString && re.test(fnObj.docString)) {
						matchKind = 'functionDocString';
					} else if (fnObj?.folder && re.test(fnObj.folder)) {
						matchKind = 'functionFolder';
					} else if (fnObj?.parametersText && re.test(fnObj.parametersText)) {
						matchKind = 'functionParameter';
					} else if (fnObj?.body && re.test(fnObj.body)) {
						matchKind = 'functionBody';
					} else if (fnObj?.parameters) {
						for (const param of fnObj.parameters) {
							if (param.name && re.test(param.name)) {
								matchKind = 'functionParameter';
								break;
							}
							if (param.type && re.test(param.type)) {
								matchKind = 'functionParameter';
								break;
							}
						}
					}

					if (matchKind) {
						matchedFunctions.add(fnName);
						matches.push({
							...base,
							kind: matchKind,
							name: fnName,
							...(fnObj?.docString ? { docString: fnObj.docString } : {}),
							...(fnObj?.parametersText ? { parametersText: fnObj.parametersText } : {})
						});
					}
				}
			} catch {
				// Skip invalid cache files
			}
		}
	} catch {
		// Cache directory doesn't exist or can't be read
	}
	return matches;
};
