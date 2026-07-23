import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { sqlConnectionServerSignature, sqlConnectionTargetSignature } from '../shared/sqlConnectionIdentity';
import { quarantineCorruptSqlStateFile } from './sql/sqlStateFile';
import type { SqlDispatchHandle } from './sql/sqlDispatch';
import {
	atomicReplaceSqlStateFile,
	readCommittedSqlStateBackup,
	readRecoverableSqlStateSnapshot,
	type SqlStateLockOptions,
	withSqlStateFileLock,
	writeRecoverableSqlStateSnapshot,
} from './sql/sqlStateTransaction';

export interface SqlConnection {
	id: string;
	name: string;
	dialect: string;
	serverUrl: string;
	port?: number;
	database?: string;
	authType: string;
	username?: string;
	credentialRevision?: number;
}

const STORAGE_KEYS = {
	connections: 'sql.connections',
	passwordPrefix: 'sql.password.',
} as const;

const SNAPSHOT_SCHEMA_VERSION = 1;
const SNAPSHOT_FILENAME = 'sql-connections.v1.json';
const SNAPSHOT_BACKUP_FILENAME = 'sql-connections.backup.v1.json';
const SNAPSHOT_COMMIT_FILENAME = 'sql-connections.commit.v1.json';
const SNAPSHOT_MIGRATION_FILENAME = 'sql-connections-migrated.v1';
const ORPHAN_CLEANUP_FILENAME = 'sql-orphan-secret-cleanup.v1.json';
const LOCK_STALE_MS = 30_000;
const MUTATION_LEASE_MS = 2 * 60_000;

type MutationLease = {
	operationId: string;
	expiresAt: number;
	failed?: boolean;
};

type ConnectionSnapshot = {
	schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
	version: number;
	connections: SqlConnection[];
	mutationLeases: Record<string, MutationLease>;
};

type MemoryRuntime = {
	tail: Promise<void>;
	snapshot?: ConnectionSnapshot;
};

const memoryRuntimeByGlobalState = new WeakMap<object, MemoryRuntime>();

function memoryRuntime(globalState: object): MemoryRuntime {
	let runtime = memoryRuntimeByGlobalState.get(globalState);
	if (!runtime) {
		runtime = { tail: Promise.resolve() };
		memoryRuntimeByGlobalState.set(globalState, runtime);
	}
	return runtime;
}

function normalizeConnection(value: unknown): SqlConnection | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
	const candidate = value as Partial<SqlConnection>;
	const id = String(candidate.id || '').trim();
	const name = String(candidate.name || '').trim();
	const dialect = String(candidate.dialect || '').trim();
	const serverUrl = String(candidate.serverUrl || '').trim();
	const authType = String(candidate.authType || '').trim();
	if (!id || !name || !dialect || !serverUrl || !authType) return undefined;
	return {
		id,
		name,
		dialect,
		serverUrl,
		...(typeof candidate.port === 'number' && Number.isFinite(candidate.port) ? { port: candidate.port } : {}),
		...(typeof candidate.database === 'string' && candidate.database ? { database: candidate.database } : {}),
		authType,
		...(typeof candidate.username === 'string' ? { username: candidate.username } : {}),
		...(typeof candidate.credentialRevision === 'number' && Number.isSafeInteger(candidate.credentialRevision) && candidate.credentialRevision > 0
			? { credentialRevision: candidate.credentialRevision }
			: {}),
	};
}

function parseCanonicalConnection(value: unknown): SqlConnection | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
	const candidate = value as Partial<SqlConnection>;
	if (typeof candidate.id !== 'string' || !candidate.id.trim()
		|| typeof candidate.name !== 'string' || !candidate.name.trim()
		|| typeof candidate.dialect !== 'string' || !candidate.dialect.trim()
		|| typeof candidate.serverUrl !== 'string' || !candidate.serverUrl.trim()
		|| typeof candidate.authType !== 'string' || !candidate.authType.trim()) return undefined;
	if (candidate.port !== undefined
		&& (typeof candidate.port !== 'number' || !Number.isSafeInteger(candidate.port)
			|| candidate.port <= 0 || candidate.port > 65_535)) return undefined;
	if (candidate.database !== undefined && (typeof candidate.database !== 'string' || !candidate.database)) return undefined;
	if (candidate.username !== undefined && typeof candidate.username !== 'string') return undefined;
	if (candidate.credentialRevision !== undefined
		&& (typeof candidate.credentialRevision !== 'number' || !Number.isSafeInteger(candidate.credentialRevision)
			|| candidate.credentialRevision <= 0)) return undefined;
	return {
		id: candidate.id.trim(),
		name: candidate.name.trim(),
		dialect: candidate.dialect.trim(),
		serverUrl: candidate.serverUrl.trim(),
		...(candidate.port !== undefined ? { port: candidate.port } : {}),
		...(candidate.database !== undefined ? { database: candidate.database } : {}),
		authType: candidate.authType.trim(),
		...(candidate.username !== undefined ? { username: candidate.username } : {}),
		...(candidate.credentialRevision !== undefined ? { credentialRevision: candidate.credentialRevision } : {}),
	};
}

