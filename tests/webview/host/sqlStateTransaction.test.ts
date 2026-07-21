import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	atomicReplaceSqlStateFile,
	createSqlStateCommit,
	readCommittedSqlStateBackup,
	readRecoverableSqlStateSnapshot,
	readSqlJsonStateFile,
	withSqlStateFileLock,
	writeRecoverableSqlStateSnapshot,
} from '../../../src/host/sql/sqlStateTransaction';

const tempDirectories: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	for (const directory of tempDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function createDirectory(): string {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sql-state-transaction-'));
	tempDirectories.push(directory);
	return directory;
}

describe('SQL state transactions', () => {
	it.each(['EPERM', 'EACCES', 'EBUSY'])('retries a transient Windows %s replace failure', async code => {
		const filePath = path.join(createDirectory(), 'state.json');
		const realRename = fs.promises.rename.bind(fs.promises);
		let attempts = 0;
		vi.spyOn(fs.promises, 'rename').mockImplementation(async (oldPath, newPath) => {
			attempts += 1;
			if (attempts === 1) throw Object.assign(new Error('temporarily locked'), { code });
			await realRename(oldPath, newPath);
		});

		await atomicReplaceSqlStateFile(filePath, 'current\n', { retryDelaysMs: [0] });

		expect(attempts).toBe(2);
		expect(fs.readFileSync(filePath, 'utf8')).toBe('current\n');
	});

	it('does not retry a non-transient replace failure and removes the temp file', async () => {
		const directory = createDirectory();
		const filePath = path.join(directory, 'state.json');
		vi.spyOn(fs.promises, 'rename').mockRejectedValue(Object.assign(new Error('disk failed'), { code: 'EIO' }));

		await expect(atomicReplaceSqlStateFile(filePath, 'current\n', { retryDelaysMs: [0, 0] })).rejects.toThrow('disk failed');
		expect(fs.readdirSync(directory).filter(name => name.endsWith('.tmp'))).toEqual([]);
	});

	it('classifies missing, malformed, structurally invalid, and valid JSON state', async () => {
		const directory = createDirectory();
		const filePath = path.join(directory, 'state.json');
		const parse = (value: unknown) => {
			const candidate = value as { schemaVersion?: unknown; version?: unknown } | undefined;
			return candidate?.schemaVersion === 1 && Number.isSafeInteger(candidate.version)
				? { schemaVersion: 1, version: Number(candidate.version) }
				: undefined;
		};

		await expect(readSqlJsonStateFile(filePath, parse)).resolves.toEqual({ kind: 'missing' });
		fs.writeFileSync(filePath, '{broken', 'utf8');
		await expect(readSqlJsonStateFile(filePath, parse)).resolves.toEqual({ kind: 'invalid', reason: 'syntax' });
		fs.writeFileSync(filePath, '{}', 'utf8');
		await expect(readSqlJsonStateFile(filePath, parse)).resolves.toEqual({ kind: 'invalid', reason: 'structure' });
		fs.writeFileSync(filePath, '{"schemaVersion":1,"version":2}\n', 'utf8');
		expect(await readSqlJsonStateFile(filePath, parse)).toMatchObject({
			kind: 'valid', value: { schemaVersion: 1, version: 2 },
		});
	});

	it('holds a shared lock until an asynchronous transaction completes', async () => {
		const lockTarget = path.join(createDirectory(), 'state.json.write');
		let releaseFirst!: () => void;
		const firstEntered = new Promise<void>(resolve => { releaseFirst = resolve; });
		let entered = false;
		const first = withSqlStateFileLock(lockTarget, async () => {
			await firstEntered;
		});
		const second = withSqlStateFileLock(lockTarget, async () => { entered = true; });
		await new Promise<void>(resolve => setImmediate(resolve));
		expect(entered).toBe(false);
		releaseFirst();
		await Promise.all([first, second]);
		expect(entered).toBe(true);
	});

	it('writes and verifies a hash-committed redundant snapshot', async () => {
		const directory = createDirectory();
		const primaryPath = path.join(directory, 'state.json');
		const backupPath = path.join(directory, 'state.backup.json');
		const commitPath = path.join(directory, 'state.commit.json');
		const migrationPath = path.join(directory, 'state-migrated');
		const snapshot = { schemaVersion: 1, version: 7, value: 'current' };
		const text = `${JSON.stringify(snapshot, null, 2)}\n`;

		await writeRecoverableSqlStateSnapshot({
			primaryPath, backupPath, commitPath, migrationPath, text,
			identity: { schemaVersion: 1, version: 7 },
		});
		const parse = (value: unknown) => {
			const candidate = value as typeof snapshot;
			return candidate?.schemaVersion === 1 && candidate.version === 7 ? candidate : undefined;
		};
		expect(await readCommittedSqlStateBackup({
			backupPath, commitPath, parseSnapshot: parse,
			getIdentity: value => ({ schemaVersion: value.schemaVersion, version: value.version }),
		})).toEqual(snapshot);
		expect(fs.readFileSync(primaryPath, 'utf8')).toBe(text);
		expect(fs.readFileSync(migrationPath, 'utf8')).toBe('migrated\n');
	});

	it('rejects a backup whose commit marker hash is stale', async () => {
		const directory = createDirectory();
		const backupPath = path.join(directory, 'state.backup.json');
		const commitPath = path.join(directory, 'state.commit.json');
		const oldText = '{"schemaVersion":1,"version":1}\n';
		fs.writeFileSync(backupPath, '{"schemaVersion":1,"version":2}\n', 'utf8');
		fs.writeFileSync(commitPath, `${JSON.stringify(createSqlStateCommit(oldText, { schemaVersion: 1, version: 1 }))}\n`, 'utf8');

		const recovered = await readCommittedSqlStateBackup({
			backupPath,
			commitPath,
			parseSnapshot: value => value as { schemaVersion: number; version: number },
			getIdentity: value => value,
		});
		expect(recovered).toBeUndefined();
	});

	it('preserves the prior committed backup when a new primary write fails', async () => {
		const directory = createDirectory();
		const primaryPath = path.join(directory, 'state.json');
		const backupPath = path.join(directory, 'state.backup.json');
		const commitPath = path.join(directory, 'state.commit.json');
		const first = { schemaVersion: 1, version: 1, value: 'first' };
		const second = { schemaVersion: 1, version: 2, value: 'second' };
		const parse = (value: unknown) => {
			const candidate = value as typeof first;
			return candidate?.schemaVersion === 1 && Number.isSafeInteger(candidate.version) ? candidate : undefined;
		};
		await writeRecoverableSqlStateSnapshot({
			primaryPath, backupPath, commitPath, text: `${JSON.stringify(first)}\n`,
			identity: { schemaVersion: 1, version: 1 },
		});
		const realWrite = async (filePath: string, contents: string) => atomicReplaceSqlStateFile(filePath, contents);
		await expect(writeRecoverableSqlStateSnapshot({
			primaryPath, backupPath, commitPath, text: `${JSON.stringify(second)}\n`,
			identity: { schemaVersion: 1, version: 2 },
			writeAtomic: async (filePath, contents) => {
				if (filePath === primaryPath) throw new Error('primary failed');
				await realWrite(filePath, contents);
			},
		})).rejects.toThrow('primary failed');

		expect(await readCommittedSqlStateBackup({
			backupPath, commitPath, parseSnapshot: parse,
			getIdentity: value => ({ schemaVersion: value.schemaVersion, version: value.version }),
		})).toEqual(first);
	});

	it('returns the pointed backup after a crash replaces primary before pointer advancement', async () => {
		const directory = createDirectory();
		const primaryPath = path.join(directory, 'state.json');
		const backupPath = path.join(directory, 'state.backup.json');
		const commitPath = path.join(directory, 'state.commit.json');
		const committed = { schemaVersion: 1, version: 1, value: 'committed' };
		const uncommitted = { schemaVersion: 1, version: 2, value: 'uncommitted' };
		const parse = (value: unknown) => {
			const candidate = value as typeof committed;
			return candidate?.schemaVersion === 1 && Number.isSafeInteger(candidate.version)
				&& typeof candidate.value === 'string' ? candidate : undefined;
		};
		await writeRecoverableSqlStateSnapshot({
			primaryPath, backupPath, commitPath, text: `${JSON.stringify(committed)}\n`,
			identity: { schemaVersion: 1, version: 1 },
		});
		fs.writeFileSync(primaryPath, `${JSON.stringify(uncommitted)}\n`, 'utf8');

		await expect(readRecoverableSqlStateSnapshot({
			primaryPath, backupPath, commitPath, parseSnapshot: parse,
			getIdentity: value => ({ schemaVersion: value.schemaVersion, version: value.version }),
		})).resolves.toMatchObject({
			kind: 'valid', source: 'backup', committed: true, primaryState: 'uncommitted', value: committed,
		});
	});

	it.each(['backup', 'alternate backup', 'commit'] as const)(
		'rejects a pointerless primary as legacy when a %s artifact remains',
		async artifact => {
			const directory = createDirectory();
			const primaryPath = path.join(directory, 'state.json');
			const backupPath = path.join(directory, 'state.backup.json');
			const commitPath = path.join(directory, 'state.commit.json');
			const snapshot = { schemaVersion: 1, version: 1 };
			fs.writeFileSync(primaryPath, `${JSON.stringify(snapshot)}\n`, 'utf8');
			const artifactPath = artifact === 'backup'
				? backupPath
				: artifact === 'alternate backup' ? `${backupPath}.slot1` : commitPath;
			fs.writeFileSync(artifactPath, 'incomplete transaction\n', 'utf8');

			await expect(readRecoverableSqlStateSnapshot({
				primaryPath, backupPath, commitPath,
				parseSnapshot: value => value as typeof snapshot,
				getIdentity: value => value,
				allowUncommittedPrimary: true,
			})).resolves.toEqual({ kind: 'invalid', reason: 'uncommitted' });
		},
	);
});