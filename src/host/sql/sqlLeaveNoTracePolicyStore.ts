import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { WorkbenchLogger } from '../workbenchLogger';
import { quarantineCorruptSqlStateFile } from './sqlStateFile';
import { startSqlDispatch, unwrapSqlDispatch, type SqlDispatchHandle } from './sqlDispatch';
import {
	atomicReplaceSqlStateFile,
	readCommittedSqlStateBackup,
	readRecoverableSqlStateSnapshot,
	type SqlStateLockOptions,
	withSqlStateFileLock,
	writeRecoverableSqlStateSnapshot,
} from './sqlStateTransaction';
import {
	getSqlLeaveNoTraceConnectionIds,
	SQL_LEAVE_NO_TRACE_STORAGE_KEY,
	SqlLeaveNoTraceBlockedError,
	SqlLeaveNoTracePolicyChangedError,
	type SqlLeaveNoTracePolicy,
} from './sqlLeaveNoTrace';

const POLICY_SCHEMA_VERSION = 1;
const POLICY_FILENAME = 'sql-leave-no-trace-policy.v1.json';
const POLICY_BACKUP_FILENAME = 'sql-leave-no-trace-policy.backup.v1.json';
const POLICY_COMMIT_FILENAME = 'sql-leave-no-trace-policy.commit.v1.json';
const POLICY_MIGRATION_FILENAME = 'sql-leave-no-trace-policy-migrated.v1';
const POLICY_LOCK_STALE_MS = 30_000;

class SqlPolicyLifecycleCanceledError extends Error {}

function isSqlPolicyLifecycleCanceled(error: unknown): boolean {
	return error instanceof SqlPolicyLifecycleCanceledError
		|| (error instanceof Error && error.cause instanceof SqlPolicyLifecycleCanceledError);
}

type PolicySnapshot = {
	schemaVersion: typeof POLICY_SCHEMA_VERSION;
	version: number;
	connectionIds: string[];
	revocationGenerations: Record<string, number>;
	updatedAt: string;
	recoveryBlocked: boolean;
};

type PolicyReadResult =
	| { kind: 'missing' }
	| { kind: 'valid'; snapshot: PolicySnapshot }
	| { kind: 'corrupt' };

export interface SqlLeaveNoTracePolicyChange {
	connectionIds: string[];
	enabledConnectionIds: string[];
	disabledConnectionIds: string[];
	invalidatedConnectionIds: string[];
	version: number;
	globallyBlocked: boolean;
}

function normalizeIds(value: unknown): string[] {
	return Array.isArray(value)
		? [...new Set(value.map(id => String(id || '').trim()).filter(Boolean))].sort()
		: [];
}

function parseRevocationGenerations(value: unknown, protectedIds: readonly string[]): Record<string, number> | undefined {
	const result: Record<string, number> = {};
	if (value !== undefined) {
		if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
		for (const [connectionId, generation] of Object.entries(value as Record<string, unknown>)) {
			const id = String(connectionId || '').trim();
			if (!id || typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation <= 0) return undefined;
			result[id] = generation;
		}
	}
	for (const id of protectedIds) {
		if (!result[id]) result[id] = 1;
	}
	return result;
}

function parseSnapshot(value: unknown): PolicySnapshot | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
	const record = value as Partial<PolicySnapshot>;
	if (record.schemaVersion !== POLICY_SCHEMA_VERSION
		|| !Number.isSafeInteger(record.version) || Number(record.version) < 0
		|| !Array.isArray(record.connectionIds)
		|| record.connectionIds.some(id => typeof id !== 'string' || !id.trim())
		|| (record.updatedAt !== undefined && typeof record.updatedAt !== 'string')
		|| (record.recoveryBlocked !== undefined && typeof record.recoveryBlocked !== 'boolean')) return undefined;
	const connectionIds = normalizeIds(record.connectionIds);
	const revocationGenerations = parseRevocationGenerations(record.revocationGenerations, connectionIds);
	if (!revocationGenerations) return undefined;
	return {
		schemaVersion: POLICY_SCHEMA_VERSION,
		version: Number(record.version),
		connectionIds,
		revocationGenerations,
		updatedAt: record.updatedAt ?? '',
		recoveryBlocked: record.recoveryBlocked === true,
	};
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

