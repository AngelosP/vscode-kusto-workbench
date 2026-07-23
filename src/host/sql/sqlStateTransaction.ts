import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as lockfile from 'proper-lockfile';

const DEFAULT_LOCK_STALE_MS = 30_000;
const DEFAULT_RENAME_RETRY_DELAYS_MS = [10, 25, 50, 100, 200] as const;
const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

export type SqlJsonStateReadResult<T> =
	| { kind: 'missing' }
	| { kind: 'valid'; value: T; text: string }
	| { kind: 'invalid'; reason: 'syntax' | 'structure' };

export type RecoverableSqlStateReadResult<T> =
	| { kind: 'missing' }
	| { kind: 'invalid'; reason: 'syntax' | 'structure' | 'uncommitted' }
	| {
		kind: 'valid'; value: T; text: string; source: 'primary' | 'backup'; committed: boolean;
		primaryState?: 'missing' | 'invalid' | 'uncommitted';
	};

export type SqlStateCommitIdentity = Readonly<{
	schemaVersion: number;
	version: number;
}>;

export type SqlStateCommit = SqlStateCommitIdentity & Readonly<{
	sha256: string;
	backupSlot?: 0 | 1;
}>;

export interface SqlStateLockOptions {
	staleMs?: number;
	updateMs?: number;
	retries?: number;
	retryDelayMs?: number;
	retryUntilStale?: boolean;
}

export interface AtomicReplaceSqlStateFileOptions {
	retryDelaysMs?: readonly number[];
}

export function isSqlStateLockContentionError(error: unknown): boolean {
	return String((error as NodeJS.ErrnoException | undefined)?.code || '') === 'ELOCKED';
}

export interface RecoverableSqlStateSnapshotOptions {
	primaryPath: string;
	backupPath: string;
	commitPath: string;
	migrationPath?: string;
	text: string;
	identity: SqlStateCommitIdentity;
	writeAtomic?: (filePath: string, contents: string) => Promise<void>;
}

export async function withSqlStateFileLock<T>(
	lockTarget: string,
	action: () => Promise<T>,
	options: SqlStateLockOptions = {},
): Promise<T> {
	await fs.promises.mkdir(path.dirname(lockTarget), { recursive: true });
	const retryDelayMs = options.retryDelayMs ?? 25;
	const staleMs = options.staleMs ?? DEFAULT_LOCK_STALE_MS;
	const retries = options.retries ?? (options.retryUntilStale
		? Math.ceil(staleMs / Math.max(1, retryDelayMs)) + 4
		: 100);
	const release = await lockfile.lock(lockTarget, {
		realpath: false,
		stale: staleMs,
		update: options.updateMs ?? 5_000,
		retries: {
			retries,
			factor: 1,
			minTimeout: retryDelayMs,
			maxTimeout: retryDelayMs,
		},
	});
	try {
		return await action();
	} finally {
		await release();
	}
}

export async function atomicReplaceSqlStateFile(
	filePath: string,
	contents: string | Uint8Array,
	options: AtomicReplaceSqlStateFileOptions = {},
): Promise<void> {
	await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
	const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
	await fs.promises.writeFile(tempPath, contents);
	try {
		const retryDelays = options.retryDelaysMs ?? DEFAULT_RENAME_RETRY_DELAYS_MS;
		for (let attempt = 0; ; attempt += 1) {
			try {
				await fs.promises.rename(tempPath, filePath);
				return;
			} catch (error) {
				const code = String((error as NodeJS.ErrnoException)?.code || '');
				const delayMs = retryDelays[attempt];
				if (delayMs === undefined || !RETRYABLE_RENAME_CODES.has(code)) throw error;
				await new Promise<void>(resolve => setTimeout(resolve, delayMs));
			}
		}
	} finally {
		try { await fs.promises.rm(tempPath, { force: true }); } catch { /* ignore cleanup failure */ }
	}
}

