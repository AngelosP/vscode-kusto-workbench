import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as lockfile from 'proper-lockfile';
import * as vscode from 'vscode';
import type { WorkbenchLogger } from '../workbenchLogger';
import { quarantineCorruptSqlStateFile } from './sqlStateFile';
import { startSqlDispatch, unwrapSqlDispatch, type SqlDispatchHandle } from './sqlDispatch';
import {
	getSqlLeaveNoTraceConnectionIds,
	SQL_LEAVE_NO_TRACE_STORAGE_KEY,
	SqlLeaveNoTraceBlockedError,
	type SqlLeaveNoTracePolicy,
} from './sqlLeaveNoTrace';

const POLICY_SCHEMA_VERSION = 1;
const POLICY_FILENAME = 'sql-leave-no-trace-policy.v1.json';
const POLICY_BACKUP_FILENAME = 'sql-leave-no-trace-policy.backup.v1.json';
const POLICY_COMMIT_FILENAME = 'sql-leave-no-trace-policy.commit.v1.json';
const POLICY_MIGRATION_FILENAME = 'sql-leave-no-trace-policy-migrated.v1';
const POLICY_LOCK_STALE_MS = 30_000;
const ATOMIC_RENAME_RETRY_DELAYS_MS = [10, 25, 50, 100, 200] as const;

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

type PolicyCommit = {
	schemaVersion: typeof POLICY_SCHEMA_VERSION;
	version: number;
	sha256: string;
};

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

function normalizeRevocationGenerations(value: unknown, protectedIds: readonly string[]): Record<string, number> {
	const result: Record<string, number> = {};
	if (value && typeof value === 'object' && !Array.isArray(value)) {
		for (const [connectionId, generation] of Object.entries(value as Record<string, unknown>)) {
			const id = String(connectionId || '').trim();
			const parsed = Number(generation);
			if (id && Number.isSafeInteger(parsed) && parsed > 0) result[id] = parsed;
		}
	}
	for (const id of protectedIds) {
		if (!result[id]) result[id] = 1;
	}
	return result;
}