function validateConnectionForWrite(value: unknown): SqlConnection {
	const connection = parseCanonicalConnection(value);
	if (!connection) throw new Error('SQL connection fields are invalid. Use strings for connection text and a port between 1 and 65535.');
	return connection;
}

function normalizeConnections(value: unknown): SqlConnection[] {
	if (!Array.isArray(value)) return [];
	const byId = new Map<string, SqlConnection>();
	for (const candidate of value) {
		const connection = normalizeConnection(candidate);
		if (connection) byId.set(connection.id, connection);
	}
	return [...byId.values()];
}

function parseSnapshot(value: unknown, fallbackConnections: readonly SqlConnection[] = []): ConnectionSnapshot {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return { schemaVersion: SNAPSHOT_SCHEMA_VERSION, version: 0, connections: [...fallbackConnections], mutationLeases: {} };
	}
	const candidate = value as Partial<ConnectionSnapshot>;
	if (candidate.schemaVersion !== SNAPSHOT_SCHEMA_VERSION || !Number.isSafeInteger(candidate.version) || Number(candidate.version) < 0) {
		return { schemaVersion: SNAPSHOT_SCHEMA_VERSION, version: 0, connections: [...fallbackConnections], mutationLeases: {} };
	}
	const mutationLeases: Record<string, MutationLease> = {};
	if (candidate.mutationLeases && typeof candidate.mutationLeases === 'object' && !Array.isArray(candidate.mutationLeases)) {
		for (const [connectionId, value] of Object.entries(candidate.mutationLeases)) {
			if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
			const lease = value as Partial<MutationLease>;
			const operationId = String(lease.operationId || '').trim();
			const expiresAt = Number(lease.expiresAt || 0);
			if (connectionId.trim() && operationId && Number.isFinite(expiresAt)) {
				mutationLeases[connectionId] = { operationId, expiresAt, ...(lease.failed === true ? { failed: true } : {}) };
			}
		}
	}
	return {
		schemaVersion: SNAPSHOT_SCHEMA_VERSION,
		version: Number(candidate.version),
		connections: normalizeConnections(candidate.connections),
		mutationLeases,
	};
}

function parseCanonicalSnapshot(value: unknown): ConnectionSnapshot | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
	const candidate = value as Partial<ConnectionSnapshot>;
	if (candidate.schemaVersion !== SNAPSHOT_SCHEMA_VERSION
		|| !Number.isSafeInteger(candidate.version) || Number(candidate.version) < 0
		|| !Array.isArray(candidate.connections)
		|| !candidate.mutationLeases || typeof candidate.mutationLeases !== 'object' || Array.isArray(candidate.mutationLeases)) return undefined;
	const connections: SqlConnection[] = [];
	const seenIds = new Set<string>();
	for (const value of candidate.connections) {
		const connection = parseCanonicalConnection(value);
		if (!connection || seenIds.has(connection.id)) return undefined;
		seenIds.add(connection.id);
		connections.push(connection);
	}
	for (const [connectionId, value] of Object.entries(candidate.mutationLeases)) {
		if (!connectionId.trim() || !value || typeof value !== 'object' || Array.isArray(value)) return undefined;
		const lease = value as Partial<MutationLease>;
		if (typeof lease.operationId !== 'string' || !lease.operationId.trim()
			|| typeof lease.expiresAt !== 'number' || !Number.isFinite(lease.expiresAt)
			|| (lease.failed !== undefined && typeof lease.failed !== 'boolean')) return undefined;
	}
	return {
		schemaVersion: SNAPSHOT_SCHEMA_VERSION,
		version: Number(candidate.version),
		connections,
		mutationLeases: Object.fromEntries(Object.entries(candidate.mutationLeases).map(([connectionId, value]) => {
			const lease = value as MutationLease;
			return [connectionId, {
				operationId: lease.operationId.trim(), expiresAt: lease.expiresAt,
				...(lease.failed !== undefined ? { failed: lease.failed } : {}),
			}];
		})),
	};
}

function activeLeases(snapshot: ConnectionSnapshot, now = Date.now()): Record<string, MutationLease> {
	return Object.fromEntries(Object.entries(snapshot.mutationLeases).filter(([, lease]) => lease.failed === true || lease.expiresAt > now));
}

