import * as vscode from 'vscode';
import * as crypto from 'crypto';

import { DatabaseSchemaIndex } from './kustoClient';

// Increment when the persisted schema JSON shape or semantics change.
// Used to automatically refresh stale cache entries created by older extension versions.
export const SCHEMA_CACHE_VERSION = 3;

export type CachedSchemaEntry = { schema: DatabaseSchemaIndex; timestamp: number; version: number };

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
