import * as vscode from 'vscode';
import * as crypto from 'crypto';

import { DatabaseSchemaIndex, KustoFunctionInfo } from './kustoClient';

// Increment when the persisted schema JSON shape or semantics change.
// Used to automatically refresh stale cache entries created by older extension versions.
// Version 4: Extract function docString and folder from JSON schema (2025-01-24)
export const SCHEMA_CACHE_VERSION = 4;
export const SCHEMA_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export type CachedSchemaEntry = { schema: DatabaseSchemaIndex; timestamp: number; version: number; clusterUrl?: string; database?: string };
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
	return {
		exists: true,
		cacheAgeMs,
		isFresh: cacheAgeMs < SCHEMA_CACHE_TTL_MS,
		isLatestVersion,
		isUsable: true,
	};
};

export const getSchemaCacheDirUri = (globalStorageUri: vscode.Uri): vscode.Uri => {
	return vscode.Uri.joinPath(globalStorageUri, 'schemaCache');
};

export const getSchemaCacheFileUri = (globalStorageUri: vscode.Uri, cacheKey: string): vscode.Uri => {
	const hash = crypto.createHash('sha1').update(cacheKey, 'utf8').digest('hex');
	return vscode.Uri.joinPath(getSchemaCacheDirUri(globalStorageUri), `${hash}.json`);
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
		return { schema: parsed.schema, timestamp: parsed.timestamp, version };
	} catch {
		return undefined;
	}
};

export const writeCachedSchemaToDisk = async (
	globalStorageUri: vscode.Uri,
	cacheKey: string,
	entry: CachedSchemaEntry
): Promise<void> => {
	const dir = getSchemaCacheDirUri(globalStorageUri);
	await vscode.workspace.fs.createDirectory(dir);
	const fileUri = getSchemaCacheFileUri(globalStorageUri, cacheKey);
	// Ensure clusterUrl and database are always persisted so enumeration/search
	// can identify schemas without needing to reverse the SHA1 filename hash.
	const pipeIdx = cacheKey.indexOf('|');
	const enriched: CachedSchemaEntry = {
		...entry,
		clusterUrl: entry.clusterUrl ?? (pipeIdx >= 0 ? cacheKey.slice(0, pipeIdx) : undefined),
		database: entry.database ?? (pipeIdx >= 0 ? cacheKey.slice(pipeIdx + 1) : undefined)
	};
	await vscode.workspace.fs.writeFile(fileUri, Buffer.from(JSON.stringify(enriched), 'utf8'));
};

/**
 * Enumerates all cached schemas from disk. Each file may contain optional clusterUrl
 * and database fields that identify the origin of the schema.
 */
export const readAllCachedSchemasFromDisk = async (
	globalStorageUri: vscode.Uri,
	filterClusterUrl?: string,
	filterDatabase?: string
): Promise<Array<{ clusterUrl: string; database: string; tables: string[]; functions: string[] }>> => {
	const results: Array<{ clusterUrl: string; database: string; tables: string[]; functions: string[] }> = [];
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

				// Skip entries that don't have origin metadata — they are from an older
				// cache version and cannot be reliably identified.
				if (!entryCluster || !entryDatabase) continue;

				// Apply optional filters
				if (filterClusterUrl && entryCluster.replace(/\/+$/, '').toLowerCase() !== filterClusterUrl.replace(/\/+$/, '').toLowerCase()) continue;
				if (filterDatabase && entryDatabase.toLowerCase() !== filterDatabase.toLowerCase()) continue;

				const schema = parsed.schema;
				const tables = schema.tables || [];
				const functions = (schema.functions || []).map(f => typeof f === 'string' ? f : (f as { name?: string }).name || '').filter(Boolean);
				results.push({ clusterUrl: entryCluster, database: entryDatabase, tables, functions });
			} catch {
				// Skip invalid cache files
			}
		}
	} catch {
		// Cache directory doesn't exist or can't be read
	}
	return results;
};

export type SchemaSearchMatch = {
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
	maxResults: number = 200
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
				if (!cluster || !database) continue;

				const schema = parsed.schema;
				const base = { clusterUrl: cluster, database };

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