export class SqlLeaveNoTracePolicyStore implements SqlLeaveNoTracePolicy, vscode.Disposable {
	private readonly changeEmitter = new vscode.EventEmitter<SqlLeaveNoTracePolicyChange>();
	readonly onDidChange = this.changeEmitter.event;
	private readonly policyPath: string | undefined;
	private readonly backupPath: string | undefined;
	private readonly commitPath: string | undefined;
	private readonly migrationPath: string | undefined;
	private readonly lockTarget: string | undefined;
	private readonly watcherListener: ((current: fs.Stats, previous: fs.Stats) => void) | undefined;
	private snapshot: PolicySnapshot;
	private readonly readyPromise: Promise<void>;
	private refreshTail: Promise<void> = Promise.resolve();
	private mutationTail: Promise<void> = Promise.resolve();
	private recoveryBlocked = false;
	private disposed = false;

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly output: WorkbenchLogger,
	) {
		const legacyIds = getSqlLeaveNoTraceConnectionIds(context);
		this.snapshot = {
			schemaVersion: POLICY_SCHEMA_VERSION,
			version: 0,
			connectionIds: legacyIds,
			revocationGenerations: Object.fromEntries(legacyIds.map(id => [id, 1])),
			updatedAt: '',
			recoveryBlocked: false,
		};
		const globalStoragePath = String(context.globalStorageUri?.fsPath || '').trim();
		this.policyPath = globalStoragePath ? path.join(globalStoragePath, POLICY_FILENAME) : undefined;
		this.backupPath = globalStoragePath ? path.join(globalStoragePath, POLICY_BACKUP_FILENAME) : undefined;
		this.commitPath = globalStoragePath ? path.join(globalStoragePath, POLICY_COMMIT_FILENAME) : undefined;
		this.migrationPath = globalStoragePath ? path.join(globalStoragePath, POLICY_MIGRATION_FILENAME) : undefined;
		this.lockTarget = this.policyPath ? `${this.policyPath}.write` : undefined;
		this.readyPromise = this.initialize();
		if (this.policyPath) {
			this.watcherListener = () => {
				if (this.disposed) return;
				void this.refresh().catch(error => {
					this.output.warn(`[sql-lnt] Failed to refresh shared policy: ${error instanceof Error ? error.message : String(error)}`);
				});
			};
			fs.watchFile(this.policyPath, { interval: 250, persistent: false }, this.watcherListener);
		}
	}

	getConnectionIds(): string[] {
		return [...this.snapshot.connectionIds];
	}

	getFilePath(): string | undefined {
		return this.policyPath;
	}

	getRevocationGeneration(connectionId: string): number {
		return this.snapshot.revocationGenerations[String(connectionId || '').trim()] ?? 0;
	}

	getVersion(): number {
		return this.snapshot.version;
	}

	isGloballyBlocked(): boolean {
		return this.recoveryBlocked;
	}

	isProtected(connectionId: string): boolean {
		return this.recoveryBlocked || this.snapshot.connectionIds.includes(String(connectionId || '').trim());
	}

	async assertAllowed(connectionId: string): Promise<void> {
		await this.refresh();
		if (this.isProtected(connectionId)) throw new SqlLeaveNoTraceBlockedError();
	}

	async assertProtectionMode(connectionId: string, expectedProtected: boolean, expectedRevocationGeneration: number): Promise<void> {
		await this.refresh();
		if (this.isProtected(connectionId) !== expectedProtected
			|| this.getRevocationGeneration(connectionId) !== expectedRevocationGeneration) {
			throw new SqlLeaveNoTracePolicyChangedError();
		}
	}

	async dispatchProtectionMode<T>(
		connectionId: string,
		expectedProtected: boolean,
		expectedRevocationGeneration: number,
		dispatch: () => T | PromiseLike<T>,
	): Promise<T> {
		return unwrapSqlDispatch(await this.prepareDispatchProtectionMode(
			connectionId,
			expectedProtected,
			expectedRevocationGeneration,
			async () => startSqlDispatch(dispatch),
		));
	}

	async prepareDispatchProtectionMode<T>(
		connectionId: string,
		expectedProtected: boolean,
		expectedRevocationGeneration: number,
		prepare: () => Promise<SqlDispatchHandle<T>>,
	): Promise<SqlDispatchHandle<T>> {
		const id = String(connectionId || '').trim();
		await this.readyPromise;
		if (!this.policyPath || !this.lockTarget) {
			if (this.isProtected(id) !== expectedProtected
				|| this.getRevocationGeneration(id) !== expectedRevocationGeneration) {
				throw new SqlLeaveNoTracePolicyChangedError();
			}
			return prepare();
		}
		return withSqlStateFileLock(this.lockTarget, async () => {
			const read = await this.readSnapshot();
			const protectedNow = read.kind !== 'valid'
				|| read.snapshot.recoveryBlocked
				|| read.snapshot.connectionIds.includes(id);
			const generation = read.kind === 'valid' ? (read.snapshot.revocationGenerations[id] ?? 0) : -1;
			if (protectedNow !== expectedProtected || generation !== expectedRevocationGeneration) {
				throw new SqlLeaveNoTracePolicyChangedError();
			}
			return prepare();
		}, { staleMs: POLICY_LOCK_STALE_MS });
	}

	async dispatchAllowed<T>(connectionId: string, dispatch: () => T | PromiseLike<T>, expectedRevocationGeneration?: number): Promise<T> {
		return unwrapSqlDispatch(await this.prepareDispatchAllowed(connectionId, async () => startSqlDispatch(dispatch), expectedRevocationGeneration));
	}

	async prepareDispatchAllowed<T>(
		connectionId: string,
		prepare: () => Promise<SqlDispatchHandle<T>>,
		expectedRevocationGeneration?: number,
	): Promise<SqlDispatchHandle<T>> {
		const id = String(connectionId || '').trim();
		await this.readyPromise;
		if (!this.policyPath || !this.lockTarget) {
			if (this.isProtected(id)) throw new SqlLeaveNoTraceBlockedError();
			if (expectedRevocationGeneration !== undefined
				&& this.getRevocationGeneration(id) !== expectedRevocationGeneration) throw new SqlLeaveNoTraceBlockedError();
			return await prepare();
		}
		return withSqlStateFileLock(this.lockTarget, async () => {
			const read = await this.readSnapshot();
			if (read.kind !== 'valid'
				|| read.snapshot.recoveryBlocked
				|| read.snapshot.connectionIds.includes(id)
				|| (expectedRevocationGeneration !== undefined
					&& (read.snapshot.revocationGenerations[id] ?? 0) !== expectedRevocationGeneration)) {
				throw new SqlLeaveNoTraceBlockedError();
			}
			return await prepare();
		}, { staleMs: POLICY_LOCK_STALE_MS });
	}

	async dispatchSnapshot<T>(dispatch: (snapshot: {
		connectionIds: readonly string[];
		version: number;
		globallyBlocked: boolean;
		revocationGenerations: Readonly<Record<string, number>>;
	}) => T | PromiseLike<T>): Promise<T> {
		return unwrapSqlDispatch(await this.prepareSnapshotDispatch(async snapshot => startSqlDispatch(() => dispatch(snapshot))));
	}

	async runWithSnapshotLock<T>(run: (snapshot: {
		connectionIds: readonly string[];
		version: number;
		globallyBlocked: boolean;
		revocationGenerations: Readonly<Record<string, number>>;
	}) => Promise<T>, lockOptions: SqlStateLockOptions = {}): Promise<T> {
		await this.readyPromise;
		if (!this.policyPath || !this.lockTarget) {
			return run({
				connectionIds: this.getConnectionIds(),
				version: this.snapshot.version,
				globallyBlocked: this.recoveryBlocked,
				revocationGenerations: { ...this.snapshot.revocationGenerations },
			});
		}
		return withSqlStateFileLock(this.lockTarget, async () => {
			const read = await this.readSnapshot();
			return await run(read.kind === 'valid'
				? {
					connectionIds: read.snapshot.connectionIds,
					version: read.snapshot.version,
					globallyBlocked: read.snapshot.recoveryBlocked,
					revocationGenerations: { ...read.snapshot.revocationGenerations },
				}
				: {
					connectionIds: [], version: this.snapshot.version, globallyBlocked: true,
					revocationGenerations: { ...this.snapshot.revocationGenerations },
				});
		}, { staleMs: POLICY_LOCK_STALE_MS, ...lockOptions });
	}

	async prepareSnapshotDispatch<T>(prepare: (snapshot: {
		connectionIds: readonly string[];
		version: number;
		globallyBlocked: boolean;
		revocationGenerations: Readonly<Record<string, number>>;
	}) => Promise<SqlDispatchHandle<T>>, lockOptions: SqlStateLockOptions = {}): Promise<SqlDispatchHandle<T>> {
		await this.readyPromise;
		if (!this.policyPath || !this.lockTarget) {
			return await prepare({
				connectionIds: this.getConnectionIds(),
				version: this.snapshot.version,
				globallyBlocked: this.recoveryBlocked,
				revocationGenerations: { ...this.snapshot.revocationGenerations },
			});
		}
		return withSqlStateFileLock(this.lockTarget, async () => {
			const read = await this.readSnapshot();
			const canonical = read.kind === 'valid'
				? {
					connectionIds: read.snapshot.connectionIds,
					version: read.snapshot.version,
					globallyBlocked: read.snapshot.recoveryBlocked,
					revocationGenerations: { ...read.snapshot.revocationGenerations },
				}
				: {
					connectionIds: [] as string[], version: this.snapshot.version, globallyBlocked: true,
					revocationGenerations: { ...this.snapshot.revocationGenerations },
				};
			return await prepare(canonical);
		}, { staleMs: POLICY_LOCK_STALE_MS, ...lockOptions });
	}

	async awaitSnapshotLockReady(): Promise<void> {
		await this.readyPromise;
		if (!this.lockTarget) return;
		await withSqlStateFileLock(this.lockTarget, async () => undefined, {
			staleMs: POLICY_LOCK_STALE_MS,
			retryUntilStale: true,
		});
	}

	async refresh(): Promise<string[]> {
		const run = this.refreshTail.catch(() => undefined).then(() => this.refreshOnce());
		this.refreshTail = run.then(() => undefined, () => undefined);
		await run;
		return this.getConnectionIds();
	}

	async waitForRefreshSettlement(): Promise<void> {
		await this.readyPromise.catch(() => undefined);
		for (;;) {
			const refreshTail = this.refreshTail;
			const mutationTail = this.mutationTail;
			await Promise.all([refreshTail, mutationTail]);
			if (refreshTail === this.refreshTail && mutationTail === this.mutationTail) return;
		}
	}

	async setConnection(connectionId: string, enabled: boolean): Promise<void> {
		const id = String(connectionId || '').trim();
		if (!id || this.disposed) return;
		const mutation = (async () => {
			await this.readyPromise;
			if (!this.policyPath || !this.lockTarget) {
				const ids = enabled
					? normalizeIds([...this.snapshot.connectionIds, id])
					: this.snapshot.connectionIds.filter(candidate => candidate !== id);
				await this.applySnapshot({
					schemaVersion: POLICY_SCHEMA_VERSION,
					version: this.snapshot.version + 1,
					connectionIds: ids,
					revocationGenerations: enabled && !this.snapshot.connectionIds.includes(id)
						? { ...this.snapshot.revocationGenerations, [id]: (this.snapshot.revocationGenerations[id] ?? 0) + 1 }
						: { ...this.snapshot.revocationGenerations },
					updatedAt: new Date().toISOString(),
					recoveryBlocked: this.snapshot.recoveryBlocked,
				});
				return;
			}

			await fs.promises.mkdir(path.dirname(this.policyPath), { recursive: true });
			const next = await withSqlStateFileLock(this.lockTarget, async () => {
				const read = await this.readSnapshot();
				const current = read.kind === 'valid'
					? read.snapshot
					: read.kind === 'corrupt'
						? await this.recoverCorruptPolicyUnderLock()
						: await this.recoverMissingPolicyUnderLock();
				const ids = enabled
					? normalizeIds([...current.connectionIds, id])
					: current.connectionIds.filter(candidate => candidate !== id);
				if (sameIds(ids, current.connectionIds)) {
					return current;
				}
				const updated: PolicySnapshot = {
					schemaVersion: POLICY_SCHEMA_VERSION,
					version: current.version + 1,
					connectionIds: ids,
					revocationGenerations: enabled && !current.connectionIds.includes(id)
						? { ...current.revocationGenerations, [id]: (current.revocationGenerations[id] ?? 0) + 1 }
						: { ...current.revocationGenerations },
					updatedAt: new Date().toISOString(),
					recoveryBlocked: current.recoveryBlocked,
				};
				await this.writeSnapshot(updated);
				return updated;
			}, { staleMs: POLICY_LOCK_STALE_MS, retryUntilStale: true });
			await this.applySnapshot(next);
		})();
		this.trackMutation(mutation);
		await mutation;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		if (this.policyPath && this.watcherListener) fs.unwatchFile(this.policyPath, this.watcherListener);
		this.changeEmitter.dispose();
	}

	private async refreshOnce(): Promise<void> {
		await this.readyPromise;
		if (this.disposed || !this.policyPath || !this.lockTarget) return;
		await withSqlStateFileLock(this.lockTarget, async () => {
			if (this.disposed) return;
			const current = () => !this.disposed;
			const read = await this.readSnapshot(false, current);
			if (!read || this.disposed) return;
			const snapshot = read.kind === 'valid'
				? read.snapshot
				: read.kind === 'corrupt'
					? await this.recoverCorruptPolicyUnderLock(current)
					: await this.recoverMissingPolicyUnderLock(false, current);
			if (snapshot && !this.disposed) await this.applySnapshot(snapshot);
		}, { staleMs: POLICY_LOCK_STALE_MS });
	}

	private trackMutation(mutation: Promise<void>): void {
		const previous = this.mutationTail;
		this.mutationTail = Promise.allSettled([previous, mutation]).then(() => undefined);
	}

	private async initialize(): Promise<void> {
		if (this.disposed || !this.policyPath || !this.lockTarget) return;
		await fs.promises.mkdir(path.dirname(this.policyPath), { recursive: true });
		if (this.disposed) return;
		await withSqlStateFileLock(this.lockTarget, async () => {
			if (this.disposed) return;
			const current = () => !this.disposed;
			const allowLegacyPrimary = !!this.migrationPath && !fs.existsSync(this.migrationPath);
			const read = await this.readSnapshot(allowLegacyPrimary, current);
			if (!read || this.disposed) return;
			if (read.kind === 'valid') {
				if (!await this.writeSnapshot(read.snapshot, current)) return;
				if (!this.disposed) await this.applySnapshot(read.snapshot, false);
				return;
			}
			const snapshot = read.kind === 'corrupt'
				? await this.recoverCorruptPolicyUnderLock(current)
				: await this.recoverMissingPolicyUnderLock(true, current);
			if (snapshot && !this.disposed) await this.applySnapshot(snapshot, false);
		}, { staleMs: POLICY_LOCK_STALE_MS, retryUntilStale: true });
	}

	private async readSnapshot(allowUncommittedPrimary?: boolean): Promise<PolicyReadResult>;
	private async readSnapshot(allowUncommittedPrimary: boolean, isCurrent: () => boolean): Promise<PolicyReadResult | undefined>;
	private async readSnapshot(
		allowUncommittedPrimary = false,
		isCurrent: () => boolean = () => true,
	): Promise<PolicyReadResult | undefined> {
		if (!isCurrent()) return undefined;
		if (!this.policyPath) return { kind: 'missing' };
		if (!this.backupPath || !this.commitPath) return { kind: 'corrupt' };
		const read = await readRecoverableSqlStateSnapshot({
			primaryPath: this.policyPath,
			backupPath: this.backupPath,
			commitPath: this.commitPath,
			parseSnapshot,
			getIdentity: snapshot => ({ schemaVersion: snapshot.schemaVersion, version: snapshot.version }),
			allowUncommittedPrimary,
		});
		if (!isCurrent()) return undefined;
		if (read.kind === 'valid' && read.source === 'backup') {
			try {
				if (read.primaryState === 'invalid') {
					if (!isCurrent()) return undefined;
					await quarantineCorruptSqlStateFile(this.policyPath);
				}
				await this.writeAtomic(this.policyPath, read.text, isCurrent);
			} catch (error) {
				if (isSqlPolicyLifecycleCanceled(error)) return undefined;
				throw error;
			}
		}
		return read.kind === 'valid'
			? { kind: 'valid', snapshot: read.value }
			: read.kind === 'missing' ? { kind: 'missing' } : { kind: 'corrupt' };
	}

	private async recoverCorruptPolicy(): Promise<PolicySnapshot> {
		if (!this.policyPath || !this.lockTarget) return this.snapshot;
		return withSqlStateFileLock(this.lockTarget, async () => {
			const read = await this.readSnapshot();
			return read.kind === 'valid' ? read.snapshot : this.recoverCorruptPolicyUnderLock();
		}, { staleMs: POLICY_LOCK_STALE_MS });
	}

	private async recoverMissingPolicy(): Promise<PolicySnapshot> {
		if (!this.policyPath || !this.lockTarget) return this.snapshot;
		return withSqlStateFileLock(this.lockTarget, async () => {
			const read = await this.readSnapshot();
			if (read.kind === 'valid') return read.snapshot;
			if (read.kind === 'corrupt') return this.recoverCorruptPolicyUnderLock();
			return this.recoverMissingPolicyUnderLock(false);
		}, { staleMs: POLICY_LOCK_STALE_MS });
	}

	private async recoverCorruptPolicyUnderLock(): Promise<PolicySnapshot>;
	private async recoverCorruptPolicyUnderLock(isCurrent: () => boolean): Promise<PolicySnapshot | undefined>;
	private async recoverCorruptPolicyUnderLock(isCurrent: () => boolean = () => true): Promise<PolicySnapshot | undefined> {
		if (!isCurrent()) return undefined;
		if (this.policyPath) await quarantineCorruptSqlStateFile(this.policyPath);
		const committed = await this.readCommittedBackup();
		if (!isCurrent()) return undefined;
		const recovered: PolicySnapshot = committed ?? {
			schemaVersion: POLICY_SCHEMA_VERSION,
			version: Math.max(Date.now(), this.snapshot.version + 1),
			connectionIds: [],
			revocationGenerations: { ...this.snapshot.revocationGenerations },
			updatedAt: new Date().toISOString(),
			recoveryBlocked: true,
		};
		if (!await this.writeSnapshot(recovered, isCurrent)) return undefined;
		this.recoveryBlocked = recovered.recoveryBlocked;
		this.output.warn(committed
			? '[sql-lnt] Quarantined a malformed shared policy file and restored its committed redundant snapshot.'
			: '[sql-lnt] Quarantined a malformed shared policy file. SQL access remains blocked because no committed redundant snapshot was available.');
		return recovered;
	}

	private async recoverMissingPolicyUnderLock(allowLegacyMigration?: boolean): Promise<PolicySnapshot>;
	private async recoverMissingPolicyUnderLock(
		allowLegacyMigration: boolean,
		isCurrent: () => boolean,
	): Promise<PolicySnapshot | undefined>;
	private async recoverMissingPolicyUnderLock(
		allowLegacyMigration = false,
		isCurrent: () => boolean = () => true,
	): Promise<PolicySnapshot | undefined> {
		if (!isCurrent()) return undefined;
		const committed = await this.readCommittedBackup();
		if (!isCurrent()) return undefined;
		if (committed) {
			if (!await this.writeSnapshot(committed, isCurrent)) return undefined;
			return committed;
		}
		const migrationCompleted = !!this.migrationPath && fs.existsSync(this.migrationPath);
		const mayMigrateLegacy = allowLegacyMigration && !migrationCompleted;
		const rawLegacy = mayMigrateLegacy
			? this.context.globalState.get<unknown>(SQL_LEAVE_NO_TRACE_STORAGE_KEY)
			: undefined;
		const recoveredConnectionIds = Array.isArray(rawLegacy) ? normalizeIds(rawLegacy) : [];
		const recovered: PolicySnapshot = {
			schemaVersion: POLICY_SCHEMA_VERSION,
			version: Math.max(1, this.snapshot.version + 1),
			connectionIds: recoveredConnectionIds,
			revocationGenerations: mayMigrateLegacy
				? Object.fromEntries(recoveredConnectionIds.map(id => [id, 1]))
				: { ...this.snapshot.revocationGenerations },
			updatedAt: new Date().toISOString(),
			recoveryBlocked: !mayMigrateLegacy,
		};
		if (!await this.writeSnapshot(recovered, isCurrent)) return undefined;
		return recovered;
	}

	private async readCommittedBackup(): Promise<PolicySnapshot | undefined> {
		if (!this.backupPath || !this.commitPath) return undefined;
		return readCommittedSqlStateBackup({
			backupPath: this.backupPath,
			commitPath: this.commitPath,
			parseSnapshot,
			getIdentity: snapshot => ({ schemaVersion: snapshot.schemaVersion, version: snapshot.version }),
		});
	}

	private async writeSnapshot(snapshot: PolicySnapshot, isCurrent: () => boolean = () => true): Promise<boolean> {
		if (!this.policyPath || !this.backupPath || !this.commitPath || !this.migrationPath || !isCurrent()) return false;
		const snapshotText = `${JSON.stringify(snapshot, null, 2)}\n`;
		try {
			await writeRecoverableSqlStateSnapshot({
				primaryPath: this.policyPath,
				backupPath: this.backupPath,
				commitPath: this.commitPath,
				migrationPath: this.migrationPath,
				text: snapshotText,
				identity: { schemaVersion: snapshot.schemaVersion, version: snapshot.version },
				writeAtomic: (filePath, contents) => this.writeAtomic(filePath, contents, isCurrent),
				removeFile: async filePath => {
					if (!isCurrent()) throw new SqlPolicyLifecycleCanceledError();
					await fs.promises.rm(filePath, { force: true });
				},
			});
			return isCurrent();
		} catch (error) {
			if (isSqlPolicyLifecycleCanceled(error)) return false;
			throw error;
		}
	}

	private async writeAtomic(filePath: string, contents: string, isCurrent: () => boolean = () => true): Promise<void> {
		if (!isCurrent()) throw new SqlPolicyLifecycleCanceledError();
		await atomicReplaceSqlStateFile(filePath, contents, {
			assertCurrent: () => {
				if (!isCurrent()) throw new SqlPolicyLifecycleCanceledError();
			},
		});
	}

	private async applySnapshot(snapshot: PolicySnapshot, emit: boolean = true): Promise<void> {
		if (this.disposed) return;
		const previous = this.snapshot;
		if (snapshot.version < previous.version || (snapshot.version === previous.version
			&& sameIds(snapshot.connectionIds, previous.connectionIds)
			&& snapshot.recoveryBlocked === previous.recoveryBlocked)) return;
		this.snapshot = snapshot;
		this.recoveryBlocked = snapshot.recoveryBlocked;
		if (!snapshot.recoveryBlocked) {
			try {
				await this.context.globalState.update(SQL_LEAVE_NO_TRACE_STORAGE_KEY, snapshot.connectionIds);
			} catch (error) {
				this.output.warn(`[sql-lnt] Failed to mirror authoritative policy: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		if (!emit || this.disposed) return;
		const before = new Set(previous.connectionIds);
		const after = new Set(snapshot.connectionIds);
		const invalidatedConnectionIds = Object.entries(snapshot.revocationGenerations)
			.filter(([connectionId, generation]) => generation > (previous.revocationGenerations[connectionId] ?? 0))
			.map(([connectionId]) => connectionId);
		this.changeEmitter.fire({
			connectionIds: [...snapshot.connectionIds],
			enabledConnectionIds: snapshot.connectionIds.filter(id => !before.has(id)),
			disabledConnectionIds: previous.connectionIds.filter(id => !after.has(id)),
			invalidatedConnectionIds,
			version: snapshot.version,
			globallyBlocked: snapshot.recoveryBlocked,
		});
	}
}
