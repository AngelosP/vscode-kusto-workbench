import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import type { WorkbenchLogger } from '../workbenchLogger';
import type { SqlConnection } from '../sqlConnectionManager';
import { startSqlDispatch, type SqlDispatchHandle } from './sqlDispatch';
import { quarantineCorruptSqlStateFile } from './sqlStateFile';
import {
	readCommittedSqlStateBackup,
	readRecoverableSqlStateSnapshot,
	withSqlStateFileLock,
	writeRecoverableSqlStateSnapshot,
	writeSqlStateMarkerIfMissing,
} from './sqlStateTransaction';

const STORAGE_KEY = 'sql.auth.serverAccountMap';
const SNAPSHOT_FILENAME = 'sql-server-account-map.v1.json';
const SNAPSHOT_BACKUP_FILENAME = 'sql-server-account-map.backup.v1.json';
const SNAPSHOT_COMMIT_FILENAME = 'sql-server-account-map.commit.v1.json';
const SNAPSHOT_MIGRATION_FILENAME = 'sql-server-account-map-migrated.v1';
const SNAPSHOT_SCHEMA_VERSION = 1;
const LOCK_STALE_MS = 30_000;

type AccountMapContext = Pick<vscode.ExtensionContext, 'globalState' | 'globalStorageUri'>;

type AccountMapSnapshot = {
	schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
	version: number;
	accountsByServer: Record<string, string>;
	recoveryBlocked: boolean;
	blockedServerUrls: string[];
};

export interface SqlServerAccountMapChange {
	accountsByServer: Record<string, string>;
	previousAccountsByServer: Record<string, string>;
	changedServerUrls: string[];
	establishedServerUrls: string[];
	invalidatedServerUrls: string[];
	version: number;
}

function normalizeServerUrl(serverUrl: unknown): string {
	return String(serverUrl || '').trim().toLowerCase();
}

function normalizeMap(value: unknown): Record<string, string> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
	const result: Record<string, string> = {};
	for (const [serverUrl, accountId] of Object.entries(value as Record<string, unknown>)) {
		const server = normalizeServerUrl(serverUrl);
		const account = String(accountId || '').trim();
		if (server && account) result[server] = account;
	}
	return result;
}

function principalFingerprint(connection: SqlConnection, accountsByServer: Readonly<Record<string, string>>): string | undefined {
	const authType = String(connection.authType || '').trim().toLowerCase();
	const principal = authType === 'aad'
		? accountsByServer[normalizeServerUrl(connection.serverUrl)]
		: String(connection.username || '').trim();
	if (!authType || !principal) return undefined;
	return crypto.createHash('sha256')
		.update(`${authType}\n${normalizeServerUrl(connection.serverUrl)}\n${principal}`, 'utf8')
		.digest('hex');
}

function emptySnapshot(accountsByServer: Record<string, string> = {}, recoveryBlocked = false): AccountMapSnapshot {
	return { schemaVersion: SNAPSHOT_SCHEMA_VERSION, version: 0, accountsByServer, recoveryBlocked, blockedServerUrls: [] };
}

function assertAccountMapAvailable(snapshot: AccountMapSnapshot, serverUrl?: string): void {
	const server = normalizeServerUrl(serverUrl);
	const serverBlocked = server
		? snapshot.blockedServerUrls.includes(server)
			|| (snapshot.recoveryBlocked && !snapshot.accountsByServer[server])
		: snapshot.recoveryBlocked || snapshot.blockedServerUrls.length > 0;
	if (serverBlocked) {
		throw new Error('SQL account ownership state could not be recovered. Re-select the SQL account explicitly before retrying.');
	}
}

function parseSnapshot(value: unknown): AccountMapSnapshot | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
	const candidate = value as Partial<AccountMapSnapshot>;
	if (candidate.schemaVersion !== SNAPSHOT_SCHEMA_VERSION
		|| !Number.isSafeInteger(candidate.version) || Number(candidate.version) < 0
		|| !candidate.accountsByServer || typeof candidate.accountsByServer !== 'object' || Array.isArray(candidate.accountsByServer)
		|| (candidate.recoveryBlocked !== undefined && typeof candidate.recoveryBlocked !== 'boolean')
		|| (candidate.blockedServerUrls !== undefined && (!Array.isArray(candidate.blockedServerUrls)
			|| candidate.blockedServerUrls.some(server => typeof server !== 'string' || !normalizeServerUrl(server))))) return undefined;
	for (const [serverUrl, accountId] of Object.entries(candidate.accountsByServer)) {
		if (!normalizeServerUrl(serverUrl) || typeof accountId !== 'string' || !accountId.trim()) return undefined;
	}
	return {
		schemaVersion: SNAPSHOT_SCHEMA_VERSION,
		version: Number(candidate.version),
		accountsByServer: normalizeMap(candidate.accountsByServer),
		recoveryBlocked: candidate.recoveryBlocked === true,
		blockedServerUrls: [...new Set((candidate.blockedServerUrls ?? []).map(normalizeServerUrl))].sort(),
	};
}

