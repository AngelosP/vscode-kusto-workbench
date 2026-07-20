import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as lockfile from 'proper-lockfile';
import * as vscode from 'vscode';

import type { WorkbenchLogger } from '../workbenchLogger';
import type { SqlConnection } from '../sqlConnectionManager';
import { startSqlDispatch, type SqlDispatchHandle } from './sqlDispatch';
import { quarantineCorruptSqlStateFile } from './sqlStateFile';

const STORAGE_KEY = 'sql.auth.serverAccountMap';
const SNAPSHOT_FILENAME = 'sql-server-account-map.v1.json';
const SNAPSHOT_MIGRATION_FILENAME = 'sql-server-account-map-migrated.v1';
const SNAPSHOT_SCHEMA_VERSION = 1;
const LOCK_STALE_MS = 30_000;

type AccountMapContext = Pick<vscode.ExtensionContext, 'globalState' | 'globalStorageUri'>;

type AccountMapSnapshot = {
	schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
	version: number;
	accountsByServer: Record<string, string>;
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

function emptySnapshot(accountsByServer: Record<string, string> = {}): AccountMapSnapshot {
	return { schemaVersion: SNAPSHOT_SCHEMA_VERSION, version: 0, accountsByServer };
}

function parseSnapshot(value: unknown): AccountMapSnapshot | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
	const candidate = value as Partial<AccountMapSnapshot>;
	if (candidate.schemaVersion !== SNAPSHOT_SCHEMA_VERSION
		|| !Number.isSafeInteger(candidate.version) || Number(candidate.version) < 0
		|| !candidate.accountsByServer || typeof candidate.accountsByServer !== 'object' || Array.isArray(candidate.accountsByServer)) return undefined;
	return {
		schemaVersion: SNAPSHOT_SCHEMA_VERSION,
		version: Number(candidate.version),
		accountsByServer: normalizeMap(candidate.accountsByServer),
	};
}

function snapshotPaths(context: AccountMapContext): { snapshotPath: string; migrationPath: string; lockTarget: string } | undefined {
	const root = String(context.globalStorageUri?.fsPath || '').trim();
	if (!root) return undefined;
	const snapshotPath = path.join(root, SNAPSHOT_FILENAME);
	return {
		snapshotPath,
		migrationPath: path.join(root, SNAPSHOT_MIGRATION_FILENAME),
		lockTarget: `${snapshotPath}.write`,
	};
}

async function readSnapshotFile(
	snapshotPath: string,
	fallback: Record<string, string> = {},
	minimumRecoveryVersion = 1,
	recoverMissing = false,
): Promise<AccountMapSnapshot> {
	try {
		const parsed = parseSnapshot(JSON.parse(await fs.promises.readFile(snapshotPath, 'utf8')));
		if (parsed) return parsed;
		await quarantineCorruptSqlStateFile(snapshotPath);
		const recovered = { ...emptySnapshot(), version: Math.max(Date.now(), minimumRecoveryVersion) };
		await writeSnapshotFile(snapshotPath, recovered);
		return recovered;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			if (!recoverMissing) return emptySnapshot(fallback);
			const recovered = { ...emptySnapshot(), version: Math.max(Date.now(), minimumRecoveryVersion) };
			await writeSnapshotFile(snapshotPath, recovered);
			return recovered;
		}
		if (!(error instanceof SyntaxError)) throw error;
		await quarantineCorruptSqlStateFile(snapshotPath);
		const recovered = { ...emptySnapshot(), version: Math.max(Date.now(), minimumRecoveryVersion) };
		await writeSnapshotFile(snapshotPath, recovered);
		return recovered;
	}
}

