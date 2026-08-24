import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConnectionManager } from '../../../src/host/connectionManager';
import { KustoLeaveNoTracePolicyStore } from '../../../src/host/kustoLeaveNoTracePolicyStore';
import { withSqlStateFileLock } from '../../../src/host/sql/sqlStateTransaction';

const disposables: Array<{ dispose(): void }> = [];
const tempDirectories: string[] = [];
const kustoPolicyWriteSequence = [
	'kusto-leave-no-trace-policy.backup.v1.json',
	'kusto-leave-no-trace-policy.v1.json',
	'kusto-leave-no-trace-policy.commit.v1.json',
	'kusto-leave-no-trace-policy-migrated.v1',
] as const;

async function removeKustoPolicyArtifacts(root: string): Promise<void> {
	for (const fileName of [
		'kusto-leave-no-trace-policy.v1.json',
		'kusto-leave-no-trace-policy.backup.v1.json',
		'kusto-leave-no-trace-policy.backup.v1.json.slot1',
		'kusto-leave-no-trace-policy.commit.v1.json',
	]) await fs.promises.rm(path.join(root, fileName), { force: true });
}

function context(root: string, initial: Record<string, unknown> = {}) {
	const values = new Map(Object.entries(initial));
	return {
		globalStorageUri: { fsPath: root },
		globalState: {
			get: <T>(key: string, fallback?: T) => values.has(key) ? values.get(key) as T : fallback,
			update: vi.fn(async (key: string, value: unknown) => {
				if (value === undefined) values.delete(key);
				else values.set(key, value);
			}),
		},
		subscriptions: [] as Array<{ dispose(): void }>,
	} as any;
}

function logger() {
	return { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn(), show: vi.fn() } as any;
}

async function sharedStores() {
	const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'kw-kusto-lnt-'));
	tempDirectories.push(root);
	const first = new KustoLeaveNoTracePolicyStore(context(root), logger());
	const second = new KustoLeaveNoTracePolicyStore(context(root), logger());
	disposables.push(first, second);
	await Promise.all([first.refresh(), second.refresh()]);
	return { first, second };
}