type AccountMapPaths = {
	snapshotPath: string;
	backupPath: string;
	commitPath: string;
	migrationPath: string;
	lockTarget: string;
};

function snapshotPaths(context: AccountMapContext): AccountMapPaths | undefined {
	const root = String(context.globalStorageUri?.fsPath || '').trim();
	if (!root) return undefined;
	const snapshotPath = path.join(root, SNAPSHOT_FILENAME);
	return {
		snapshotPath,
		backupPath: path.join(root, SNAPSHOT_BACKUP_FILENAME),
		commitPath: path.join(root, SNAPSHOT_COMMIT_FILENAME),
		migrationPath: path.join(root, SNAPSHOT_MIGRATION_FILENAME),
		lockTarget: `${snapshotPath}.write`,
	};
}

async function readSnapshotFile(
	resolved: AccountMapPaths,
	fallback: Record<string, string> = {},
	minimumRecoveryVersion = 1,
	allowUncommittedPrimary = false,
): Promise<AccountMapSnapshot> {
	const migrationCompleted = fs.existsSync(resolved.migrationPath);
	const read = await readRecoverableSqlStateSnapshot({
		primaryPath: resolved.snapshotPath,
		backupPath: resolved.backupPath,
		commitPath: resolved.commitPath,
		parseSnapshot,
		getIdentity: snapshot => ({ schemaVersion: snapshot.schemaVersion, version: snapshot.version }),
		allowUncommittedPrimary,
	});
	if (read.kind === 'valid') {
		if (read.source === 'backup') {
			if (read.primaryState === 'invalid') await quarantineCorruptSqlStateFile(resolved.snapshotPath);
			await writeSnapshotFile(resolved, read.value);
		} else if (!read.committed) {
			await writeSnapshotFile(resolved, read.value);
		}
		await writeSqlStateMarkerIfMissing(resolved.migrationPath);
		return read.value;
	}
	if (read.kind === 'invalid') await quarantineCorruptSqlStateFile(resolved.snapshotPath);
	const committed = await readCommittedSqlStateBackup({
		backupPath: resolved.backupPath,
		commitPath: resolved.commitPath,
		parseSnapshot,
		getIdentity: snapshot => ({ schemaVersion: snapshot.schemaVersion, version: snapshot.version }),
	});
	if (committed) {
		await writeSnapshotFile(resolved, committed);
		return committed;
	}
	const mayMigrateLegacy = read.kind === 'missing' && !migrationCompleted;
	const recovered: AccountMapSnapshot = {
		schemaVersion: SNAPSHOT_SCHEMA_VERSION,
		version: Math.max(1, mayMigrateLegacy ? 1 : Date.now(), minimumRecoveryVersion),
		accountsByServer: mayMigrateLegacy ? fallback : {},
		recoveryBlocked: !mayMigrateLegacy && Object.keys(fallback).length === 0,
		blockedServerUrls: mayMigrateLegacy ? [] : Object.keys(fallback).map(normalizeServerUrl).sort(),
	};
	await writeSnapshotFile(resolved, recovered);
	return recovered;
}

async function writeSnapshotFile(resolved: AccountMapPaths, snapshot: AccountMapSnapshot): Promise<void> {
	const text = `${JSON.stringify(snapshot, null, 2)}\n`;
	await writeRecoverableSqlStateSnapshot({
		primaryPath: resolved.snapshotPath,
		backupPath: resolved.backupPath,
		commitPath: resolved.commitPath,
		migrationPath: resolved.migrationPath,
		text,
		identity: { schemaVersion: snapshot.schemaVersion, version: snapshot.version },
	});
}

async function withSnapshotLock<T>(
	context: AccountMapContext,
	action: (snapshot: AccountMapSnapshot, snapshotPath?: string) => Promise<T>,
	minimumRecoveryVersion = 1,
	allowUncommittedPrimary = false,
): Promise<T> {
	const resolved = snapshotPaths(context);
	const legacy = normalizeMap(context.globalState.get<unknown>(STORAGE_KEY));
	if (!resolved) return action(emptySnapshot(legacy));
	return withSqlStateFileLock(resolved.lockTarget, async () => {
		const snapshot = await readSnapshotFile(resolved, legacy, minimumRecoveryVersion, allowUncommittedPrimary);
		return await action(snapshot, resolved.snapshotPath);
	}, { staleMs: LOCK_STALE_MS });
}