function parseSnapshot(value: unknown): PolicySnapshot | undefined {
	if (!value || typeof value !== 'object') return undefined;
	const record = value as Partial<PolicySnapshot>;
	if (record.schemaVersion !== POLICY_SCHEMA_VERSION
		|| !Number.isSafeInteger(record.version) || Number(record.version) < 0
		|| !Array.isArray(record.connectionIds)
		|| (record.recoveryBlocked !== undefined && typeof record.recoveryBlocked !== 'boolean')) return undefined;
	const connectionIds = normalizeIds(record.connectionIds);
	return {
		schemaVersion: POLICY_SCHEMA_VERSION,
		version: Number(record.version),
		connectionIds,
		revocationGenerations: normalizeRevocationGenerations(record.revocationGenerations, connectionIds),
		updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : '',
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
	private readonly watcher: fs.StatWatcher | undefined;
	private snapshot: PolicySnapshot;
	private readonly readyPromise: Promise<void>;
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
			revocationGenerations: normalizeRevocationGenerations(undefined, legacyIds),
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
			this.watcher = fs.watchFile(this.policyPath, { interval: 250, persistent: false }, () => {
				void this.refresh().catch(error => {
					this.output.warn(`[sql-lnt] Failed to refresh shared policy: ${error instanceof Error ? error.message : String(error)}`);
				});
			});
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
		const release = await lockfile.lock(this.lockTarget, {
			realpath: false,
			stale: POLICY_LOCK_STALE_MS,
			update: 5_000,
			retries: { retries: 100, factor: 1, minTimeout: 25, maxTimeout: 25 },
		});
		try {
			const read = await this.readSnapshot();
			if (read.kind !== 'valid'
				|| read.snapshot.recoveryBlocked
				|| read.snapshot.connectionIds.includes(id)
				|| (expectedRevocationGeneration !== undefined
					&& (read.snapshot.revocationGenerations[id] ?? 0) !== expectedRevocationGeneration)) {
				throw new SqlLeaveNoTraceBlockedError();
			}
			return await prepare();
		} finally {
			await release();
		}
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
	}) => Promise<T>): Promise<T> {
		await this.readyPromise;
		if (!this.policyPath || !this.lockTarget) {
			return run({
				connectionIds: this.getConnectionIds(),
				version: this.snapshot.version,
				globallyBlocked: this.recoveryBlocked,
				revocationGenerations: { ...this.snapshot.revocationGenerations },
			});
		}
		const release = await lockfile.lock(this.lockTarget, {
			realpath: false,
			stale: POLICY_LOCK_STALE_MS,
			update: 5_000,
			retries: { retries: 100, factor: 1, minTimeout: 25, maxTimeout: 25 },
		});
		try {
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
		} finally {
			await release();
		}
	}

	async prepareSnapshotDispatch<T>(prepare: (snapshot: {
		connectionIds: readonly string[];
		version: number;
		globallyBlocked: boolean;
		revocationGenerations: Readonly<Record<string, number>>;
	}) => Promise<SqlDispatchHandle<T>>): Promise<SqlDispatchHandle<T>> {
		await this.readyPromise;
		if (!this.policyPath || !this.lockTarget) {
			return await prepare({
				connectionIds: this.getConnectionIds(),
				version: this.snapshot.version,
				globallyBlocked: this.recoveryBlocked,
				revocationGenerations: { ...this.snapshot.revocationGenerations },
			});
		}
		const release = await lockfile.lock(this.lockTarget, {
			realpath: false,
			stale: POLICY_LOCK_STALE_MS,
			update: 5_000,
			retries: { retries: 100, factor: 1, minTimeout: 25, maxTimeout: 25 },
		});
		try {
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
		} finally {
			await release();
		}
	}

	async refresh(): Promise<string[]> {
		await this.readyPromise;
		if (!this.policyPath) return this.getConnectionIds();
		const disk = await this.readSnapshot();
		if (disk.kind === 'valid') await this.applySnapshot(disk.snapshot);
		else if (disk.kind === 'corrupt') await this.applySnapshot(await this.recoverCorruptPolicy());
		else await this.applySnapshot(await this.recoverMissingPolicy());
		return this.getConnectionIds();
	}

	async setConnection(connectionId: string, enabled: boolean): Promise<void> {
		const id = String(connectionId || '').trim();
		if (!id) return;
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
		const release = await lockfile.lock(this.lockTarget, {
			realpath: false,
			stale: POLICY_LOCK_STALE_MS,
			update: 5_000,
			retries: { retries: 100, factor: 1, minTimeout: 25, maxTimeout: 25 },
		});
		let next: PolicySnapshot;
		try {
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
				next = current;
			} else {
				next = {
					schemaVersion: POLICY_SCHEMA_VERSION,
					version: current.version + 1,
					connectionIds: ids,
					revocationGenerations: enabled && !current.connectionIds.includes(id)
						? { ...current.revocationGenerations, [id]: (current.revocationGenerations[id] ?? 0) + 1 }
						: { ...current.revocationGenerations },
					updatedAt: new Date().toISOString(),
						recoveryBlocked: current.recoveryBlocked,
				};
				await this.writeSnapshot(next);
			}
		} finally {
			await release();
		}
		await this.applySnapshot(next);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		if (this.policyPath) fs.unwatchFile(this.policyPath);
		this.watcher?.removeAllListeners();
		this.changeEmitter.dispose();
	}

	private async initialize(): Promise<void> {
		if (!this.policyPath || !this.lockTarget) return;
		await fs.promises.mkdir(path.dirname(this.policyPath), { recursive: true });
		const release = await lockfile.lock(this.lockTarget, {
			realpath: false,
			stale: POLICY_LOCK_STALE_MS,
			update: 5_000,
			retries: { retries: 100, factor: 1, minTimeout: 25, maxTimeout: 25 },
		});
		let snapshot: PolicySnapshot;
		try {
			const read = await this.readSnapshot();
			if (read.kind === 'valid') {
				snapshot = read.snapshot;
				await this.writeSnapshot(snapshot);
			} else if (read.kind === 'corrupt') {
				snapshot = await this.recoverCorruptPolicyUnderLock();
			} else {
				snapshot = await this.recoverMissingPolicyUnderLock(true);
			}
		} finally {
			await release();
		}
		await this.applySnapshot(snapshot, false);
	}

	private async readSnapshot(): Promise<PolicyReadResult> {
		if (!this.policyPath) return { kind: 'missing' };
		try {
			const parsed = parseSnapshot(JSON.parse(await fs.promises.readFile(this.policyPath, 'utf8')));
			return parsed ? { kind: 'valid', snapshot: parsed } : { kind: 'corrupt' };
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { kind: 'missing' };
			if (!(error instanceof SyntaxError)) throw error;
			return { kind: 'corrupt' };
		}
	}

	private async recoverCorruptPolicy(): Promise<PolicySnapshot> {
		if (!this.policyPath || !this.lockTarget) return this.snapshot;
		const release = await lockfile.lock(this.lockTarget, {
			realpath: false,
			stale: POLICY_LOCK_STALE_MS,
			update: 5_000,
			retries: { retries: 100, factor: 1, minTimeout: 25, maxTimeout: 25 },
		});
		try {
			const read = await this.readSnapshot();
			return read.kind === 'valid' ? read.snapshot : this.recoverCorruptPolicyUnderLock();
		} finally {
			await release();
		}
	}

	private async recoverMissingPolicy(): Promise<PolicySnapshot> {
		if (!this.policyPath || !this.lockTarget) return this.snapshot;
		const release = await lockfile.lock(this.lockTarget, {
			realpath: false,
			stale: POLICY_LOCK_STALE_MS,
			update: 5_000,
			retries: { retries: 100, factor: 1, minTimeout: 25, maxTimeout: 25 },
		});
		try {
			const read = await this.readSnapshot();
			if (read.kind === 'valid') return read.snapshot;
			if (read.kind === 'corrupt') return this.recoverCorruptPolicyUnderLock();
			return this.recoverMissingPolicyUnderLock(false);
		} finally {
			await release();
		}
	}

	private async recoverCorruptPolicyUnderLock(): Promise<PolicySnapshot> {
		if (this.policyPath) await quarantineCorruptSqlStateFile(this.policyPath);
		const committed = await this.readCommittedBackup();
		const recovered: PolicySnapshot = committed ?? {
			schemaVersion: POLICY_SCHEMA_VERSION,
			version: Math.max(Date.now(), this.snapshot.version + 1),
			connectionIds: [],
			revocationGenerations: { ...this.snapshot.revocationGenerations },
			updatedAt: new Date().toISOString(),
			recoveryBlocked: true,
		};
		this.recoveryBlocked = recovered.recoveryBlocked;
		await this.writeSnapshot(recovered);
		this.output.warn(committed
			? '[sql-lnt] Quarantined a malformed shared policy file and restored its committed redundant snapshot.'
			: '[sql-lnt] Quarantined a malformed shared policy file. SQL access remains blocked because no committed redundant snapshot was available.');
		return recovered;
	}

	private async recoverMissingPolicyUnderLock(allowLegacyMigration = false): Promise<PolicySnapshot> {
		const committed = await this.readCommittedBackup();
		if (committed) {
			await this.writeSnapshot(committed);
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
				? normalizeRevocationGenerations(undefined, recoveredConnectionIds)
				: { ...this.snapshot.revocationGenerations },
			updatedAt: new Date().toISOString(),
			recoveryBlocked: !mayMigrateLegacy,
		};
		await this.writeSnapshot(recovered);
		return recovered;
	}

	private async readCommittedBackup(): Promise<PolicySnapshot | undefined> {
		if (!this.backupPath || !this.commitPath) return undefined;
		try {
			const backupText = await fs.promises.readFile(this.backupPath, 'utf8');
			const snapshot = parseSnapshot(JSON.parse(backupText));
			const commit = JSON.parse(await fs.promises.readFile(this.commitPath, 'utf8')) as Partial<PolicyCommit>;
			const sha256 = crypto.createHash('sha256').update(backupText, 'utf8').digest('hex');
			if (!snapshot
				|| commit.schemaVersion !== POLICY_SCHEMA_VERSION
				|| commit.version !== snapshot.version
				|| commit.sha256 !== sha256) return undefined;
			return snapshot;
		} catch {
			return undefined;
		}
	}

	private async writeSnapshot(snapshot: PolicySnapshot): Promise<void> {
		if (!this.policyPath || !this.backupPath || !this.commitPath || !this.migrationPath) return;
		const snapshotText = `${JSON.stringify(snapshot, null, 2)}\n`;
		const commit: PolicyCommit = {
			schemaVersion: POLICY_SCHEMA_VERSION,
			version: snapshot.version,
			sha256: crypto.createHash('sha256').update(snapshotText, 'utf8').digest('hex'),
		};
		await this.writeAtomic(this.backupPath, snapshotText);
		await this.writeAtomic(this.policyPath, snapshotText);
		try {
			await this.writeAtomic(this.commitPath, `${JSON.stringify(commit)}\n`);
		} catch {
			// The primary policy is the commit point. A stale marker only disables backup recovery.
		}
		if (!fs.existsSync(this.migrationPath)) {
			try { await this.writeAtomic(this.migrationPath, 'migrated\n'); }
			catch { /* a valid primary policy makes migration-marker retry safe */ }
		}
	}

	private async writeAtomic(filePath: string, contents: string): Promise<void> {
		const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
		await fs.promises.writeFile(tempPath, contents, 'utf8');
		try {
			for (let attempt = 0; ; attempt += 1) {
				try {
					await fs.promises.rename(tempPath, filePath);
					break;
				} catch (error) {
					const code = (error as NodeJS.ErrnoException).code;
					const delayMs = ATOMIC_RENAME_RETRY_DELAYS_MS[attempt];
					if (!delayMs || (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY')) throw error;
					await new Promise<void>(resolve => setTimeout(resolve, delayMs));
				}
			}
		}
		finally { try { await fs.promises.rm(tempPath, { force: true }); } catch { /* ignore */ } }
	}

	private async applySnapshot(snapshot: PolicySnapshot, emit: boolean = true): Promise<void> {
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