function sameConnections(left: readonly SqlConnection[], right: readonly SqlConnection[]): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function sqlCredentialIdentity(connection: SqlConnection): string {
	return JSON.stringify({
		dialect: String(connection.dialect || '').trim().toLowerCase(),
		server: sqlConnectionServerSignature(connection),
		authType: String(connection.authType || '').trim().toLowerCase(),
		username: String(connection.username || '').trim(),
	});
}

export class SqlConnectionManager implements vscode.Disposable {
	private connections: SqlConnection[] = [];
	private snapshotVersion = 0;
	private mutationTail: Promise<void> = Promise.resolve();
	private readonly changeEmitter = new vscode.EventEmitter<readonly SqlConnection[]>();
	readonly onDidChangeConnections = this.changeEmitter.event;
	private readonly snapshotPath: string | undefined;
	private readonly snapshotBackupPath: string | undefined;
	private readonly snapshotCommitPath: string | undefined;
	private readonly snapshotMigrationPath: string | undefined;
	private readonly lockTarget: string | undefined;
	private readonly orphanCleanupPath: string | undefined;
	private readonly readyPromise: Promise<void>;
	private disposed = false;

	constructor(private readonly context: vscode.ExtensionContext) {
		this.connections = normalizeConnections(context.globalState.get<unknown>(STORAGE_KEYS.connections));
		const storageRoot = String(context.globalStorageUri?.fsPath || '').trim();
		this.snapshotPath = storageRoot ? path.join(storageRoot, SNAPSHOT_FILENAME) : undefined;
		this.snapshotBackupPath = storageRoot ? path.join(storageRoot, SNAPSHOT_BACKUP_FILENAME) : undefined;
		this.snapshotCommitPath = storageRoot ? path.join(storageRoot, SNAPSHOT_COMMIT_FILENAME) : undefined;
		this.snapshotMigrationPath = storageRoot ? path.join(storageRoot, SNAPSHOT_MIGRATION_FILENAME) : undefined;
		this.lockTarget = this.snapshotPath ? `${this.snapshotPath}.write` : undefined;
		this.orphanCleanupPath = storageRoot ? path.join(storageRoot, ORPHAN_CLEANUP_FILENAME) : undefined;
		this.readyPromise = this.initialize();
		if (this.snapshotPath) {
			fs.watchFile(this.snapshotPath, { interval: 250, persistent: false }, () => {
				void this.refresh().catch(() => undefined);
			});
		}
	}

	ready(): Promise<void> {
		return this.readyPromise;
	}

	getConnections(): SqlConnection[] {
		return this.connections.map(connection => ({ ...connection }));
	}

	getVersion(): number {
		return this.snapshotVersion;
	}

	getConnection(id: string): SqlConnection | undefined {
		const connection = this.connections.find(candidate => candidate.id === id);
		return connection ? { ...connection } : undefined;
	}

	async addConnection(connection: Omit<SqlConnection, 'id'>, password?: string): Promise<SqlConnection> {
		const authType = String(connection.authType || '').trim().toLowerCase();
		const suppliedPassword: unknown = password;
		if (authType === 'sql-login' && !String(connection.username || '').trim()) {
			throw new Error('A non-empty username is required for SQL Login.');
		}
		if (authType === 'sql-login' && (typeof suppliedPassword !== 'string' || suppliedPassword.length === 0)) {
			throw new Error('A non-empty password is required for SQL Login.');
		}
		if (authType !== 'sql-login' && suppliedPassword !== undefined) {
			throw new Error('Passwords can only be stored for SQL Login connections.');
		}
		return this.enqueueMutation(async () => this.withSnapshotLock(async current => {
			const newConnection = validateConnectionForWrite({
				...connection,
				id: `sql_${crypto.randomUUID()}`,
				...(authType === 'sql-login' ? { credentialRevision: 1 } : {}),
			});
			const leased = await this.publishLeases(current, [newConnection.id], crypto.randomUUID());
			let passwordWriteAttempted = false;
			try {
				if (password !== undefined && password !== null) {
					passwordWriteAttempted = true;
					await this.storePasswordRaw(newConnection.id, password);
				}
				await this.commitSnapshot(this.nextSnapshot(leased, [...leased.connections, newConnection], [newConnection.id]));
				return { ...newConnection };
			} catch (error) {
				if (passwordWriteAttempted) {
					try {
						await this.deletePasswordRaw(newConnection.id);
					} catch {
						await this.markLeaseFailed(leased, [newConnection.id]);
						await this.addOrphanCleanupId(newConnection.id);
						throw error;
					}
				}
				await this.rollbackSnapshot(leased, current, [newConnection.id]);
				throw error;
			}
		}));
	}