export async function readCurrentSqlServerAccountMap(context: AccountMapContext, serverUrl?: string): Promise<Record<string, string>> {
	const resolved = snapshotPaths(context);
	if (!resolved) return normalizeMap(context.globalState.get<unknown>(STORAGE_KEY));
	return withSnapshotLock(context, async snapshot => {
		assertAccountMapAvailable(snapshot, serverUrl);
		return snapshot.accountsByServer;
	}, Date.now());
}

export async function establishCanonicalSqlServerAccount(
	context: AccountMapContext,
	serverUrl: string,
	accountId: string,
): Promise<string> {
	const server = normalizeServerUrl(serverUrl);
	const candidate = String(accountId || '').trim();
	if (!server || !candidate) return '';
	return withSnapshotLock(context, async (snapshot, snapshotPath) => {
		assertAccountMapAvailable(snapshot, server);
		const established = snapshot.accountsByServer[server];
		if (established) return established;
		const nextMap = { ...snapshot.accountsByServer, [server]: candidate };
		const next: AccountMapSnapshot = {
			schemaVersion: SNAPSHOT_SCHEMA_VERSION,
			version: snapshot.version + 1,
			accountsByServer: nextMap,
			recoveryBlocked: snapshot.recoveryBlocked,
			blockedServerUrls: snapshot.blockedServerUrls.filter(candidate => candidate !== server),
		};
		const resolved = snapshotPaths(context);
		if (snapshotPath && resolved) await writeSnapshotFile(resolved, next);
		try { await context.globalState.update(STORAGE_KEY, nextMap); } catch {
			if (!snapshotPath) throw new Error('Failed to persist SQL server account mapping.');
		}
		return candidate;
	});
}

export async function verifyCanonicalSqlServerAccount(
	context: AccountMapContext,
	serverUrl: string,
	accountId: string,
): Promise<boolean> {
	const server = normalizeServerUrl(serverUrl);
	const expected = String(accountId || '').trim();
	if (!server || !expected) return false;
	return withSnapshotLock(context, async snapshot => {
		assertAccountMapAvailable(snapshot, server);
		return snapshot.accountsByServer[server] === expected;
	}, Date.now());
}

export async function setCanonicalSqlServerAccount(context: AccountMapContext, serverUrl: string, accountId?: string): Promise<void> {
	const server = normalizeServerUrl(serverUrl);
	if (!server) return;
	await withSnapshotLock(context, async (snapshot, snapshotPath) => {
		const nextMap = { ...snapshot.accountsByServer };
		const account = String(accountId || '').trim();
		if (account) nextMap[server] = account;
		else delete nextMap[server];
		const nextBlockedServerUrls = account
			? snapshot.blockedServerUrls.filter(candidate => candidate !== server)
			: snapshot.blockedServerUrls;
		const nextRecoveryBlocked = snapshot.recoveryBlocked;
		if (nextRecoveryBlocked === snapshot.recoveryBlocked
			&& JSON.stringify(nextBlockedServerUrls) === JSON.stringify(snapshot.blockedServerUrls)
			&& JSON.stringify(nextMap) === JSON.stringify(snapshot.accountsByServer)) {
			try { await context.globalState.update(STORAGE_KEY, nextMap); } catch {
				if (!snapshotPath) throw new Error('Failed to persist SQL server account mapping.');
			}
			return;
		}
		const next: AccountMapSnapshot = {
			schemaVersion: SNAPSHOT_SCHEMA_VERSION,
			version: snapshot.version + 1,
			accountsByServer: nextMap,
			recoveryBlocked: nextRecoveryBlocked,
			blockedServerUrls: nextBlockedServerUrls,
		};
		const resolved = snapshotPaths(context);
		if (snapshotPath && resolved) await writeSnapshotFile(resolved, next);
		try { await context.globalState.update(STORAGE_KEY, nextMap); } catch {
			if (!snapshotPath) throw new Error('Failed to persist SQL server account mapping.');
		}
	});
}

export class SqlServerAccountMapStore implements vscode.Disposable {
	private readonly changeEmitter = new vscode.EventEmitter<SqlServerAccountMapChange>();
	readonly onDidChange = this.changeEmitter.event;
	private snapshot = emptySnapshot();
	private readonly snapshotPath: string | undefined;
	private readonly readyPromise: Promise<void>;
	private disposed = false;

