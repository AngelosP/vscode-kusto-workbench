import * as crypto from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import { quarantineCorruptSqlStateFile } from './sql/sqlStateFile';
import {
	atomicReplaceSqlStateFile,
	readSqlJsonStateFile,
	withSqlStateFileLock,
} from './sql/sqlStateTransaction';

const GENERATION_FILENAME = 'sql-schema-cache-generation.v1.json';
const LOCK_STALE_MS = 30_000;

function paths(globalStorageUri: vscode.Uri): { generationPath: string; lockTarget: string } | undefined {
	const root = String(globalStorageUri.fsPath || '').trim();
	if (!root) return undefined;
	const generationPath = path.join(root, GENERATION_FILENAME);
	return { generationPath, lockTarget: `${generationPath}.write` };
}

async function readGeneration(generationPath: string): Promise<string> {
	const read = await readSqlJsonStateFile(generationPath, value => {
		if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
		const candidate = value as { generation?: unknown };
		if (typeof candidate.generation !== 'string') return undefined;
		const generation = candidate.generation.trim();
		return generation || undefined;
	});
	if (read.kind === 'valid') return read.value;
	if (read.kind === 'invalid') await quarantineCorruptSqlStateFile(generationPath);
	const recoveredGeneration = crypto.randomUUID();
	await writeGeneration(generationPath, recoveredGeneration);
	return recoveredGeneration;
}

async function writeGeneration(generationPath: string, generation: string): Promise<void> {
	await atomicReplaceSqlStateFile(generationPath, `${JSON.stringify({ generation })}\n`);
}

async function withGenerationLock<T>(globalStorageUri: vscode.Uri, action: (generation: string) => Promise<T>): Promise<T> {
	const resolved = paths(globalStorageUri);
	if (!resolved) return action('memory');
	return withSqlStateFileLock(resolved.lockTarget, async () => {
		return await action(await readGeneration(resolved.generationPath));
	}, { staleMs: LOCK_STALE_MS });
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