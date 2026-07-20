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