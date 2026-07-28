import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { kustoClusterKey } from '../shared/kustoClusterUrls.js';
import type { WorkbenchLogger } from './workbenchLogger.js';
import {
	atomicReplaceSqlStateFile,
	readCommittedSqlStateBackup,
	readRecoverableSqlStateSnapshot,
	withSqlStateFileLock,
	writeRecoverableSqlStateSnapshot,
} from './sql/sqlStateTransaction.js';

const SCHEMA_VERSION = 1;
const POLICY_FILENAME = 'kusto-leave-no-trace-policy.v1.json';
const BACKUP_FILENAME = 'kusto-leave-no-trace-policy.backup.v1.json';
const COMMIT_FILENAME = 'kusto-leave-no-trace-policy.commit.v1.json';
const MIGRATION_FILENAME = 'kusto-leave-no-trace-policy-migrated.v1';
const LEGACY_STORAGE_KEY = 'kusto.leaveNoTraceClusters';
const POLICY_LOCK_OPTIONS = { retries: 480, retryDelayMs: 25 } as const;

type PolicySnapshot = Readonly<{
	schemaVersion: typeof SCHEMA_VERSION;
	version: number;
	clusterKeys: string[];
	revocationGenerations: Record<string, number>;
	updatedAt: string;
	recoveryBlocked: boolean;
}>;

export type KustoLeaveNoTracePolicySnapshot = Readonly<{
	clusterKeys: readonly string[];
	globallyBlocked: boolean;
	version: number;
	revocationGenerations: Readonly<Record<string, number>>;
}>;

export type KustoLeaveNoTracePolicyChange = Readonly<{
	clusterKeys: readonly string[];
	enabledClusterKeys: readonly string[];
	disabledClusterKeys: readonly string[];
	invalidatedClusterKeys: readonly string[];
	version: number;
	globallyBlocked: boolean;
}>;

function normalizeKeys(value: unknown): string[] {
	return Array.isArray(value)
		? [...new Set(value.map(candidate => kustoClusterKey(String(candidate || ''))).filter(Boolean))].sort()
		: [];
}

function parseSnapshot(value: unknown): PolicySnapshot | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
	const candidate = value as Partial<PolicySnapshot>;
	if (candidate.schemaVersion !== SCHEMA_VERSION
		|| !Number.isSafeInteger(candidate.version) || Number(candidate.version) < 0
		|| !Array.isArray(candidate.clusterKeys)
		|| !candidate.revocationGenerations || typeof candidate.revocationGenerations !== 'object'
		|| Array.isArray(candidate.revocationGenerations)
		|| typeof candidate.updatedAt !== 'string'
		|| typeof candidate.recoveryBlocked !== 'boolean') return undefined;
	const clusterKeys = normalizeKeys(candidate.clusterKeys);
	const revocationGenerations: Record<string, number> = {};
	for (const [rawKey, rawGeneration] of Object.entries(candidate.revocationGenerations)) {
		const key = kustoClusterKey(rawKey);
		if (!key || !Number.isSafeInteger(rawGeneration) || Number(rawGeneration) <= 0) return undefined;
		revocationGenerations[key] = Number(rawGeneration);
	}
	for (const key of clusterKeys) revocationGenerations[key] ??= 1;
	return Object.freeze({
		schemaVersion: SCHEMA_VERSION,
		version: Number(candidate.version),
		clusterKeys,
		revocationGenerations,
		updatedAt: candidate.updatedAt,
		recoveryBlocked: candidate.recoveryBlocked,
	});
}