	constructor(private readonly context: vscode.ExtensionContext, private readonly output: WorkbenchLogger) {
		this.snapshotPath = snapshotPaths(context)?.snapshotPath;
		this.readyPromise = this.initialize();
		if (this.snapshotPath) {
			fs.watchFile(this.snapshotPath, { interval: 250, persistent: false }, () => {
				void this.refresh().catch(error => {
					this.output.warn(`[sql-auth] Failed to refresh shared account map: ${error instanceof Error ? error.message : String(error)}`);
				});
			});
		}
	}

	ready(): Promise<void> {
		return this.readyPromise;
	}

	getAccountsByServer(): Record<string, string> {
		return { ...this.snapshot.accountsByServer };
	}

	getVersion(): number {
		return this.snapshot.version;
	}

	async preparePrincipalDispatch<T>(
		connection: SqlConnection,
		expectedPrincipalFingerprint: string,
		dispatch: () => T | PromiseLike<T>,
	): Promise<SqlDispatchHandle<T>> {
		await this.readyPromise;
		return withSnapshotLock(this.context, async snapshot => {
			assertAccountMapAvailable(snapshot, connection.serverUrl);
			const authType = String(connection.authType || '').trim().toLowerCase();
			const pendingAadPrincipal = expectedPrincipalFingerprint === 'aad-pending'
				&& authType === 'aad'
				&& !snapshot.accountsByServer[normalizeServerUrl(connection.serverUrl)];
			if (!pendingAadPrincipal && (!expectedPrincipalFingerprint
				|| principalFingerprint(connection, snapshot.accountsByServer) !== expectedPrincipalFingerprint)) {
				throw new Error('SQL principal changed before canonical dispatch admission.');
			}
			return startSqlDispatch(dispatch);
		}, this.snapshot.version + 1);
	}

	async prepareSnapshotDispatch<T>(
		prepare: (snapshot: { accountsByServer: Readonly<Record<string, string>>; version: number }) => SqlDispatchHandle<T>,
	): Promise<SqlDispatchHandle<T>> {
		await this.readyPromise;
		return withSnapshotLock(this.context, async snapshot => {
			return prepare({
				accountsByServer: { ...snapshot.accountsByServer },
				version: snapshot.version,
			});
		}, this.snapshot.version + 1);
	}

	async runWithSnapshotLock<T>(
		run: (snapshot: { accountsByServer: Readonly<Record<string, string>>; version: number }) => Promise<T>,
	): Promise<T> {
		await this.readyPromise;
		return withSnapshotLock(this.context, async snapshot => {
			return run({
				accountsByServer: { ...snapshot.accountsByServer },
				version: snapshot.version,
			});
		}, this.snapshot.version + 1);
	}

	async refresh(): Promise<Record<string, string>> {
		await this.readyPromise;
		if (!this.snapshotPath) return this.getAccountsByServer();
		await withSnapshotLock(this.context, snapshot => this.applySnapshot(snapshot), this.snapshot.version + 1);
		return this.getAccountsByServer();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		if (this.snapshotPath) fs.unwatchFile(this.snapshotPath);
		this.changeEmitter.dispose();
	}

	private async initialize(): Promise<void> {
		await withSnapshotLock(this.context, async (snapshot, snapshotPath) => {
			let current = snapshot;
			if (snapshot.version === 0 && snapshotPath) {
				current = { ...snapshot, version: 1 };
				const resolved = snapshotPaths(this.context);
				if (resolved) await writeSnapshotFile(resolved, current);
			}
			await this.applySnapshot(current, false);
		}, 1, true);
	}

	private async applySnapshot(snapshot: AccountMapSnapshot, emit = true): Promise<void> {
		if (snapshot.version < this.snapshot.version) return;
		const previous = this.snapshot.accountsByServer;
		const changedServerUrls = [...new Set([...Object.keys(previous), ...Object.keys(snapshot.accountsByServer)])]
			.filter(server => previous[server] !== snapshot.accountsByServer[server]);
		if (snapshot.version === this.snapshot.version && changedServerUrls.length === 0
			&& snapshot.recoveryBlocked === this.snapshot.recoveryBlocked) return;
		this.snapshot = snapshot;
		try { await this.context.globalState.update(STORAGE_KEY, snapshot.accountsByServer); } catch {
			// The locked file is authoritative.
		}
		if (emit && !this.disposed && changedServerUrls.length > 0) {
			this.changeEmitter.fire({
				accountsByServer: this.getAccountsByServer(),
				previousAccountsByServer: { ...previous },
				changedServerUrls,
				establishedServerUrls: changedServerUrls.filter(server => !previous[server] && !!snapshot.accountsByServer[server]),
				invalidatedServerUrls: changedServerUrls.filter(server => !!previous[server]),
				version: snapshot.version,
			});
		}
	}
}