export async function readSqlJsonStateFile<T>(
	filePath: string,
	parse: (value: unknown) => T | undefined,
): Promise<SqlJsonStateReadResult<T>> {
	try {
		const text = await fs.promises.readFile(filePath, 'utf8');
		let value: unknown;
		try {
			value = JSON.parse(text);
		} catch (error) {
			if (error instanceof SyntaxError) return { kind: 'invalid', reason: 'syntax' };
			throw error;
		}
		const parsed = parse(value);
		return parsed === undefined
			? { kind: 'invalid', reason: 'structure' }
			: { kind: 'valid', value: parsed, text };
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { kind: 'missing' };
		throw error;
	}
}

export function createSqlStateCommit(text: string, identity: SqlStateCommitIdentity): SqlStateCommit {
	return {
		...identity,
		sha256: crypto.createHash('sha256').update(text, 'utf8').digest('hex'),
	};
}

export async function readCommittedSqlStateBackup<T>(options: {
	backupPath: string;
	commitPath: string;
	parseSnapshot: (value: unknown) => T | undefined;
	getIdentity: (snapshot: T) => SqlStateCommitIdentity;
}): Promise<T | undefined> {
	try {
		const committed = await readVerifiedSqlStateBackup(options.backupPath, options.commitPath);
		if (!committed) return undefined;
		const backup = await readSqlJsonStateFile(committed.path, options.parseSnapshot);
		if (backup.kind !== 'valid') return undefined;
		const identity = options.getIdentity(backup.value);
		const expected = createSqlStateCommit(backup.text, identity);
		return committed.commit.schemaVersion === expected.schemaVersion
			&& committed.commit.version === expected.version
			&& committed.commit.sha256 === expected.sha256
			? backup.value
			: undefined;
	} catch {
		return undefined;
	}
}

export async function writeRecoverableSqlStateSnapshot(options: RecoverableSqlStateSnapshotOptions): Promise<void> {
	const writeAtomic = options.writeAtomic ?? atomicReplaceSqlStateFile;
	const previousCommitted = await readVerifiedSqlStateBackup(options.backupPath, options.commitPath);
	const activeSlot = previousCommitted?.slot;
	const nextSlot: 0 | 1 = activeSlot === 0 ? 1 : 0;
	const commit = { ...createSqlStateCommit(options.text, options.identity), backupSlot: nextSlot } satisfies SqlStateCommit;
	const previousPrimary = await readOptionalFile(options.primaryPath);
	await writeAtomic(sqlStateBackupSlotPath(options.backupPath, nextSlot), options.text);
	await writeAtomic(options.primaryPath, options.text);
	try {
		await writeAtomic(options.commitPath, `${JSON.stringify(commit)}\n`);
	} catch (commitError) {
		try {
			if (previousPrimary !== undefined) await writeAtomic(options.primaryPath, previousPrimary);
			else await fs.promises.rm(options.primaryPath, { force: true });
		} catch (rollbackError) {
			throw new Error(`Failed to publish SQL state commit and restore the previous primary: ${String(rollbackError)}`, { cause: commitError });
		}
		throw commitError;
	}
	if (options.migrationPath) await writeSqlStateMarkerIfMissing(options.migrationPath, 'migrated\n', writeAtomic);
}

export async function writeSqlStateMarkerIfMissing(
	markerPath: string,
	contents = 'migrated\n',
	writeAtomic: (filePath: string, contents: string) => Promise<void> = atomicReplaceSqlStateFile,
): Promise<void> {
	if (fs.existsSync(markerPath)) return;
	try {
		await writeAtomic(markerPath, contents);
	} catch {
		// A valid primary snapshot makes marker creation safe to retry later.
	}
}