function sameKeys(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

export class KustoLeaveNoTracePolicyStore implements vscode.Disposable {
	private readonly changeEmitter = new vscode.EventEmitter<KustoLeaveNoTracePolicyChange>();
	readonly onDidChange = this.changeEmitter.event;
	private readonly policyPath: string | undefined;
	private readonly backupPath: string | undefined;
	private readonly commitPath: string | undefined;
	private readonly migrationPath: string | undefined;
	private readonly lockTarget: string | undefined;
	private readonly watcher: fs.StatWatcher | undefined;
	private snapshot: PolicySnapshot;
	private readonly readyPromise: Promise<void>;
	private disposed = false;

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly output: WorkbenchLogger,
	) {
		const legacyKeys = normalizeKeys(context.globalState.get<unknown>(LEGACY_STORAGE_KEY));
		this.snapshot = Object.freeze({
			schemaVersion: SCHEMA_VERSION,
			version: 0,
			clusterKeys: legacyKeys,
			revocationGenerations: Object.fromEntries(legacyKeys.map(key => [key, 1])),
			updatedAt: '',
			recoveryBlocked: false,
		});
		const root = String(context.globalStorageUri?.fsPath || '').trim();
		this.policyPath = root ? path.join(root, POLICY_FILENAME) : undefined;
		this.backupPath = root ? path.join(root, BACKUP_FILENAME) : undefined;
		this.commitPath = root ? path.join(root, COMMIT_FILENAME) : undefined;
		this.migrationPath = root ? path.join(root, MIGRATION_FILENAME) : undefined;
		this.lockTarget = this.policyPath ? `${this.policyPath}.write` : undefined;
		this.readyPromise = this.initialize();
		if (this.policyPath) {
			this.watcher = fs.watchFile(this.policyPath, { interval: 250, persistent: false }, () => {
				void this.refresh().catch(error => {
					this.output.warn(`[kusto-lnt] Failed to refresh shared policy: ${error instanceof Error ? error.message : String(error)}`);
				});
			});
		}
	}

	getClusterKeys(): string[] {
		return [...this.snapshot.clusterKeys];
	}

	isGloballyBlocked(): boolean {
		return this.snapshot.recoveryBlocked;
	}

	getRevocationGeneration(clusterUrl: string): number {
		return this.snapshot.revocationGenerations[kustoClusterKey(clusterUrl)] ?? 0;
	}

	isProtected(clusterUrl: string): boolean {
		return this.snapshot.recoveryBlocked || this.snapshot.clusterKeys.includes(kustoClusterKey(clusterUrl));
	}

	async refresh(): Promise<void> {
		await this.readyPromise;
		if (!this.policyPath || !this.lockTarget) return;
		const snapshot = await withSqlStateFileLock(this.lockTarget, () => this.readOrRecoverUnderLock(false), POLICY_LOCK_OPTIONS);
		await this.applySnapshot(snapshot);
	}

	async setCluster(clusterUrl: string, enabled: boolean): Promise<void> {
		const key = kustoClusterKey(clusterUrl);
		if (!key) return;
		await this.readyPromise;
		if (!this.policyPath || !this.lockTarget) {
			const current = new Set(this.snapshot.clusterKeys);
			if (current.has(key) === enabled) return;
			enabled ? current.add(key) : current.delete(key);
			await this.applySnapshot(this.nextSnapshot(this.snapshot, [...current].sort(), key));
			return;
		}
		const snapshot = await withSqlStateFileLock(this.lockTarget, async () => {
			const current = await this.readOrRecoverUnderLock(false);
			const keys = new Set(current.clusterKeys);
			if (keys.has(key) === enabled) return current;
			enabled ? keys.add(key) : keys.delete(key);
			const next = this.nextSnapshot(current, [...keys].sort(), key);
			await this.writeSnapshot(next);
			return next;
		}, { ...POLICY_LOCK_OPTIONS, retryUntilStale: true });
		await this.applySnapshot(snapshot);
	}

	async prepareDispatch<T>(clusterUrl: string, start: (revocationGeneration: number) => T): Promise<{ value: T; revocationGeneration: number }> {
		const key = kustoClusterKey(clusterUrl);
		await this.readyPromise;
		if (!this.policyPath || !this.lockTarget) {
			const revocationGeneration = this.getRevocationGeneration(key);
			return { value: start(revocationGeneration), revocationGeneration };
		}
		return withSqlStateFileLock(this.lockTarget, async () => {
			const snapshot = await this.readOrRecoverUnderLock(false);
			const revocationGeneration = snapshot.revocationGenerations[key] ?? 0;
			return { value: start(revocationGeneration), revocationGeneration };
		}, POLICY_LOCK_OPTIONS);
	}

	async admitRevision<T>(clusterUrl: string, expectedGeneration: number, admit: () => T | PromiseLike<T>): Promise<{ admitted: boolean; value?: Awaited<T> }> {
		const key = kustoClusterKey(clusterUrl);
		await this.readyPromise;
		if (!this.policyPath || !this.lockTarget) {
			if (this.snapshot.recoveryBlocked || this.getRevocationGeneration(key) !== expectedGeneration) return { admitted: false };
			return { admitted: true, value: await admit() };
		}
		return withSqlStateFileLock(this.lockTarget, async () => {
			const snapshot = await this.readOrRecoverUnderLock(false);
			if (snapshot.recoveryBlocked || (snapshot.revocationGenerations[key] ?? 0) !== expectedGeneration) return { admitted: false };
			return { admitted: true, value: await admit() };
		}, POLICY_LOCK_OPTIONS);
	}

	async runWithSnapshotLock<T>(run: (snapshot: KustoLeaveNoTracePolicySnapshot) => Promise<T>): Promise<T> {
		await this.readyPromise;
		if (!this.policyPath || !this.lockTarget) return run(this.publicSnapshot(this.snapshot));
		return withSqlStateFileLock<T>(this.lockTarget, async () => {
			const snapshot = await this.readOrRecoverUnderLock(false);
			return run(this.publicSnapshot(snapshot));
		}, POLICY_LOCK_OPTIONS);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		if (this.policyPath) fs.unwatchFile(this.policyPath);
		this.watcher?.removeAllListeners();
		this.changeEmitter.dispose();
	}

	private publicSnapshot(snapshot: PolicySnapshot): KustoLeaveNoTracePolicySnapshot {
		return Object.freeze({
			clusterKeys: Object.freeze([...snapshot.clusterKeys]),
			globallyBlocked: snapshot.recoveryBlocked,
			version: snapshot.version,
			revocationGenerations: Object.freeze({ ...snapshot.revocationGenerations }),
		});
	}

	private nextSnapshot(current: PolicySnapshot, clusterKeys: string[], invalidatedKey: string): PolicySnapshot {
		return Object.freeze({
			schemaVersion: SCHEMA_VERSION,
			version: current.version + 1,
			clusterKeys,
			revocationGenerations: {
				...current.revocationGenerations,
				[invalidatedKey]: (current.revocationGenerations[invalidatedKey] ?? 0) + 1,
			},
			updatedAt: new Date().toISOString(),
			recoveryBlocked: current.recoveryBlocked,
		});
	}

	private async initialize(): Promise<void> {
		if (!this.policyPath || !this.lockTarget) return;
		await fs.promises.mkdir(path.dirname(this.policyPath), { recursive: true });
		const allowLegacyMigration = !!this.migrationPath && !fs.existsSync(this.migrationPath);
		const snapshot = await withSqlStateFileLock(this.lockTarget, () => this.readOrRecoverUnderLock(allowLegacyMigration), {
			retryUntilStale: true,
		});
		await this.applySnapshot(snapshot, false);
	}

	private async readOrRecoverUnderLock(allowLegacyMigration: boolean): Promise<PolicySnapshot> {
		const read = await this.readSnapshot(allowLegacyMigration);
		if (read) return read;
		const committed = await this.readCommittedBackup();
		if (committed) {
			await this.writeSnapshot(committed);
			return committed;
		}
		const migrationComplete = !!this.migrationPath && fs.existsSync(this.migrationPath);
		const mayMigrate = allowLegacyMigration && !migrationComplete;
		const clusterKeys = mayMigrate ? normalizeKeys(this.context.globalState.get<unknown>(LEGACY_STORAGE_KEY)) : [];
		const recovered = Object.freeze({
			schemaVersion: SCHEMA_VERSION,
			version: Math.max(1, this.snapshot.version + 1),
			clusterKeys,
			revocationGenerations: Object.fromEntries(clusterKeys.map(key => [key, 1])),
			updatedAt: new Date().toISOString(),
			recoveryBlocked: !mayMigrate,
		}) satisfies PolicySnapshot;
		await this.writeSnapshot(recovered);
		if (recovered.recoveryBlocked) this.output.warn('[kusto-lnt] Shared policy recovery failed closed.');
		return recovered;
	}

	private async readSnapshot(allowUncommittedPrimary: boolean): Promise<PolicySnapshot | undefined> {
		if (!this.policyPath || !this.backupPath || !this.commitPath) return undefined;
		const read = await readRecoverableSqlStateSnapshot({
			primaryPath: this.policyPath,
			backupPath: this.backupPath,
			commitPath: this.commitPath,
			parseSnapshot,
			getIdentity: snapshot => ({ schemaVersion: snapshot.schemaVersion, version: snapshot.version }),
			allowUncommittedPrimary,
		});
		return read.kind === 'valid' ? read.value : undefined;
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

	private async writeSnapshot(snapshot: PolicySnapshot): Promise<void> {
		if (!this.policyPath || !this.backupPath || !this.commitPath || !this.migrationPath) return;
		await writeRecoverableSqlStateSnapshot({
			primaryPath: this.policyPath,
			backupPath: this.backupPath,
			commitPath: this.commitPath,
			migrationPath: this.migrationPath,
			text: `${JSON.stringify(snapshot, null, 2)}\n`,
			identity: { schemaVersion: snapshot.schemaVersion, version: snapshot.version },
			writeAtomic: atomicReplaceSqlStateFile,
		});
	}

	private async applySnapshot(snapshot: PolicySnapshot, emit = true): Promise<void> {
		const previous = this.snapshot;
		if ((previous.recoveryBlocked && !snapshot.recoveryBlocked)
			|| (!snapshot.recoveryBlocked && snapshot.version < previous.version)
			|| (snapshot.version === previous.version
			&& sameKeys(snapshot.clusterKeys, previous.clusterKeys)
			&& snapshot.recoveryBlocked === previous.recoveryBlocked)) return;
		this.snapshot = snapshot;
		if (!snapshot.recoveryBlocked) {
			try { await this.context.globalState.update(LEGACY_STORAGE_KEY, snapshot.clusterKeys); }
			catch (error) { this.output.warn(`[kusto-lnt] Failed to mirror policy: ${error instanceof Error ? error.message : String(error)}`); }
		}
		if (!emit || this.disposed) return;
		const before = new Set(previous.clusterKeys);
		const after = new Set(snapshot.clusterKeys);
		const invalidatedClusterKeys = Object.entries(snapshot.revocationGenerations)
			.filter(([key, generation]) => generation > (previous.revocationGenerations[key] ?? 0))
			.map(([key]) => key);
		this.changeEmitter.fire({
			clusterKeys: snapshot.clusterKeys,
			enabledClusterKeys: snapshot.clusterKeys.filter(key => !before.has(key)),
			disabledClusterKeys: previous.clusterKeys.filter(key => !after.has(key)),
			invalidatedClusterKeys,
			version: snapshot.version,
			globallyBlocked: snapshot.recoveryBlocked,
		});
	}
}