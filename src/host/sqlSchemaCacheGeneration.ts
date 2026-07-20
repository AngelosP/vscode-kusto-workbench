import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as lockfile from 'proper-lockfile';
import * as vscode from 'vscode';
import { quarantineCorruptSqlStateFile } from './sql/sqlStateFile';

const GENERATION_FILENAME = 'sql-schema-cache-generation.v1.json';
const LOCK_STALE_MS = 30_000;

function paths(globalStorageUri: vscode.Uri): { generationPath: string; lockTarget: string } | undefined {
	const root = String(globalStorageUri.fsPath || '').trim();
	if (!root) return undefined;
	const generationPath = path.join(root, GENERATION_FILENAME);
	return { generationPath, lockTarget: `${generationPath}.write` };
}

async function readGeneration(generationPath: string): Promise<string> {
	try {
		const parsed = JSON.parse(await fs.promises.readFile(generationPath, 'utf8')) as { generation?: unknown };
		const generation = String(parsed.generation || '').trim();
		if (generation) return generation;
		await quarantineCorruptSqlStateFile(generationPath);
		const recoveredGeneration = crypto.randomUUID();
		await writeGeneration(generationPath, recoveredGeneration);
		return recoveredGeneration;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			const recoveredGeneration = crypto.randomUUID();
			await writeGeneration(generationPath, recoveredGeneration);
			return recoveredGeneration;
		}
		if (!(error instanceof SyntaxError)) throw error;
		await quarantineCorruptSqlStateFile(generationPath);
		const recoveredGeneration = crypto.randomUUID();
		await writeGeneration(generationPath, recoveredGeneration);
		return recoveredGeneration;
	}
}

async function writeGeneration(generationPath: string, generation: string): Promise<void> {
	await fs.promises.mkdir(path.dirname(generationPath), { recursive: true });
	const tempPath = `${generationPath}.${process.pid}.${Date.now()}.tmp`;
	await fs.promises.writeFile(tempPath, `${JSON.stringify({ generation })}\n`, 'utf8');
	try {
		await fs.promises.rename(tempPath, generationPath);
	} finally {
		try { await fs.promises.rm(tempPath, { force: true }); } catch { /* ignore */ }
	}
}

async function withGenerationLock<T>(globalStorageUri: vscode.Uri, action: (generation: string) => Promise<T>): Promise<T> {
	const resolved = paths(globalStorageUri);
	if (!resolved) return action('memory');
	await fs.promises.mkdir(path.dirname(resolved.generationPath), { recursive: true });
	const release = await lockfile.lock(resolved.lockTarget, {
		realpath: false,
		stale: LOCK_STALE_MS,
		update: 5_000,
		retries: { retries: 100, factor: 1, minTimeout: 25, maxTimeout: 25 },
	});
	try {
		return await action(await readGeneration(resolved.generationPath));
	} finally {
		await release();
	}
}

export async function captureSqlSchemaCacheGeneration(globalStorageUri: vscode.Uri): Promise<string> {
	return withGenerationLock(globalStorageUri, async generation => generation);
}

export async function publishSqlSchemaCacheFile(
	globalStorageUri: vscode.Uri,
	expectedGeneration: string,
	tempUri: vscode.Uri,
	fileUri: vscode.Uri,
	assertOwner: () => Promise<void>,
): Promise<boolean> {
	return withGenerationLock(globalStorageUri, async generation => {
		if (generation !== expectedGeneration) return false;
		await assertOwner();
		await vscode.workspace.fs.rename(tempUri, fileUri, { overwrite: true });
		try {
			await assertOwner();
		} catch (error) {
			try { await vscode.workspace.fs.delete(fileUri, { useTrash: false }); } catch { /* preserve ownership error */ }
			throw error;
		}
		return true;
	});
}

export async function clearSqlSchemaCacheFiles(globalStorageUri: vscode.Uri, cacheDirUri: vscode.Uri): Promise<void> {
	await withGenerationLock(globalStorageUri, async () => {
		const resolved = paths(globalStorageUri);
		if (resolved) await writeGeneration(resolved.generationPath, crypto.randomUUID());
		try {
			await vscode.workspace.fs.delete(cacheDirUri, { recursive: true, useTrash: false });
		} catch (error) {
			const code = String((error as { code?: unknown })?.code || '');
			if (code !== 'ENOENT' && code !== 'FileNotFound') throw error;
		}
	});
}