function parseSqlStateCommit(value: unknown): SqlStateCommit | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
	const candidate = value as Partial<SqlStateCommit>;
	if (!Number.isSafeInteger(candidate.schemaVersion)
		|| !Number.isSafeInteger(candidate.version)
		|| typeof candidate.sha256 !== 'string'
		|| !/^[0-9a-f]{64}$/.test(candidate.sha256)
		|| (candidate.backupSlot !== undefined && candidate.backupSlot !== 0 && candidate.backupSlot !== 1)) return undefined;
	return {
		schemaVersion: Number(candidate.schemaVersion),
		version: Number(candidate.version),
		sha256: candidate.sha256,
		...(candidate.backupSlot !== undefined ? { backupSlot: candidate.backupSlot } : {}),
	};
}

function sqlStateBackupSlotPath(backupPath: string, slot: 0 | 1): string {
	return slot === 0 ? backupPath : `${backupPath}.slot1`;
}

async function readVerifiedSqlStateBackup(
	backupPath: string,
	commitPath: string,
): Promise<{ commit: SqlStateCommit; slot: 0 | 1; path: string; text: string } | undefined> {
	const commit = await readSqlJsonStateFile(commitPath, parseSqlStateCommit);
	if (commit.kind !== 'valid') return undefined;
	const slot = commit.value.backupSlot ?? 0;
	const resolvedPath = sqlStateBackupSlotPath(backupPath, slot);
	const text = await readOptionalFile(resolvedPath);
	if (text === undefined || createSqlStateCommit(text, commit.value).sha256 !== commit.value.sha256) return undefined;
	return { commit: commit.value, slot, path: resolvedPath, text };
}

async function readOptionalFile(filePath: string): Promise<string | undefined> {
	try {
		return await fs.promises.readFile(filePath, 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined;
		throw error;
	}
}

export async function readRecoverableSqlStateSnapshot<T>(options: {
	primaryPath: string;
	backupPath: string;
	commitPath: string;
	parseSnapshot: (value: unknown) => T | undefined;
	getIdentity: (snapshot: T) => SqlStateCommitIdentity;
	allowUncommittedPrimary?: boolean;
}): Promise<RecoverableSqlStateReadResult<T>> {
	const primary = await readSqlJsonStateFile(options.primaryPath, options.parseSnapshot);
	const committed = await readVerifiedSqlStateBackup(options.backupPath, options.commitPath);
	if (committed) {
		const backup = await readSqlJsonStateFile(committed.path, options.parseSnapshot);
		if (backup.kind !== 'valid') return { kind: 'invalid', reason: 'structure' };
		const backupIdentity = options.getIdentity(backup.value);
		if (backupIdentity.schemaVersion !== committed.commit.schemaVersion
			|| backupIdentity.version !== committed.commit.version) return { kind: 'invalid', reason: 'structure' };
		if (primary.kind === 'valid') {
			const primaryIdentity = options.getIdentity(primary.value);
			const primaryCommit = createSqlStateCommit(primary.text, primaryIdentity);
			if (primaryCommit.schemaVersion === committed.commit.schemaVersion
				&& primaryCommit.version === committed.commit.version
				&& primaryCommit.sha256 === committed.commit.sha256) {
				return { kind: 'valid', value: primary.value, text: primary.text, source: 'primary', committed: true };
			}
		}
		return {
			kind: 'valid', value: backup.value, text: backup.text, source: 'backup', committed: true,
			primaryState: primary.kind === 'valid' ? 'uncommitted' : primary.kind,
		};
	}
	if (primary.kind === 'valid') {
		const transactionArtifactsExist = await anySqlStateTransactionArtifactExists(
			options.backupPath,
			options.commitPath,
		);
		return options.allowUncommittedPrimary && !transactionArtifactsExist
			? { kind: 'valid', value: primary.value, text: primary.text, source: 'primary', committed: false }
			: { kind: 'invalid', reason: 'uncommitted' };
	}
	return primary;
}

async function anySqlStateTransactionArtifactExists(backupPath: string, commitPath: string): Promise<boolean> {
	for (const filePath of [commitPath, sqlStateBackupSlotPath(backupPath, 0), sqlStateBackupSlotPath(backupPath, 1)]) {
		try {
			await fs.promises.access(filePath);
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
		}
	}
	return false;
}