	async updateConnection(id: string, updates: Partial<Omit<SqlConnection, 'id'>>): Promise<void> {
		await this.updateConnectionAndPassword(id, updates);
	}

	async updateConnectionAndPassword(id: string, updates: Partial<Omit<SqlConnection, 'id'>>, password?: string): Promise<void> {
		await this.enqueueMutation(async () => this.withSnapshotLock(async current => {
			const index = current.connections.findIndex(connection => connection.id === id);
			if (index === -1) return;
			const previousConnection = current.connections[index];
			const proposedConnection: SqlConnection = { ...previousConnection, ...updates, id };
			const previousAuthType = String(previousConnection.authType || '').trim().toLowerCase();
			const nextAuthType = String(proposedConnection.authType || '').trim().toLowerCase();
			const suppliedPassword: unknown = password;
			const validReplacementPassword = typeof suppliedPassword === 'string' && suppliedPassword.length > 0;
			if (nextAuthType === 'sql-login' && !String(proposedConnection.username || '').trim()) {
				throw new Error('A non-empty username is required for SQL Login.');
			}
			if (nextAuthType === 'sql-login' && suppliedPassword !== undefined && !validReplacementPassword) {
				throw new Error('A replacement SQL Login password must be non-empty.');
			}
			if (nextAuthType !== 'sql-login' && suppliedPassword !== undefined) {
				throw new Error('Passwords can only be stored for SQL Login connections.');
			}
			const enteringOrChangingSqlLogin = nextAuthType === 'sql-login'
				&& (previousAuthType !== 'sql-login' || sqlCredentialIdentity(previousConnection) !== sqlCredentialIdentity(proposedConnection));
			if (enteringOrChangingSqlLogin && !validReplacementPassword) {
				throw new Error('Enter a replacement password when changing the SQL Login server, port, username, dialect, or authentication mode.');
			}
			const removeStoredPassword = nextAuthType !== 'sql-login' && previousAuthType === 'sql-login';
			const recoveringFailedLease = current.mutationLeases[id]?.failed === true;
			if (recoveringFailedLease && nextAuthType === 'sql-login' && password === undefined) {
				throw new Error('SQL credentials are in an uncertain state. Enter a replacement password or delete the connection.');
			}
			const mutatesPassword = password !== undefined || removeStoredPassword;
			const nextConnection = validateConnectionForWrite(mutatesPassword
				? { ...proposedConnection, credentialRevision: (previousConnection.credentialRevision ?? 0) + 1 }
				: proposedConnection);
			const previousPassword = mutatesPassword ? await this.readPasswordRaw(id) : undefined;
			const leased = await this.publishLeases(current, [id], crypto.randomUUID());
			let passwordAttempted = false;
			try {
				if (nextAuthType === 'sql-login' && password !== undefined) {
					passwordAttempted = true;
					await this.storePasswordRaw(id, password);
				} else if (removeStoredPassword) {
					passwordAttempted = true;
					await this.deletePasswordRaw(id);
				}
				const nextConnections = [...leased.connections];
				nextConnections[index] = nextConnection;
				await this.commitSnapshot(this.nextSnapshot(leased, nextConnections, [id]));
			} catch (error) {
				if (recoveringFailedLease) {
					await this.markLeaseFailed(leased, [id]);
					throw error;
				}
				if (passwordAttempted && !await this.restorePassword(id, previousPassword)) {
					await this.markLeaseFailed(leased, [id]);
					throw error;
				}
				await this.rollbackSnapshot(leased, current, [id]);
				throw error;
			}
		}));
	}

	async removeConnection(id: string): Promise<void> {
		await this.enqueueMutation(async () => this.withSnapshotLock(async current => {
			if (!current.connections.some(connection => connection.id === id)) return;
			const preservingFailedLease = current.mutationLeases[id]?.failed === true;
			const previousPassword = await this.readPasswordRaw(id);
			const leased = await this.publishLeases(current, [id], crypto.randomUUID());
			let passwordDeletionAttempted = false;
			try {
				passwordDeletionAttempted = true;
				await this.deletePasswordRaw(id);
				await this.commitSnapshot(this.nextSnapshot(leased, leased.connections.filter(connection => connection.id !== id), [id]));
			} catch (error) {
				const passwordRestoreFailed = passwordDeletionAttempted && !await this.restorePassword(id, previousPassword);
				if (preservingFailedLease || passwordRestoreFailed) {
					await this.markLeaseFailed(leased, [id]);
					throw error;
				}
				await this.rollbackSnapshot(leased, current, [id]);
				throw error;
			}
		}));
	}

