import * as vscode from 'vscode';
import * as crypto from 'crypto';

import { DatabaseSchemaIndex } from './kustoClient';

// Increment when the persisted schema JSON shape or semantics change.
// Used to automatically refresh stale cache entries created by older extension versions.
// Version 4: Extract function docString and folder from JSON schema (2025-01-24)
export const SCHEMA_CACHE_VERSION = 4;

export type CachedSchemaEntry = { schema: DatabaseSchemaIndex; timestamp: number; version: number; clusterUrl?: string; database?: string };

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
	await vscode.workspace.fs.writeFile(fileUri, Buffer.from(JSON.stringify(entry), 'utf8'));
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
