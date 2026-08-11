import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import {
	captureSqlSchemaCacheGeneration,
	clearSqlSchemaCacheFiles,
	publishSqlSchemaCacheFile,
} from '../../../src/host/sqlSchemaCacheGeneration';
import {
	getSqlSchemaCacheFileUri,
	readCachedSqlSchemaFromDisk,
	sqlSchemaCacheKey,
	SQL_SCHEMA_CACHE_VERSION,
} from '../../../src/host/sqlEditorSchema';

describe('SQL schema cache generation', () => {
	it('quarantines malformed generation state and advances to a safe generation', async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sql-schema-generation-corrupt-'));
		const storageUri = vscode.Uri.file(directory);
		fs.writeFileSync(path.join(directory, 'sql-schema-cache-generation.v1.json'), '{broken', 'utf8');
		try {
			const generation = await captureSqlSchemaCacheGeneration(storageUri);
			expect(generation).toMatch(/^[0-9a-f-]{36}$/);
			expect(fs.readdirSync(directory).some(name => name.startsWith('sql-schema-cache-generation.v1.json.corrupt-'))).toBe(true);
		} finally {
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});

	it('quarantines structurally invalid generation state and advances monotonically', async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sql-schema-generation-structural-'));
		const storageUri = vscode.Uri.file(directory);
		fs.writeFileSync(path.join(directory, 'sql-schema-cache-generation.v1.json'), '{}', 'utf8');
		try {
			const generation = await captureSqlSchemaCacheGeneration(storageUri);
			expect(generation).toMatch(/^[0-9a-f-]{36}$/);
			expect(JSON.parse(fs.readFileSync(path.join(directory, 'sql-schema-cache-generation.v1.json'), 'utf8')).generation).toBe(generation);
		} finally {
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});

	it('quarantines a numeric generation instead of coercing it to a string', async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sql-schema-generation-numeric-'));
		const storageUri = vscode.Uri.file(directory);
		fs.writeFileSync(path.join(directory, 'sql-schema-cache-generation.v1.json'), JSON.stringify({ generation: 42 }), 'utf8');
		try {
			const generation = await captureSqlSchemaCacheGeneration(storageUri);
			expect(generation).toMatch(/^[0-9a-f-]{36}$/);
			expect(generation).not.toBe('42');
			expect(fs.readdirSync(directory).some(name => name.startsWith('sql-schema-cache-generation.v1.json.corrupt-'))).toBe(true);
		} finally {
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});

	it('deletes the final schema file when ownership changes after rename', async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sql-schema-publish-owner-'));
		const storageUri = vscode.Uri.file(directory);
		const cacheDirUri = vscode.Uri.joinPath(storageUri, 'sqlSchemaCache');
		const tempUri = vscode.Uri.joinPath(cacheDirUri, 'pending.tmp');
		const fileUri = vscode.Uri.joinPath(cacheDirUri, 'schema.json');
		const fsApi = vscode.workspace.fs as any;
		const originalRename = fsApi.rename;
		const originalDelete = fsApi.delete;
		fsApi.rename = vi.fn(async () => undefined);
		fsApi.delete = vi.fn(async () => undefined);
		let checks = 0;
		try {
			const generation = await captureSqlSchemaCacheGeneration(storageUri);
			await expect(publishSqlSchemaCacheFile(storageUri, generation, tempUri, fileUri, vi.fn(async () => {
				if (++checks === 2) throw new Error('owner changed');
			}))).rejects.toThrow('owner changed');
			expect(fsApi.delete).toHaveBeenCalledWith(fileUri, { useTrash: false });
		} finally {
			if (originalRename === undefined) delete fsApi.rename; else fsApi.rename = originalRename;
			if (originalDelete === undefined) delete fsApi.delete; else fsApi.delete = originalDelete;
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});

	it('invalidates a surviving stale schema file when post-rename deletion fails', async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sql-schema-publish-delete-failure-'));
		const storageUri = vscode.Uri.file(directory);
		const cacheDirUri = vscode.Uri.joinPath(storageUri, 'sqlSchemaCache');
		const owner = { principalFingerprint: 'principal-a', targetSignature: 'target-a' };
		const cacheKey = sqlSchemaCacheKey('Db', 'sql-1', owner);
		const tempUri = vscode.Uri.joinPath(cacheDirUri, 'pending.tmp');
		const fileUri = getSqlSchemaCacheFileUri(storageUri, cacheKey);
		const fsApi = vscode.workspace.fs as any;
		const originalRename = fsApi.rename;
		const originalDelete = fsApi.delete;
		try {
			const generation = await captureSqlSchemaCacheGeneration(storageUri);
			await fsApi.writeFile(tempUri, Buffer.from(JSON.stringify({
				version: SQL_SCHEMA_CACHE_VERSION,
				schema: { tables: ['SchemaA'], columnsByTable: {} },
				timestamp: Date.now(),
				serverUrl: 'server.example',
				database: 'Db',
				connectionId: 'sql-1',
				...owner,
				cacheGeneration: generation,
			}), 'utf8'));
			fsApi.rename = vi.fn(async (source: vscode.Uri, target: vscode.Uri) => {
				const bytes = await fsApi.readFile(source);
				await fsApi.writeFile(target, bytes);
				await originalDelete(source, { useTrash: false });
			});
			fsApi.delete = vi.fn(async (uri: vscode.Uri, options: unknown) => {
				if (uri.toString() === fileUri.toString()) throw new Error('access denied');
				return originalDelete(uri, options);
			});
			let checks = 0;

			await expect(publishSqlSchemaCacheFile(storageUri, generation, tempUri, fileUri, vi.fn(async () => {
				if (++checks === 2) throw new Error('request A superseded');
			}))).rejects.toThrow('request A superseded');

			expect(await captureSqlSchemaCacheGeneration(storageUri)).not.toBe(generation);
			await expect(readCachedSqlSchemaFromDisk(storageUri, cacheKey, {
				connectionId: 'sql-1',
				...owner,
			}, generation)).resolves.toBeUndefined();
			await expect(readCachedSqlSchemaFromDisk(storageUri, cacheKey, {
				connectionId: 'sql-1',
				...owner,
			})).resolves.toBeUndefined();
		} finally {
			if (originalRename === undefined) delete fsApi.rename; else fsApi.rename = originalRename;
			if (originalDelete === undefined) delete fsApi.delete; else fsApi.delete = originalDelete;
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});

	it('rejects a schema publish captured before Clear All', async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sql-schema-generation-'));
		const storageUri = vscode.Uri.file(directory);
		const cacheDirUri = vscode.Uri.joinPath(storageUri, 'sqlSchemaCache');
		const tempUri = vscode.Uri.joinPath(cacheDirUri, 'pending.tmp');
		const fileUri = vscode.Uri.joinPath(cacheDirUri, 'schema.json');
		const fsApi = vscode.workspace.fs as any;
		const originalRename = fsApi.rename;
		const originalDelete = fsApi.delete;
		fsApi.rename = vi.fn(async () => undefined);
		fsApi.delete = vi.fn(async () => undefined);

		try {
			const generation = await captureSqlSchemaCacheGeneration(storageUri);
			await clearSqlSchemaCacheFiles(storageUri, cacheDirUri);

			await expect(publishSqlSchemaCacheFile(storageUri, generation, tempUri, fileUri, vi.fn(async () => undefined)))
				.resolves.toBe(false);
			expect(fsApi.rename).not.toHaveBeenCalled();
			expect(fsApi.delete).toHaveBeenCalledWith(cacheDirUri, { recursive: true, useTrash: false });
		} finally {
			if (originalRename === undefined) delete fsApi.rename;
			else fsApi.rename = originalRename;
			if (originalDelete === undefined) delete fsApi.delete;
			else fsApi.delete = originalDelete;
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});

	it('advances generation but reports a non-missing cache deletion failure', async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sql-schema-delete-failure-'));
		const storageUri = vscode.Uri.file(directory);
		const cacheDirUri = vscode.Uri.joinPath(storageUri, 'sqlSchemaCache');
		const fsApi = vscode.workspace.fs as any;
		const originalDelete = fsApi.delete;
		fsApi.delete = vi.fn(async () => { throw Object.assign(new Error('access denied'), { code: 'EACCES' }); });
		try {
			const before = await captureSqlSchemaCacheGeneration(storageUri);
			await expect(clearSqlSchemaCacheFiles(storageUri, cacheDirUri)).rejects.toThrow('access denied');
			expect(await captureSqlSchemaCacheGeneration(storageUri)).not.toBe(before);
		} finally {
			if (originalDelete === undefined) delete fsApi.delete;
			else fsApi.delete = originalDelete;
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});
});