	async clearConnections(): Promise<number> {
		return this.enqueueMutation(async () => this.withSnapshotLock(async current => {
			const ids = current.connections.map(connection => connection.id);
			const preservingFailedLeaseIds = ids.filter(id => current.mutationLeases[id]?.failed === true);
			if (ids.length === 0) return 0;
			const passwords = new Map<string, string | undefined>();
			for (const id of ids) passwords.set(id, await this.readPasswordRaw(id));
			const leased = await this.publishLeases(current, ids, crypto.randomUUID());
			try {
				for (const id of ids) await this.deletePasswordRaw(id);
				await this.commitSnapshot(this.nextSnapshot(leased, [], ids));
				return ids.length;
			} catch (error) {
				const failedRestores: string[] = [];
				for (const [id, previousPassword] of passwords) {
					if (!await this.restorePassword(id, previousPassword)) failedRestores.push(id);
				}
				const failedLeaseIds = [...new Set([...preservingFailedLeaseIds, ...failedRestores])];
				if (failedLeaseIds.length > 0) {
					await this.markLeaseFailed(leased, failedLeaseIds);
					throw error;
				}
				await this.rollbackSnapshot(leased, current, ids);
				throw error;
			}
		}));
	}

	async assertConnectionCurrent(connection: SqlConnection): Promise<void> {
		await this.readyPromise;
		await this.withSnapshotLock(async snapshot => {
			this.assertSnapshotOwner(snapshot, connection);
		});
	}

	async prepareDispatchCurrent<T>(
		connection: SqlConnection,
		prepare: () => Promise<SqlDispatchHandle<T>>,
	): Promise<SqlDispatchHandle<T>> {
		await this.readyPromise;
		return this.withSnapshotLock(async snapshot => {
			this.assertSnapshotOwner(snapshot, connection);
			return await prepare();
		});
	}

	async prepareSnapshotDispatch<T>(
		prepare: (snapshot: { connections: readonly SqlConnection[]; version: number }) => Promise<SqlDispatchHandle<T>>,
		lockOptions: SqlStateLockOptions = {},
	): Promise<SqlDispatchHandle<T>> {
		await this.readyPromise;
		return this.withSnapshotLock(async snapshot => prepare({
			connections: snapshot.connections.map(connection => ({ ...connection })),
			version: snapshot.version,
		}), false, false, lockOptions);
	}

	async awaitSnapshotLockReady(): Promise<void> {
		await this.readyPromise;
		if (!this.lockTarget) return;
		await withSqlStateFileLock(this.lockTarget, async () => undefined, {
			staleMs: LOCK_STALE_MS,
			retryUntilStale: true,
		});
	}

	async runWithSnapshotLock<T>(
		run: (snapshot: { connections: readonly SqlConnection[]; version: number }) => Promise<T>,
		lockOptions: SqlStateLockOptions = {},
	): Promise<T> {
		await this.readyPromise;
		return this.withSnapshotLock(async snapshot => run({
			connections: snapshot.connections.map(connection => ({ ...connection })),
			version: snapshot.version,
		}), false, false, lockOptions);
	}

	async getPasswordForConnection(connection: SqlConnection): Promise<string | undefined> {
		await this.readyPromise;
		return this.withSnapshotLock(async snapshot => {
			this.assertSnapshotOwner(snapshot, connection);
			return this.readPasswordRaw(connection.id);
		});
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		if (this.snapshotPath) fs.unwatchFile(this.snapshotPath);
		this.changeEmitter.dispose();
	}

	private async initialize(): Promise<void> {
		await this.withSnapshotLock(async snapshot => {
			let current = snapshot;
			const orphanJournalIds = await this.readOrphanCleanupIds();
			const orphanedFailedLeaseIds = [...new Set([...Object.entries(current.mutationLeases)
				.filter(([connectionId, lease]) => lease.failed === true && !current.connections.some(connection => connection.id === connectionId))
				.map(([connectionId]) => connectionId), ...orphanJournalIds])];
			const remainingOrphanIds = new Set(orphanJournalIds);
			for (const connectionId of orphanedFailedLeaseIds) {
				try {
					await this.deletePasswordRaw(connectionId);
					remainingOrphanIds.delete(connectionId);
					const mutationLeases = { ...current.mutationLeases };
					delete mutationLeases[connectionId];
					current = { ...current, version: current.version + 1, mutationLeases };
				} catch { /* keep the failed cleanup tombstone */ }
			}
			await this.writeOrphanCleanupIds([...remainingOrphanIds]);
			if (snapshot.version === 0 && this.snapshotPath) {
				current = { ...snapshot, version: 1, connections: snapshot.connections.length > 0 ? snapshot.connections : [...this.connections] };
			}
			if (current !== snapshot) {
				await this.writeSnapshotFile(current);
				try { await this.mirrorConnections(current.connections); } catch { /* canonical file is authoritative */ }
			} else if (this.snapshotPath) {
				await this.writeSnapshotFile(current);
			}
			this.applySnapshot(current);
		}, true, true);
	}