afterEach(async () => {
	const currentDisposables = disposables.splice(0);
	for (const disposable of currentDisposables) disposable.dispose();
	await Promise.all(currentDisposables.map(disposable => {
		if (disposable instanceof KustoLeaveNoTracePolicyStore) return disposable.waitForRefreshSettlement();
		if (disposable instanceof ConnectionManager) return disposable.waitForLeaveNoTraceRefreshSettlement();
		return Promise.resolve();
	}));
	for (const directory of tempDirectories.splice(0)) {
		await fs.promises.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
});

describe('KustoLeaveNoTracePolicyStore', () => {
	it('propagates a remote cluster generation without invalidating unrelated clusters', async () => {
		const { first, second } = await sharedStores();
		const changes: unknown[] = [];
		first.onDidChange(change => changes.push(change));

		await second.setCluster('https://cluster-a.kusto.windows.net', true);

		await vi.waitFor(() => expect(first.getRevocationGeneration('cluster-a')).toBe(1), { timeout: 5000 });
		expect(first.getRevocationGeneration('cluster-b')).toBe(0);
		expect(changes).toContainEqual(expect.objectContaining({
			enabledClusterKeys: ['cluster-a'], invalidatedClusterKeys: ['cluster-a'],
		}));
	});

	it('uses the shared lock to reject only a stale affected dispatch', async () => {
		const { first, second } = await sharedStores();
		const clusterA = await first.prepareDispatch('cluster-a', revision => revision);
		const clusterB = await first.prepareDispatch('cluster-b', revision => revision);

		await second.setCluster('cluster-b', true);

		await expect(first.admitRevision('cluster-a', clusterA.revocationGeneration, () => 'accepted'))
			.resolves.toEqual({ admitted: true, value: 'accepted' });
		await expect(first.admitRevision('cluster-b', clusterB.revocationGeneration, () => 'stale'))
			.resolves.toEqual({ admitted: false });
	});

	it('holds the shared lock through admitted publication mutation', async () => {
		const { first, second } = await sharedStores();
		const dispatch = await first.prepareDispatch('cluster-a', revision => revision);
		let remoteSettled = false;
		let mutationCompletedBeforeRemote = false;
		let remoteUpdate: Promise<void> | undefined;

		const admission = await first.admitRevision('cluster-a', dispatch.revocationGeneration, () => {
			remoteUpdate = second.setCluster('cluster-a', true).then(() => { remoteSettled = true; });
			mutationCompletedBeforeRemote = !remoteSettled;
			return 'published';
		});

		expect(admission).toEqual({ admitted: true, value: 'published' });
		expect(mutationCompletedBeforeRemote).toBe(true);
		await remoteUpdate;
		expect(remoteSettled).toBe(true);
	});

	it('holds the shared lock until asynchronous admitted publication settles', async () => {
		const { first, second } = await sharedStores();
		const dispatch = await first.prepareDispatch('cluster-a', revision => revision);
		let releasePublication!: () => void;
		const publication = new Promise<void>(resolve => { releasePublication = resolve; });
		let enteredAdmission!: () => void;
		const admissionEntered = new Promise<void>(resolve => { enteredAdmission = resolve; });
		let remoteSettled = false;

		const admission = first.admitRevision('cluster-a', dispatch.revocationGeneration, async () => {
			enteredAdmission();
			await publication;
			return 'published';
		});
		await admissionEntered;
		const remoteUpdate = second.setCluster('cluster-a', true).then(() => { remoteSettled = true; });
		await Promise.resolve();
		expect(remoteSettled).toBe(false);

		releasePublication();
		await expect(admission).resolves.toEqual({ admitted: true, value: 'published' });
		await remoteUpdate;
		expect(remoteSettled).toBe(true);
	});

	it('maps a remote policy change to matching connections in another manager', async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'kw-kusto-manager-lnt-'));
		tempDirectories.push(root);
		const initial = {
			'kusto.connections': [
				{ id: 'connection-a', name: 'A', clusterUrl: 'https://cluster-a.kusto.windows.net' },
				{ id: 'connection-b', name: 'B', clusterUrl: 'https://cluster-b.kusto.windows.net' },
			],
		};
		const first = new ConnectionManager(context(root, initial));
		const second = new ConnectionManager(context(root, initial));
		disposables.push(first, second);
		await Promise.all([first.refreshLeaveNoTracePolicy(), second.refreshLeaveNoTracePolicy()]);
		const changes: unknown[] = [];
		first.onDidChangeLeaveNoTrace(change => changes.push(change));

		await second.addLeaveNoTrace('cluster-a');

		await vi.waitFor(() => expect(changes).toContainEqual(expect.objectContaining({
			clusterUrl: 'cluster-a', enabled: true, connectionIds: ['connection-a'], revision: 1,
		})), { timeout: 5000 });
		expect(changes).not.toContainEqual(expect.objectContaining({ connectionIds: ['connection-b'] }));
	});

	it('fails closed after total committed-policy loss and stays blocked through ordinary edits', async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'kw-kusto-lnt-recovery-'));
		tempDirectories.push(root);
		const firstContext = context(root, { 'kusto.leaveNoTraceClusters': ['cluster-secret'] });
		const first = new KustoLeaveNoTracePolicyStore(firstContext, logger());
		disposables.push(first);
		await first.refresh();
		first.dispose();
		await first.waitForRefreshSettlement();
		disposables.splice(disposables.indexOf(first), 1);

		await removeKustoPolicyArtifacts(root);
		const restarted = new KustoLeaveNoTracePolicyStore(firstContext, logger());
		disposables.push(restarted);
		await restarted.refresh();

		expect(restarted.isGloballyBlocked()).toBe(true);
		await expect(restarted.admitRevision('cluster-public', 0, () => 'rows'))
			.resolves.toEqual({ admitted: false });

		await restarted.setCluster('cluster-public', true);
		expect(restarted.isGloballyBlocked()).toBe(true);
		await expect(restarted.admitRevision('cluster-public', restarted.getRevocationGeneration('cluster-public'), () => 'rows'))
			.resolves.toEqual({ admitted: false });
	});

	it('applies a lower-version recovery block to a live higher-version store', async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'kw-kusto-lnt-live-recovery-'));
		tempDirectories.push(root);
		const live = new KustoLeaveNoTracePolicyStore(context(root), logger());
		disposables.push(live);
		await live.refresh();
		await live.setCluster('cluster-a', true);
		await live.setCluster('cluster-a', false);
		await live.setCluster('cluster-a', true);

		const policyPath = path.join(root, 'kusto-leave-no-trace-policy.v1.json');
		fs.unwatchFile(policyPath, (live as any).watcherListener);
		await live.waitForRefreshSettlement();
		await removeKustoPolicyArtifacts(root);

		const recovering = new KustoLeaveNoTracePolicyStore(context(root), logger());
		disposables.push(recovering);
		await recovering.refresh();
		expect(recovering.isGloballyBlocked()).toBe(true);

		await live.refresh();
		expect(live.isGloballyBlocked()).toBe(true);
		await expect(live.admitRevision('cluster-a', live.getRevocationGeneration('cluster-a'), () => 'rows'))
			.resolves.toEqual({ admitted: false });
	});

	it('does not recreate policy files when a lock-waiting refresh resumes after disposal', async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'kw-kusto-lnt-disposed-refresh-'));
		tempDirectories.push(root);
		const store = new KustoLeaveNoTracePolicyStore(context(root), logger());
		let releaseLock!: () => void;
		let markLockHeld!: () => void;
		const lockHeld = new Promise<void>(resolve => { markLockHeld = resolve; });
		const lockGate = new Promise<void>(resolve => { releaseLock = resolve; });
		const lockTarget = path.join(root, 'kusto-leave-no-trace-policy.v1.json.write');
		const canonicalArtifacts = [
			'kusto-leave-no-trace-policy.v1.json',
			'kusto-leave-no-trace-policy.backup.v1.json',
			'kusto-leave-no-trace-policy.backup.v1.json.slot1',
			'kusto-leave-no-trace-policy.commit.v1.json',
		];
		let heldLock: Promise<void> | undefined;
		try {
			await store.refresh();
			await store.setCluster('cluster-a', true);
			await store.waitForRefreshSettlement();
			heldLock = withSqlStateFileLock(lockTarget, async () => {
				markLockHeld();
				await lockGate;
			});
			await lockHeld;
			const refreshOnce = vi.spyOn(store as any, 'refreshOnce');
			let refreshSettled = false;
			await fs.promises.utimes(
				path.join(root, 'kusto-leave-no-trace-policy.v1.json'),
				new Date(),
				new Date(Date.now() + 2_000),
			);
			await vi.waitFor(() => expect(refreshOnce).toHaveBeenCalled(), { timeout: 5000 });
			void (store as any).refreshTail.finally(() => { refreshSettled = true; });
			expect(refreshSettled).toBe(false);
			expect(fs.existsSync(`${lockTarget}.lock`)).toBe(true);
			store.dispose();
			for (const artifact of canonicalArtifacts) {
				await fs.promises.rm(path.join(root, artifact), { force: true });
			}
			expect(fs.existsSync(`${lockTarget}.lock`)).toBe(true);
			releaseLock();
			await heldLock;
			await store.waitForRefreshSettlement();

			for (const artifact of canonicalArtifacts) {
				expect(fs.existsSync(path.join(root, artifact))).toBe(false);
			}
		} finally {
			releaseLock?.();
			await Promise.allSettled([heldLock].filter(Boolean) as Promise<unknown>[]);
			store.dispose();
			await store.waitForRefreshSettlement();
		}
	});

	it('does not create policy files when lock-waiting initialization resumes after disposal', async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'kw-kusto-lnt-disposed-initialize-'));
		tempDirectories.push(root);
		const lockTarget = path.join(root, 'kusto-leave-no-trace-policy.v1.json.write');
		let releaseLock!: () => void;
		let markLockHeld!: () => void;
		const lockHeld = new Promise<void>(resolve => { markLockHeld = resolve; });
		const lockGate = new Promise<void>(resolve => { releaseLock = resolve; });
		const heldLock = withSqlStateFileLock(lockTarget, async () => {
			markLockHeld();
			await lockGate;
		});
		await lockHeld;
		const store = new KustoLeaveNoTracePolicyStore(context(root), logger());
		disposables.push(store);
		store.dispose();

		releaseLock();
		await heldLock;
		await store.refresh();
		await store.waitForRefreshSettlement();

		for (const fileName of kustoPolicyWriteSequence) {
			expect(fs.existsSync(path.join(root, fileName))).toBe(false);
		}
	});

	it('waits for an accepted lock-blocked mutation after disposal', async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'kw-kusto-lnt-disposed-mutation-'));
		tempDirectories.push(root);
		const store = new KustoLeaveNoTracePolicyStore(context(root), logger());
		disposables.push(store);
		await store.refresh();
		const lockTarget = path.join(root, 'kusto-leave-no-trace-policy.v1.json.write');
		let releaseLock!: () => void;
		let markLockHeld!: () => void;
		const lockHeld = new Promise<void>(resolve => { markLockHeld = resolve; });
		const lockGate = new Promise<void>(resolve => { releaseLock = resolve; });
		const heldLock = withSqlStateFileLock(lockTarget, async () => {
			markLockHeld();
			await lockGate;
		});
		await lockHeld;
		const mutation = store.setCluster('cluster-sensitive', true);
		await new Promise<void>(resolve => setImmediate(resolve));
		store.dispose();
		let settled = false;
		const settlement = store.waitForRefreshSettlement().finally(() => { settled = true; });
		await new Promise<void>(resolve => setImmediate(resolve));
		expect(settled).toBe(false);

		releaseLock();
		await Promise.all([heldLock, mutation, settlement]);

		const persisted = JSON.parse(await fs.promises.readFile(
			path.join(root, 'kusto-leave-no-trace-policy.v1.json'),
			'utf8',
		));
		expect(persisted.clusterKeys).toEqual(['cluster-sensitive']);
	});

	it.each(kustoPolicyWriteSequence)(
		'stops initialization after the %s transaction mutation when disposed',
		async stopAfter => {
			const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'kw-kusto-lnt-disposed-transaction-'));
			tempDirectories.push(root);
			const renamedFiles: string[] = [];
			const realRename = fs.promises.rename.bind(fs.promises);
			let store: KustoLeaveNoTracePolicyStore | undefined;
			const renameSpy = vi.spyOn(fs.promises, 'rename').mockImplementation(async (oldPath, newPath) => {
				await realRename(oldPath, newPath);
				const fileName = path.basename(String(newPath));
				if (!kustoPolicyWriteSequence.includes(fileName as typeof kustoPolicyWriteSequence[number])) return;
				renamedFiles.push(fileName);
				if (fileName === stopAfter) store?.dispose();
			});
			try {
				store = new KustoLeaveNoTracePolicyStore(context(root), logger());
				disposables.push(store);
				await store.refresh();
				await store.waitForRefreshSettlement();

				const stopIndex = kustoPolicyWriteSequence.indexOf(stopAfter);
				expect(renamedFiles).toEqual(kustoPolicyWriteSequence.slice(0, stopIndex + 1));
				expect((store as any).snapshot.version).toBe(0);
				expect(fs.existsSync(path.join(root, stopAfter))).toBe(true);
				for (const fileName of kustoPolicyWriteSequence.slice(stopIndex + 1)) {
					expect(fs.existsSync(path.join(root, fileName))).toBe(false);
				}
			} finally {
				renameSpy.mockRestore();
				store?.dispose();
			}
		},
	);

	it('keeps a same-path policy observer active when a peer store is disposed', async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'kw-kusto-lnt-watcher-owner-'));
		tempDirectories.push(root);
		const writer = new KustoLeaveNoTracePolicyStore(context(root), logger());
		const disposedPeer = new KustoLeaveNoTracePolicyStore(context(root), logger());
		const survivor = new KustoLeaveNoTracePolicyStore(context(root), logger());
		disposables.push(writer, disposedPeer, survivor);
		await Promise.all([writer.refresh(), disposedPeer.refresh(), survivor.refresh()]);

		disposedPeer.dispose();
		await disposedPeer.waitForRefreshSettlement();
		await writer.setCluster('cluster-sensitive', true);

		await vi.waitFor(() => expect(survivor.isProtected('cluster-sensitive')).toBe(true), { timeout: 5000 });
	});

	it('marks every current manager connection protected while recovery is globally blocked', async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'kw-kusto-manager-recovery-'));
		tempDirectories.push(root);
		const managerContext = context(root, {
			'kusto.connections': [
				{ id: 'connection-a', name: 'A', clusterUrl: 'https://cluster-a.kusto.windows.net' },
				{ id: 'connection-b', name: 'B', clusterUrl: 'https://cluster-b.kusto.windows.net' },
			],
		});
		const manager = new ConnectionManager(managerContext);
		disposables.push(manager);
		await manager.refreshLeaveNoTracePolicy();
		manager.dispose();
		await manager.waitForLeaveNoTraceRefreshSettlement();
		disposables.splice(disposables.indexOf(manager), 1);
		await removeKustoPolicyArtifacts(root);
		const restarted = new ConnectionManager(managerContext);
		disposables.push(restarted);
		await restarted.refreshLeaveNoTracePolicy();

		expect(restarted.isLeaveNoTraceRecoveryBlocked()).toBe(true);
		expect(restarted.getLeaveNoTraceClusters()).toEqual(['cluster-a', 'cluster-b']);
	});
});