async function writeSnapshotFile(snapshotPath: string, snapshot: AccountMapSnapshot): Promise<void> {
	await fs.promises.mkdir(path.dirname(snapshotPath), { recursive: true });
	const tempPath = `${snapshotPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
	await fs.promises.writeFile(tempPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
	try {
		await fs.promises.rename(tempPath, snapshotPath);
	} finally {
		try { await fs.promises.rm(tempPath, { force: true }); } catch { /* ignore */ }
	}
	await ensureMigrationSentinel(snapshotPath);
}

async function ensureMigrationSentinel(snapshotPath: string): Promise<void> {
	const migrationPath = path.join(path.dirname(snapshotPath), SNAPSHOT_MIGRATION_FILENAME);
	if (fs.existsSync(migrationPath)) return;
	const migrationTempPath = `${migrationPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
	try {
		await fs.promises.writeFile(migrationTempPath, 'migrated\n', 'utf8');
		await fs.promises.rename(migrationTempPath, migrationPath);
	} catch { /* a valid primary snapshot makes migration-marker retry safe */ }
	finally { try { await fs.promises.rm(migrationTempPath, { force: true }); } catch { /* ignore */ } }
}

async function withSnapshotLock<T>(
	context: AccountMapContext,
	action: (snapshot: AccountMapSnapshot, snapshotPath?: string) => Promise<T>,
	minimumRecoveryVersion = 1,
	recoverMissing = false,
): Promise<T> {
	const resolved = snapshotPaths(context);
	const legacy = normalizeMap(context.globalState.get<unknown>(STORAGE_KEY));
	if (!resolved) return action(emptySnapshot(legacy));
	await fs.promises.mkdir(path.dirname(resolved.snapshotPath), { recursive: true });
	const release = await lockfile.lock(resolved.lockTarget, {
		realpath: false,
		stale: LOCK_STALE_MS,
		update: 5_000,
		retries: { retries: 100, factor: 1, minTimeout: 25, maxTimeout: 25 },
	});
	try {
		const migrationCompleted = fs.existsSync(resolved.migrationPath);
		const snapshot = await readSnapshotFile(resolved.snapshotPath, legacy, minimumRecoveryVersion, recoverMissing || migrationCompleted);
		if (fs.existsSync(resolved.snapshotPath)) await ensureMigrationSentinel(resolved.snapshotPath);
		return await action(snapshot, resolved.snapshotPath);
	} finally {
		await release();
	}
}

export async function readCurrentSqlServerAccountMap(context: AccountMapContext): Promise<Record<string, string>> {
	const resolved = snapshotPaths(context);
	if (!resolved) return normalizeMap(context.globalState.get<unknown>(STORAGE_KEY));
	return withSnapshotLock(context, async snapshot => snapshot.accountsByServer, Date.now(), true);
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
		const established = snapshot.accountsByServer[server];
		if (established) return established;
		const nextMap = { ...snapshot.accountsByServer, [server]: candidate };
		const next: AccountMapSnapshot = {
			schemaVersion: SNAPSHOT_SCHEMA_VERSION,
			version: snapshot.version + 1,
			accountsByServer: nextMap,
		};
		if (snapshotPath) await writeSnapshotFile(snapshotPath, next);
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
	return withSnapshotLock(context, async snapshot => snapshot.accountsByServer[server] === expected, Date.now(), true);
}

export async function setCanonicalSqlServerAccount(context: AccountMapContext, serverUrl: string, accountId?: string): Promise<void> {
	const server = normalizeServerUrl(serverUrl);
	if (!server) return;
	await withSnapshotLock(context, async (snapshot, snapshotPath) => {
		const nextMap = { ...snapshot.accountsByServer };
		const account = String(accountId || '').trim();
		if (account) nextMap[server] = account;
		else delete nextMap[server];
		if (JSON.stringify(nextMap) === JSON.stringify(snapshot.accountsByServer)) {
			try { await context.globalState.update(STORAGE_KEY, nextMap); } catch {
				if (!snapshotPath) throw new Error('Failed to persist SQL server account mapping.');
			}
			return;
		}
		const next: AccountMapSnapshot = {
			schemaVersion: SNAPSHOT_SCHEMA_VERSION,
			version: snapshot.version + 1,
			accountsByServer: nextMap,
		};
		if (snapshotPath) await writeSnapshotFile(snapshotPath, next);
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
			const authType = String(connection.authType || '').trim().toLowerCase();
			const pendingAadPrincipal = expectedPrincipalFingerprint === 'aad-pending'
				&& authType === 'aad'
				&& !snapshot.accountsByServer[normalizeServerUrl(connection.serverUrl)];
			if (!pendingAadPrincipal && (!expectedPrincipalFingerprint
				|| principalFingerprint(connection, snapshot.accountsByServer) !== expectedPrincipalFingerprint)) {
				throw new Error('SQL principal changed before canonical dispatch admission.');
			}
			return startSqlDispatch(dispatch);
		}, this.snapshot.version + 1, true);
	}

	async prepareSnapshotDispatch<T>(
		prepare: (snapshot: { accountsByServer: Readonly<Record<string, string>>; version: number }) => SqlDispatchHandle<T>,
	): Promise<SqlDispatchHandle<T>> {
		await this.readyPromise;
		return withSnapshotLock(this.context, async snapshot => prepare({
			accountsByServer: { ...snapshot.accountsByServer },
			version: snapshot.version,
		}), this.snapshot.version + 1, true);
	}

	async runWithSnapshotLock<T>(
		run: (snapshot: { accountsByServer: Readonly<Record<string, string>>; version: number }) => Promise<T>,
	): Promise<T> {
		await this.readyPromise;
		return withSnapshotLock(this.context, async snapshot => run({
			accountsByServer: { ...snapshot.accountsByServer },
			version: snapshot.version,
		}), this.snapshot.version + 1, true);
	}

	async refresh(): Promise<Record<string, string>> {
		await this.readyPromise;
		if (!this.snapshotPath) return this.getAccountsByServer();
		await withSnapshotLock(this.context, snapshot => this.applySnapshot(snapshot), this.snapshot.version + 1, true);
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
				await writeSnapshotFile(snapshotPath, current);
			}
			await this.applySnapshot(current, false);
		});
	}

	private async applySnapshot(snapshot: AccountMapSnapshot, emit = true): Promise<void> {
		if (snapshot.version < this.snapshot.version) return;
		const previous = this.snapshot.accountsByServer;
		const changedServerUrls = [...new Set([...Object.keys(previous), ...Object.keys(snapshot.accountsByServer)])]
			.filter(server => previous[server] !== snapshot.accountsByServer[server]);
		if (snapshot.version === this.snapshot.version && changedServerUrls.length === 0) return;
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