	private async refresh(): Promise<void> {
		await this.readyPromise;
		await this.withSnapshotLock(async snapshot => {
			let current = snapshot;
			if (snapshot.version === 0 && this.snapshotPath) {
				current = { ...snapshot, version: Math.max(1, this.snapshotVersion + 1), connections: snapshot.connections.length > 0 ? snapshot.connections : this.connections };
				await this.writeSnapshotFile(current);
			}
			this.applySnapshot(current);
		});
	}

	private assertSnapshotOwner(snapshot: ConnectionSnapshot, connection: SqlConnection): void {
		const lease = snapshot.mutationLeases[connection.id];
		if (lease && lease.expiresAt > Date.now()) throw new Error('SQL connection is changing. Retry when the update completes.');
		const current = snapshot.connections.find(candidate => candidate.id === connection.id);
		if (!current || sqlConnectionTargetSignature(current) !== sqlConnectionTargetSignature(connection)) {
			throw new Error('SQL connection changed while credentials were being resolved.');
		}
	}

	private nextSnapshot(snapshot: ConnectionSnapshot, connections: readonly SqlConnection[], releaseIds: readonly string[]): ConnectionSnapshot {
		const mutationLeases = activeLeases(snapshot);
		for (const id of releaseIds) delete mutationLeases[id];
		return {
			schemaVersion: SNAPSHOT_SCHEMA_VERSION,
			version: snapshot.version + 1,
			connections: connections.map(connection => ({ ...connection })),
			mutationLeases,
		};
	}

	private async publishLeases(snapshot: ConnectionSnapshot, connectionIds: readonly string[], operationId: string): Promise<ConnectionSnapshot> {
		const mutationLeases = activeLeases(snapshot);
		for (const connectionId of connectionIds) {
			if (mutationLeases[connectionId] && mutationLeases[connectionId].failed !== true) {
				throw new Error('SQL connection is already changing in another window.');
			}
			mutationLeases[connectionId] = { operationId, expiresAt: Date.now() + MUTATION_LEASE_MS };
		}
		const leased: ConnectionSnapshot = { ...snapshot, version: snapshot.version + 1, mutationLeases };
		await this.writeSnapshotFile(leased);
		this.applySnapshot(leased);
		return leased;
	}

	private async commitSnapshot(snapshot: ConnectionSnapshot): Promise<void> {
		await this.writeSnapshotFile(snapshot);
		try { await this.mirrorConnections(snapshot.connections); } catch (error) {
			if (!this.snapshotPath) throw error;
		}
		this.applySnapshot(snapshot);
	}

	private async markLeaseFailed(snapshot: ConnectionSnapshot, connectionIds: readonly string[]): Promise<void> {
		const mutationLeases = activeLeases(snapshot);
		for (const connectionId of connectionIds) {
			const existing = mutationLeases[connectionId];
			if (existing) mutationLeases[connectionId] = { ...existing, failed: true, expiresAt: Number.MAX_SAFE_INTEGER };
		}
		const blocked = { ...snapshot, version: snapshot.version + 1, mutationLeases };
		await this.writeSnapshotFile(blocked);
		this.applySnapshot(blocked);
	}

	private async rollbackSnapshot(leased: ConnectionSnapshot, previous: ConnectionSnapshot, releaseIds: readonly string[]): Promise<void> {
		const base = { ...previous, version: Math.max(previous.version, leased.version) };
		const rollback = this.nextSnapshot(base, previous.connections, releaseIds);
		try {
			await this.writeSnapshotFile(rollback);
			await this.mirrorConnections(rollback.connections);
			this.applySnapshot(rollback);
		} catch { /* mutation error remains primary; expired leases recover */ }
	}

	private applySnapshot(snapshot: ConnectionSnapshot): void {
		if (snapshot.version < this.snapshotVersion) return;
		const changed = !sameConnections(this.connections, snapshot.connections);
		this.snapshotVersion = snapshot.version;
		this.connections = snapshot.connections.map(connection => ({ ...connection }));
		if (changed && !this.disposed) this.changeEmitter.fire(this.getConnections());
	}

