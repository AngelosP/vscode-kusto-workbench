import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Uri } from 'vscode';
import { SqlLeaveNoTracePolicyStore } from '../../../src/host/sql/sqlLeaveNoTracePolicyStore';
import { SQL_LEAVE_NO_TRACE_STORAGE_KEY } from '../../../src/host/sql/sqlLeaveNoTrace';

const tempDirectories: string[] = [];

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>(res => { resolve = res; });
	return { promise, resolve };
}

afterEach(() => {
	for (const directory of tempDirectories.splice(0)) {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

function createContext(directory: string) {
	const values = new Map<string, unknown>();
	return {
		globalStorageUri: Uri.file(directory),
		globalState: {
			get: vi.fn((key: string) => values.get(key)),
			update: vi.fn(async (key: string, value: unknown) => { values.set(key, value); }),
		},
		_values: values,
	} as any;
}

function createOutput() {
	return { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;
}

describe('SqlLeaveNoTracePolicyStore', () => {
	it('retries a transient Windows failure while replacing the canonical policy', async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sql-lnt-rename-retry-'));
		tempDirectories.push(directory);
		const store = new SqlLeaveNoTracePolicyStore(createContext(directory), createOutput());
		let renameSpy: ReturnType<typeof vi.spyOn> | undefined;
		try {
			await store.refresh();
			const realRename = fs.promises.rename.bind(fs.promises);
			let rejectedOnce = false;
			renameSpy = vi.spyOn(fs.promises, 'rename').mockImplementation(async (oldPath, newPath) => {
				if (!rejectedOnce && String(newPath).endsWith('sql-leave-no-trace-policy.v1.json')) {
					rejectedOnce = true;
					throw Object.assign(new Error('temporarily locked'), { code: 'EPERM' });
				}
				await realRename(oldPath, newPath);
			});

			await expect(store.setConnection('sql-sensitive', true)).resolves.toBeUndefined();
			expect(rejectedOnce).toBe(true);
			await expect(store.assertAllowed('sql-sensitive')).rejects.toThrow('may buffer results on disk');
		} finally {
			renameSpy?.mockRestore();
			store.dispose();
		}
	});

	it('holds the canonical policy lock until an asynchronous publication callback completes', async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sql-lnt-publication-lock-'));
		tempDirectories.push(directory);
		const first = new SqlLeaveNoTracePolicyStore(createContext(directory), createOutput());
		const second = new SqlLeaveNoTracePolicyStore(createContext(directory), createOutput());
		const entered = deferred<void>();
		const release = deferred<void>();
		try {
			await Promise.all([first.refresh(), second.refresh()]);
			const publication = first.runWithSnapshotLock(async snapshot => {
				expect(snapshot.connectionIds).toEqual([]);
				entered.resolve();
				await release.promise;
				return 'published';
			});
			await entered.promise;
			let mutationCompleted = false;
			const mutation = second.setConnection('sql-sensitive', true).then(() => { mutationCompleted = true; });
			await new Promise<void>(resolve => setImmediate(resolve));
			expect(mutationCompleted).toBe(false);

			release.resolve();
			await expect(publication).resolves.toBe('published');
			await mutation;
			expect(await second.refresh()).toEqual(['sql-sensitive']);
		} finally {
			first.dispose();
			second.dispose();
		}
	});

	it('emits a durable invalidation when another host enables and disables LNT before refresh', async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sql-lnt-coalesced-'));
		tempDirectories.push(directory);
		const first = new SqlLeaveNoTracePolicyStore(createContext(directory), createOutput());
		const second = new SqlLeaveNoTracePolicyStore(createContext(directory), createOutput());
		const changes: any[] = [];
		second.onDidChange(change => changes.push(change));
		try {
			await Promise.all([first.refresh(), second.refresh()]);

			await first.setConnection('sql-sensitive', true);
			await first.setConnection('sql-sensitive', false);
			await second.refresh();

			expect(second.getConnectionIds()).toEqual([]);
			expect(changes).toEqual([expect.objectContaining({
				connectionIds: [],
				enabledConnectionIds: [],
				disabledConnectionIds: [],
				invalidatedConnectionIds: ['sql-sensitive'],
			})]);
		} finally {
			first.dispose();
			second.dispose();
		}
	});

	it('rejects old-owner dispatch after an unobserved enable-disable revocation interval', async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sql-lnt-coalesced-dispatch-'));
		tempDirectories.push(directory);
		const first = new SqlLeaveNoTracePolicyStore(createContext(directory), createOutput());
		const second = new SqlLeaveNoTracePolicyStore(createContext(directory), createOutput());
		const dispatch = vi.fn();
		try {
			await Promise.all([first.refresh(), second.refresh()]);
			const capturedGeneration = second.getRevocationGeneration('sql-sensitive');
			await first.setConnection('sql-sensitive', true);
			await first.setConnection('sql-sensitive', false);

			await expect(second.dispatchAllowed('sql-sensitive', dispatch, capturedGeneration))
				.rejects.toThrow('may buffer results on disk');
			expect(dispatch).not.toHaveBeenCalled();
		} finally {
			first.dispose();
			second.dispose();
		}
	});

	it.each([
		'sql-leave-no-trace-policy.backup.v1.json',
		'sql-leave-no-trace-policy.v1.json',
	])('keeps LNT enabled when the %s pre-commit stage fails during disable', async failedFile => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sql-lnt-precommit-'));
		tempDirectories.push(directory);
		const first = new SqlLeaveNoTracePolicyStore(createContext(directory), createOutput());
		try {
			await first.refresh();
			await first.setConnection('sql-sensitive', true);
			const store = first as any;
			const realWriteAtomic = store.writeAtomic.bind(store);
			vi.spyOn(store, 'writeAtomic').mockImplementation(async (filePath: string, contents: string) => {
				if (filePath.endsWith(failedFile) && contents.includes('"connectionIds": []')) {
					throw new Error(`${failedFile} failed`);
				}
				await realWriteAtomic(filePath, contents);
			});

			await expect(first.setConnection('sql-sensitive', false)).rejects.toThrow(`${failedFile} failed`);
			await expect(first.assertAllowed('sql-sensitive')).rejects.toThrow('may buffer results on disk');
		} finally {
			first.dispose();
		}

		const second = new SqlLeaveNoTracePolicyStore(createContext(directory), createOutput());
		try {
			await second.refresh();
			await expect(second.assertAllowed('sql-sensitive')).rejects.toThrow('may buffer results on disk');
		} finally {
			second.dispose();
		}
	});

	it('keeps the committed policy when the post-commit migration sentinel cannot be established', async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sql-lnt-migration-failure-'));
		tempDirectories.push(directory);
		const store = new SqlLeaveNoTracePolicyStore(createContext(directory), createOutput());
		try {
			await store.refresh();
			fs.rmSync(path.join(directory, 'sql-leave-no-trace-policy-migrated.v1'));
			const internal = store as any;
			const realWriteAtomic = internal.writeAtomic.bind(internal);
			vi.spyOn(internal, 'writeAtomic').mockImplementation(async (filePath: string, contents: string) => {
				if (filePath.endsWith('sql-leave-no-trace-policy-migrated.v1')) throw new Error('migration failed');
				await realWriteAtomic(filePath, contents);
			});

			await expect(store.setConnection('sql-sensitive', true)).resolves.toBeUndefined();
			await expect(store.assertAllowed('sql-sensitive')).rejects.toThrow('may buffer results on disk');
			expect(JSON.parse(fs.readFileSync(path.join(directory, 'sql-leave-no-trace-policy.v1.json'), 'utf8')).connectionIds).toEqual(['sql-sensitive']);
			expect(fs.existsSync(path.join(directory, 'sql-leave-no-trace-policy-migrated.v1'))).toBe(false);
		} finally {
			store.dispose();
		}
		const restarted = new SqlLeaveNoTracePolicyStore(createContext(directory), createOutput());
		try {
			await restarted.refresh();
			await expect(restarted.assertAllowed('sql-sensitive')).rejects.toThrow('may buffer results on disk');
		} finally {
			restarted.dispose();
		}
	});

	it('does not mark migration complete when canonical policy replacement fails', async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sql-lnt-migration-primary-failure-'));
		tempDirectories.push(directory);
		const store = new SqlLeaveNoTracePolicyStore(createContext(directory), createOutput());
		try {
			await store.refresh();
			fs.rmSync(path.join(directory, 'sql-leave-no-trace-policy-migrated.v1'));
			const internal = store as any;
			const realWriteAtomic = internal.writeAtomic.bind(internal);
			vi.spyOn(internal, 'writeAtomic').mockImplementation(async (filePath: string, contents: string) => {
				if (filePath.endsWith('sql-leave-no-trace-policy.v1.json')) throw new Error('primary failed');
				await realWriteAtomic(filePath, contents);
			});

			await expect(store.setConnection('sql-sensitive', true)).rejects.toThrow('primary failed');
			expect(fs.existsSync(path.join(directory, 'sql-leave-no-trace-policy-migrated.v1'))).toBe(false);
		} finally {
			store.dispose();
		}
	});

	it('treats a recovery-marker failure after primary replacement as a committed LNT disable', async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sql-lnt-marker-failure-'));
		tempDirectories.push(directory);
		const first = new SqlLeaveNoTracePolicyStore(createContext(directory), createOutput());
		try {
			await first.refresh();
			await first.setConnection('sql-sensitive', true);
			const store = first as any;
			const realWriteAtomic = store.writeAtomic.bind(store);
			vi.spyOn(store, 'writeAtomic').mockImplementation(async (filePath: string, contents: string) => {
				if (filePath.endsWith('sql-leave-no-trace-policy.commit.v1.json')) throw new Error('marker failed');
				await realWriteAtomic(filePath, contents);
			});

			await expect(first.setConnection('sql-sensitive', false)).resolves.toBeUndefined();
			await expect(first.assertAllowed('sql-sensitive')).resolves.toBeUndefined();
		} finally {
			first.dispose();
		}

		const second = new SqlLeaveNoTracePolicyStore(createContext(directory), createOutput());
		try {
			await second.refresh();
			await expect(second.assertAllowed('sql-sensitive')).resolves.toBeUndefined();
		} finally {
			second.dispose();
		}
	});

	it('blocks a dispatch callback when a canonical protection toggle commits first', async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sql-lnt-dispatch-blocked-'));
		tempDirectories.push(directory);
		const first = new SqlLeaveNoTracePolicyStore(createContext(directory), createOutput());
		const second = new SqlLeaveNoTracePolicyStore(createContext(directory), createOutput());
		const dispatch = vi.fn();
		try {
			await Promise.all([first.refresh(), second.refresh()]);
			await first.setConnection('sql-sensitive', true);

			await expect(second.dispatchAllowed('sql-sensitive', dispatch)).rejects.toThrow('may buffer results on disk');
			expect(dispatch).not.toHaveBeenCalled();
		} finally {
			first.dispose();
			second.dispose();
		}
	});

	it('invokes dispatch before a later toggle commits without holding the lock for the remote response', async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sql-lnt-dispatch-first-'));
		tempDirectories.push(directory);
		const first = new SqlLeaveNoTracePolicyStore(createContext(directory), createOutput());
		const second = new SqlLeaveNoTracePolicyStore(createContext(directory), createOutput());
		const remote = deferred<string>();
		const events: string[] = [];
		try {
			await Promise.all([first.refresh(), second.refresh()]);
			const result = second.dispatchAllowed('sql-sensitive', () => {
				events.push('dispatch');
				return remote.promise;
			});
			await vi.waitFor(() => expect(events).toEqual(['dispatch']));

			await first.setConnection('sql-sensitive', true);
			events.push('toggle');
			remote.resolve('done');

			await expect(result).resolves.toBe('done');
			expect(events).toEqual(['dispatch', 'toggle']);
		} finally {
			first.dispose();
			second.dispose();
		}
	});

	it('propagates versioned policy across extension hosts and blocks dispatch after refresh', async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sql-lnt-'));
		tempDirectories.push(directory);
		const firstContext = createContext(directory);
		const secondContext = createContext(directory);
		const first = new SqlLeaveNoTracePolicyStore(firstContext, createOutput());
		const second = new SqlLeaveNoTracePolicyStore(secondContext, createOutput());
		const secondChanges: unknown[] = [];
		second.onDidChange(change => secondChanges.push(change));

		try {
			await Promise.all([first.refresh(), second.refresh()]);
			await first.setConnection('sql-sensitive', true);
			await second.refresh();

			expect(second.getConnectionIds()).toEqual(['sql-sensitive']);
			expect(secondContext._values.get(SQL_LEAVE_NO_TRACE_STORAGE_KEY)).toEqual(['sql-sensitive']);
			await expect(second.assertAllowed('sql-sensitive')).rejects.toThrow('may buffer results on disk');
			expect(secondChanges).toEqual([expect.objectContaining({
				connectionIds: ['sql-sensitive'],
				enabledConnectionIds: ['sql-sensitive'],
			})]);

			await Promise.all([
				first.setConnection('sql-a', true),
				second.setConnection('sql-b', true),
			]);
			await Promise.all([first.refresh(), second.refresh()]);
			expect(first.getConnectionIds()).toEqual(['sql-a', 'sql-b', 'sql-sensitive']);
			expect(second.getConnectionIds()).toEqual(['sql-a', 'sql-b', 'sql-sensitive']);
		} finally {
			first.dispose();
			second.dispose();
		}
	});

	it('applies and emits a committed policy when the globalState mirror rejects', async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sql-lnt-mirror-'));
		tempDirectories.push(directory);
		const context = createContext(directory);
		const output = createOutput();
		const store = new SqlLeaveNoTracePolicyStore(context, output);
		const changes: unknown[] = [];
		store.onDidChange(change => changes.push(change));

		try {
			await store.refresh();
			context.globalState.update.mockRejectedValue(new Error('mirror failed'));

			await store.setConnection('sql-sensitive', true);

			expect(store.getConnectionIds()).toEqual(['sql-sensitive']);
			await expect(store.assertAllowed('sql-sensitive')).rejects.toThrow('may buffer results on disk');
			expect(changes).toEqual([expect.objectContaining({
				connectionIds: ['sql-sensitive'],
				enabledConnectionIds: ['sql-sensitive'],
			})]);
			expect(output.warn).toHaveBeenCalledWith('[sql-lnt] Failed to mirror authoritative policy: mirror failed');
		} finally {
			store.dispose();
		}
	});

	it('quarantines malformed policy state and fails closed instead of trusting the legacy mirror', async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sql-lnt-corrupt-'));
		tempDirectories.push(directory);
		fs.writeFileSync(path.join(directory, 'sql-leave-no-trace-policy.v1.json'), '{broken', 'utf8');
		const context = createContext(directory);
		context._values.set(SQL_LEAVE_NO_TRACE_STORAGE_KEY, ['sql-sensitive']);
		const store = new SqlLeaveNoTracePolicyStore(context, createOutput());

		try {
			await expect(store.refresh()).resolves.toEqual([]);
			await expect(store.assertAllowed('sql-sensitive')).rejects.toThrow('may buffer results on disk');
			await expect(store.assertAllowed('sql-other')).rejects.toThrow('may buffer results on disk');
			expect(fs.readdirSync(directory).some(name => name.startsWith('sql-leave-no-trace-policy.v1.json.corrupt-'))).toBe(true);
		} finally {
			store.dispose();
		}
	});

	it('recovers the committed protected policy after mirror failure and later canonical corruption', async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sql-lnt-committed-recovery-'));
		tempDirectories.push(directory);
		const firstContext = createContext(directory);
		const first = new SqlLeaveNoTracePolicyStore(firstContext, createOutput());
		try {
			await first.refresh();
			firstContext.globalState.update.mockRejectedValue(new Error('mirror failed'));
			await first.setConnection('sql-sensitive', true);
			await expect(first.assertAllowed('sql-sensitive')).rejects.toThrow('may buffer results on disk');
		} finally {
			first.dispose();
		}

		fs.writeFileSync(path.join(directory, 'sql-leave-no-trace-policy.v1.json'), '{broken', 'utf8');
		const staleContext = createContext(directory);
		staleContext._values.set(SQL_LEAVE_NO_TRACE_STORAGE_KEY, []);
		const second = new SqlLeaveNoTracePolicyStore(staleContext, createOutput());
		try {
			await expect(second.refresh()).resolves.toEqual(['sql-sensitive']);
			await expect(second.assertAllowed('sql-sensitive')).rejects.toThrow('may buffer results on disk');
			expect(JSON.parse(fs.readFileSync(path.join(directory, 'sql-leave-no-trace-policy.v1.json'), 'utf8')).connectionIds)
				.toEqual(['sql-sensitive']);
		} finally {
			second.dispose();
		}
	});

	it('recovers the committed protected policy after the live canonical file disappears', async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sql-lnt-missing-recovery-'));
		tempDirectories.push(directory);
		const context = createContext(directory);
		const store = new SqlLeaveNoTracePolicyStore(context, createOutput());
		try {
			await store.refresh();
			await store.setConnection('sql-sensitive', true);
			context._values.set(SQL_LEAVE_NO_TRACE_STORAGE_KEY, []);
			fs.unlinkSync(path.join(directory, 'sql-leave-no-trace-policy.v1.json'));

			await expect(store.refresh()).resolves.toEqual(['sql-sensitive']);
			await expect(store.assertAllowed('sql-sensitive')).rejects.toThrow('may buffer results on disk');
			expect(JSON.parse(fs.readFileSync(path.join(directory, 'sql-leave-no-trace-policy.v1.json'), 'utf8')).connectionIds)
				.toEqual(['sql-sensitive']);
		} finally {
			store.dispose();
		}
	});

	it('fails closed after restart when all canonical policy artifacts disappear after migration', async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sql-lnt-total-loss-'));
		tempDirectories.push(directory);
		const firstContext = createContext(directory);
		const first = new SqlLeaveNoTracePolicyStore(firstContext, createOutput());
		try {
			await first.refresh();
			await first.setConnection('sql-sensitive', true);
		} finally {
			first.dispose();
		}
		for (const fileName of [
			'sql-leave-no-trace-policy.v1.json',
			'sql-leave-no-trace-policy.backup.v1.json',
			'sql-leave-no-trace-policy.commit.v1.json',
		]) fs.rmSync(path.join(directory, fileName), { force: true });

		const staleContext = createContext(directory);
		staleContext._values.set(SQL_LEAVE_NO_TRACE_STORAGE_KEY, []);
		const second = new SqlLeaveNoTracePolicyStore(staleContext, createOutput());
		try {
			await second.refresh();
			expect(second.isGloballyBlocked()).toBe(true);
			await expect(second.assertAllowed('sql-sensitive')).rejects.toThrow('may buffer results on disk');
			await expect(second.assertAllowed('sql-other')).rejects.toThrow('may buffer results on disk');
		} finally {
			second.dispose();
		}
	});

	it('fails closed after malformed policy state when no recovery mirror exists', async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sql-lnt-corrupt-closed-'));
		tempDirectories.push(directory);
		fs.writeFileSync(path.join(directory, 'sql-leave-no-trace-policy.v1.json'), '{broken', 'utf8');
		const store = new SqlLeaveNoTracePolicyStore(createContext(directory), createOutput());

		try {
			await store.refresh();
			await expect(store.assertAllowed('any-sql-connection')).rejects.toThrow('may buffer results on disk');
			expect(store.isGloballyBlocked()).toBe(true);
		} finally {
			store.dispose();
		}
	});

	it('emits a global block when all canonical artifacts disappear during a live session', async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sql-lnt-live-total-loss-'));
		tempDirectories.push(directory);
		const store = new SqlLeaveNoTracePolicyStore(createContext(directory), createOutput());
		const changes: any[] = [];
		store.onDidChange(change => changes.push(change));
		try {
			await store.refresh();
			for (const fileName of [
				'sql-leave-no-trace-policy.v1.json',
				'sql-leave-no-trace-policy.backup.v1.json',
				'sql-leave-no-trace-policy.commit.v1.json',
			]) fs.rmSync(path.join(directory, fileName), { force: true });

			await store.refresh();

			expect(store.isGloballyBlocked()).toBe(true);
			expect(changes).toContainEqual(expect.objectContaining({ globallyBlocked: true }));
		} finally {
			store.dispose();
		}
	});

	it.each(['{}', JSON.stringify({ schemaVersion: 1, version: 1, updatedAt: '' })])('persists fail-closed recovery across restart for structural corruption: %s', async contents => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sql-lnt-structural-'));
		tempDirectories.push(directory);
		fs.writeFileSync(path.join(directory, 'sql-leave-no-trace-policy.v1.json'), contents, 'utf8');
		const first = new SqlLeaveNoTracePolicyStore(createContext(directory), createOutput());
		try {
			await first.refresh();
			await expect(first.assertAllowed('sql-any')).rejects.toThrow('may buffer results on disk');
		} finally {
			first.dispose();
		}

		const second = new SqlLeaveNoTracePolicyStore(createContext(directory), createOutput());
		try {
			await second.refresh();
			await expect(second.assertAllowed('sql-any')).rejects.toThrow('may buffer results on disk');
			const persisted = JSON.parse(fs.readFileSync(path.join(directory, 'sql-leave-no-trace-policy.v1.json'), 'utf8'));
			expect(persisted.recoveryBlocked).toBe(true);
		} finally {
			second.dispose();
		}
	});
});