	private failSurvivingMutationLeases(snapshot: ConnectionSnapshot): ConnectionSnapshot {
		let changed = false;
		const mutationLeases = Object.fromEntries(Object.entries(snapshot.mutationLeases).map(([connectionId, lease]) => {
			if (lease.failed === true && lease.expiresAt === Number.MAX_SAFE_INTEGER) return [connectionId, lease];
			changed = true;
			return [connectionId, { ...lease, failed: true, expiresAt: Number.MAX_SAFE_INTEGER }];
		}));
		return changed ? { ...snapshot, version: snapshot.version + 1, mutationLeases } : snapshot;
	}

	private async withSnapshotLock<T>(
		action: (snapshot: ConnectionSnapshot) => Promise<T>,
		allowLegacyMigration = false,
		retryUntilStale = false,
		lockOptions: SqlStateLockOptions = {},
	): Promise<T> {
		if (this.snapshotPath && this.lockTarget) {
			return withSqlStateFileLock(this.lockTarget, async () => {
				const snapshot = await this.readSnapshot(allowLegacyMigration);
				const recovered = this.failSurvivingMutationLeases(snapshot);
				if (recovered !== snapshot) {
					await this.writeSnapshotFile(recovered);
					this.applySnapshot(recovered);
				}
				return await action(recovered);
			}, { staleMs: LOCK_STALE_MS, retryUntilStale, ...lockOptions });
		}
		const runtime = memoryRuntime(this.context.globalState as object);
		const previous = runtime.tail;
		let result!: T;
		const current = previous.catch(() => undefined).then(async () => {
			const fallback = normalizeConnections(this.context.globalState.get<unknown>(STORAGE_KEYS.connections));
			result = await action(runtime.snapshot ?? parseSnapshot(undefined, fallback));
		});
		runtime.tail = current.then(() => undefined, () => undefined);
		await current;
		return result;
	}

	private async readSnapshot(allowLegacyMigration = false): Promise<ConnectionSnapshot> {
		if (!this.snapshotPath) {
			const runtime = memoryRuntime(this.context.globalState as object);
			return runtime.snapshot ?? parseSnapshot(undefined, normalizeConnections(this.context.globalState.get<unknown>(STORAGE_KEYS.connections)));
		}
		if (!this.snapshotBackupPath || !this.snapshotCommitPath) return this.recoverMissingSnapshot();
		const migrationCompleted = !!this.snapshotMigrationPath && fs.existsSync(this.snapshotMigrationPath);
		const read = await readRecoverableSqlStateSnapshot({
			primaryPath: this.snapshotPath,
			backupPath: this.snapshotBackupPath,
			commitPath: this.snapshotCommitPath,
			parseSnapshot: parseCanonicalSnapshot,
			getIdentity: snapshot => ({ schemaVersion: snapshot.schemaVersion, version: snapshot.version }),
			allowUncommittedPrimary: allowLegacyMigration && !migrationCompleted,
		});
		if (read.kind === 'valid') {
			if (read.source === 'backup') {
				if (read.primaryState === 'invalid') await quarantineCorruptSqlStateFile(this.snapshotPath);
				await this.writeAtomic(this.snapshotPath, read.text);
			}
			return read.value;
		}
		if (read.kind === 'invalid') return this.recoverCorruptSnapshot();
		const committed = await this.readCommittedSnapshotBackup();
		if (committed) {
			await this.writeSnapshotFile(committed);
			return committed;
		}
		if (allowLegacyMigration && !migrationCompleted) {
			const migrated: ConnectionSnapshot = {
				schemaVersion: SNAPSHOT_SCHEMA_VERSION,
				version: 1,
				connections: normalizeConnections(this.context.globalState.get<unknown>(STORAGE_KEYS.connections)),
				mutationLeases: {},
			};
			await this.writeSnapshotFile(migrated);
			return migrated;
		}
		return this.recoverMissingSnapshot();
	}

	private async recoverCorruptSnapshot(): Promise<ConnectionSnapshot> {
		const committed = await this.readCommittedSnapshotBackup();
		if (committed) {
			if (this.snapshotPath) await quarantineCorruptSqlStateFile(this.snapshotPath);
			await this.writeSnapshotFile(committed);
			return committed;
		}
		if (this.snapshotPath) await quarantineCorruptSqlStateFile(this.snapshotPath);
		return this.recoverMissingSnapshot();
	}

	private async recoverMissingSnapshot(): Promise<ConnectionSnapshot> {
		const legacyConnections = normalizeConnections(this.context.globalState.get<unknown>(STORAGE_KEYS.connections));
		const mutationLeases: Record<string, MutationLease> = {};
		for (const connection of legacyConnections) {
			mutationLeases[connection.id] = { operationId: 'missing-snapshot-recovery', expiresAt: Number.MAX_SAFE_INTEGER, failed: true };
		}
		for (const connectionId of await this.readOrphanCleanupIds()) {
			mutationLeases[connectionId] = { operationId: 'orphan-secret-cleanup', expiresAt: Number.MAX_SAFE_INTEGER, failed: true };
		}
		const recovered: ConnectionSnapshot = {
			schemaVersion: SNAPSHOT_SCHEMA_VERSION,
			version: Math.max(Date.now(), this.snapshotVersion + 1),
			connections: [],
			mutationLeases,
		};
		await this.writeSnapshotFile(recovered);
		return recovered;
	}

	private async readCommittedSnapshotBackup(): Promise<ConnectionSnapshot | undefined> {
		if (!this.snapshotBackupPath || !this.snapshotCommitPath) return undefined;
		return readCommittedSqlStateBackup({
			backupPath: this.snapshotBackupPath,
			commitPath: this.snapshotCommitPath,
			parseSnapshot: parseCanonicalSnapshot,
			getIdentity: snapshot => ({ schemaVersion: snapshot.schemaVersion, version: snapshot.version }),
		});
	}

	private async readOrphanCleanupIds(): Promise<string[]> {
		if (!this.orphanCleanupPath) return [];
		try {
			const parsed = JSON.parse(await fs.promises.readFile(this.orphanCleanupPath, 'utf8')) as { connectionIds?: unknown };
			if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.connectionIds)) {
				throw new Error('Invalid SQL orphan-secret cleanup journal.');
			}
			return [...new Set(parsed.connectionIds.map(id => String(id || '').trim()).filter(Boolean))];
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
			try { await quarantineCorruptSqlStateFile(this.orphanCleanupPath); } catch { /* canonical failed leases remain authoritative */ }
			return [];
		}
	}

	private async addOrphanCleanupId(connectionId: string): Promise<void> {
		const ids = new Set(await this.readOrphanCleanupIds());
		ids.add(connectionId);
		await this.writeOrphanCleanupIds([...ids]);
	}

	private async writeOrphanCleanupIds(connectionIds: readonly string[]): Promise<void> {
		if (!this.orphanCleanupPath) return;
		await this.writeAtomic(this.orphanCleanupPath, `${JSON.stringify({ connectionIds: [...new Set(connectionIds)] })}\n`);
	}

	private async writeSnapshotFile(snapshot: ConnectionSnapshot): Promise<void> {
		if (!this.snapshotPath) {
			memoryRuntime(this.context.globalState as object).snapshot = structuredClone(snapshot);
			return;
		}
		if (!this.snapshotBackupPath || !this.snapshotCommitPath || !this.snapshotMigrationPath) return;
		const snapshotText = `${JSON.stringify(snapshot, null, 2)}\n`;
		await writeRecoverableSqlStateSnapshot({
			primaryPath: this.snapshotPath,
			backupPath: this.snapshotBackupPath,
			commitPath: this.snapshotCommitPath,
			migrationPath: this.snapshotMigrationPath,
			text: snapshotText,
			identity: { schemaVersion: snapshot.schemaVersion, version: snapshot.version },
			writeAtomic: (filePath, contents) => this.writeAtomic(filePath, contents),
		});
	}

	private async writeAtomic(filePath: string, contents: string): Promise<void> {
		await atomicReplaceSqlStateFile(filePath, contents);
	}

	private async mirrorConnections(connections: readonly SqlConnection[]): Promise<void> {
		await this.context.globalState.update(STORAGE_KEYS.connections, connections.map(connection => ({ ...connection })));
	}

	private async readPasswordRaw(connectionId: string): Promise<string | undefined> {
		return await this.context.secrets.get(`${STORAGE_KEYS.passwordPrefix}${connectionId}`);
	}

	private async storePasswordRaw(connectionId: string, password: string): Promise<void> {
		await this.context.secrets.store(`${STORAGE_KEYS.passwordPrefix}${connectionId}`, password);
	}

	private async deletePasswordRaw(connectionId: string): Promise<void> {
		await this.context.secrets.delete(`${STORAGE_KEYS.passwordPrefix}${connectionId}`);
	}

	private async restorePassword(connectionId: string, password: string | undefined): Promise<boolean> {
		try {
			if (password === undefined) await this.deletePasswordRaw(connectionId);
			else await this.storePasswordRaw(connectionId, password);
			return true;
		} catch {
			return false;
		}
	}

	private enqueueMutation<T>(mutation: () => Promise<T>): Promise<T> {
		const result = this.mutationTail.catch(() => undefined).then(async () => {
			await this.readyPromise;
			return mutation();
		});
		this.mutationTail = result.then(() => undefined, () => undefined);
		return result;
	}
}
