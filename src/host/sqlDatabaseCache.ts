import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as lockfile from 'proper-lockfile';
import type * as vscode from 'vscode';

import type { SqlConnection } from './sqlConnectionManager';
import { readCurrentSqlSchemaPrincipalFingerprint } from './sqlEditorSchema';
import { sqlConnectionTargetSignature } from '../shared/sqlConnectionIdentity';
import { quarantineCorruptSqlStateFile } from './sql/sqlStateFile';

export const SQL_DATABASE_CACHE_VERSION = 1;
export const SQL_DATABASE_CACHE_STORAGE_KEY = 'sql.connectionManager.cachedDatabases';
const CACHE_LOCK_STALE_MS = 30_000;
const CACHE_BLOCK_LEASE_MS = 2 * 60_000;

type SqlDatabaseCacheContext = Pick<vscode.ExtensionContext, 'globalState'> & {
	globalStorageUri?: vscode.Uri;
};

export type SqlDatabaseCacheRequest = Readonly<{
	connectionId: string;
	requestId: string;
	version: number;
}>;

export type SqlDatabaseCacheEntry = {
	version: typeof SQL_DATABASE_CACHE_VERSION;
	connectionId: string;
	targetSignature: string;
	principalFingerprint: string;
	databases: string[];
	writeId: string;
	requestId: string;
	requestVersion: number;
	updatedAt: number;
};

type SqlDatabaseCacheSnapshot = {
	schemaVersion: typeof SQL_DATABASE_CACHE_VERSION;
	version: number;
	entries: Record<string, SqlDatabaseCacheEntry>;
	latestRequestByConnectionId: Record<string, { requestId: string; version: number }>;
	deletedAtVersionByConnectionId: Record<string, number>;
	blockedAtVersionByConnectionId: Record<string, { version: number; expiresAt: number }>;
	targetSignatureByConnectionId: Record<string, string>;
	principalFingerprintByConnectionId: Record<string, string | null>;
	clearedAtVersion: number;
};

type RuntimeState = {
	version: number;
	writeTails: Map<string, Promise<void>>;
	snapshots: Map<string, SqlDatabaseCacheSnapshot>;
};

const runtimeByGlobalState = new WeakMap<object, RuntimeState>();

function getRuntime(context: SqlDatabaseCacheContext): RuntimeState {
	const key = context.globalState as object;
	let runtime = runtimeByGlobalState.get(key);
	if (!runtime) {
		runtime = { version: 0, writeTails: new Map(), snapshots: new Map() };
		runtimeByGlobalState.set(key, runtime);
	}
	return runtime;
}

function emptySnapshot(): SqlDatabaseCacheSnapshot {
	return {
		schemaVersion: SQL_DATABASE_CACHE_VERSION,
		version: 0,
		entries: {},
		latestRequestByConnectionId: {},
		deletedAtVersionByConnectionId: {},
		blockedAtVersionByConnectionId: {},
		targetSignatureByConnectionId: {},
		principalFingerprintByConnectionId: {},
		clearedAtVersion: 0,
	};
}

function activeBlock(snapshot: SqlDatabaseCacheSnapshot, connectionId: string): { version: number; expiresAt: number } | undefined {
	const block = snapshot.blockedAtVersionByConnectionId[connectionId];
	return block && block.expiresAt > Date.now() ? block : undefined;
}

export function sqlDatabaseTargetSignature(connection: SqlConnection): string {
	return sqlConnectionTargetSignature(connection);
}

function normalizeDatabases(value: unknown): string[] {
	return Array.isArray(value)
		? value.map(database => String(database || '').trim()).filter(Boolean)
		: [];
}

function parseEntry(key: string, value: unknown): SqlDatabaseCacheEntry | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
	const candidate = value as Partial<SqlDatabaseCacheEntry>;
	const connectionId = String(candidate.connectionId || '').trim();
	const targetSignature = String(candidate.targetSignature || '');
	const principalFingerprint = String(candidate.principalFingerprint || '').trim();
	const writeId = String(candidate.writeId || '').trim();
	const requestId = String(candidate.requestId || '').trim();
	if (candidate.version !== SQL_DATABASE_CACHE_VERSION || !connectionId || connectionId !== key
		|| !targetSignature || !principalFingerprint || !writeId || !requestId
		|| !Number.isSafeInteger(candidate.requestVersion) || Number(candidate.requestVersion) <= 0
		|| !Number.isFinite(candidate.updatedAt)) return undefined;
	return {
		version: SQL_DATABASE_CACHE_VERSION,
		connectionId,
		targetSignature,
		principalFingerprint,
		databases: normalizeDatabases(candidate.databases),
		writeId,
		requestId,
		requestVersion: Number(candidate.requestVersion),
		updatedAt: Number(candidate.updatedAt),
	};
}

function parseSnapshot(value: unknown): SqlDatabaseCacheSnapshot {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return emptySnapshot();
	const candidate = value as Partial<SqlDatabaseCacheSnapshot>;
	if (candidate.schemaVersion !== SQL_DATABASE_CACHE_VERSION
		|| !Number.isSafeInteger(candidate.version) || Number(candidate.version) < 0
		|| !candidate.entries || typeof candidate.entries !== 'object' || Array.isArray(candidate.entries)) return emptySnapshot();
	const snapshot = emptySnapshot();
	snapshot.version = Number(candidate.version);
	for (const [connectionId, entryValue] of Object.entries(candidate.entries)) {
		const entry = parseEntry(connectionId, entryValue);
		if (entry) snapshot.entries[connectionId] = entry;
	}
	if (candidate.latestRequestByConnectionId && typeof candidate.latestRequestByConnectionId === 'object' && !Array.isArray(candidate.latestRequestByConnectionId)) {
		for (const [connectionId, requestValue] of Object.entries(candidate.latestRequestByConnectionId)) {
			if (!requestValue || typeof requestValue !== 'object' || Array.isArray(requestValue)) continue;
			const request = requestValue as { requestId?: unknown; version?: unknown };
			const requestId = String(request.requestId || '').trim();
			const version = Number(request.version || 0);
			if (connectionId.trim() && requestId && Number.isSafeInteger(version) && version > 0) {
				snapshot.latestRequestByConnectionId[connectionId] = { requestId, version };
			}
		}
	}
	if (candidate.deletedAtVersionByConnectionId && typeof candidate.deletedAtVersionByConnectionId === 'object' && !Array.isArray(candidate.deletedAtVersionByConnectionId)) {
		for (const [connectionId, versionValue] of Object.entries(candidate.deletedAtVersionByConnectionId)) {
			const version = Number(versionValue || 0);
			if (connectionId.trim() && Number.isSafeInteger(version) && version > 0) snapshot.deletedAtVersionByConnectionId[connectionId] = version;
		}
	}
	if (candidate.blockedAtVersionByConnectionId && typeof candidate.blockedAtVersionByConnectionId === 'object' && !Array.isArray(candidate.blockedAtVersionByConnectionId)) {
		for (const [connectionId, versionValue] of Object.entries(candidate.blockedAtVersionByConnectionId)) {
			if (!versionValue || typeof versionValue !== 'object' || Array.isArray(versionValue)) continue;
			const block = versionValue as { version?: unknown; expiresAt?: unknown };
			const version = Number(block.version || 0);
			const expiresAt = Number(block.expiresAt || 0);
			if (connectionId.trim() && Number.isSafeInteger(version) && version > 0 && Number.isFinite(expiresAt) && expiresAt > 0) {
				snapshot.blockedAtVersionByConnectionId[connectionId] = { version, expiresAt };
			}
		}
	}
	if (candidate.targetSignatureByConnectionId && typeof candidate.targetSignatureByConnectionId === 'object' && !Array.isArray(candidate.targetSignatureByConnectionId)) {
		for (const [connectionId, signatureValue] of Object.entries(candidate.targetSignatureByConnectionId)) {
			const signature = String(signatureValue || '');
			if (connectionId.trim() && signature) snapshot.targetSignatureByConnectionId[connectionId] = signature;
		}
	}
	if (candidate.principalFingerprintByConnectionId && typeof candidate.principalFingerprintByConnectionId === 'object' && !Array.isArray(candidate.principalFingerprintByConnectionId)) {
		for (const [connectionId, fingerprintValue] of Object.entries(candidate.principalFingerprintByConnectionId)) {
			if (!connectionId.trim()) continue;
			if (fingerprintValue === null) snapshot.principalFingerprintByConnectionId[connectionId] = null;
			else {
				const fingerprint = String(fingerprintValue || '').trim();
				if (fingerprint) snapshot.principalFingerprintByConnectionId[connectionId] = fingerprint;
			}
		}
	}
	const clearedAtVersion = Number(candidate.clearedAtVersion || 0);
	snapshot.clearedAtVersion = Number.isSafeInteger(clearedAtVersion) && clearedAtVersion > 0 ? clearedAtVersion : 0;
	return snapshot;
}

export function parseSqlDatabaseCacheStore(value: unknown): Record<string, SqlDatabaseCacheEntry> {
	return parseSnapshot(value).entries;
}

function getSnapshotPath(context: SqlDatabaseCacheContext, storageKey: string): string | undefined {
	const root = String(context.globalStorageUri?.fsPath || '').trim();
	if (!root) return undefined;
	const suffix = crypto.createHash('sha1').update(storageKey, 'utf8').digest('hex').slice(0, 12);
	return path.join(root, `sql-database-cache-${suffix}.v1.json`);
}

async function readDiskSnapshot(snapshotPath: string): Promise<SqlDatabaseCacheSnapshot | undefined> {
	try {
		return parseSnapshot(JSON.parse(await fs.promises.readFile(snapshotPath, 'utf8')));
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined;
		if (!(error instanceof SyntaxError)) throw error;
		await quarantineCorruptSqlStateFile(snapshotPath);
		return emptySnapshot();
	}
}

function readMemorySnapshot(context: SqlDatabaseCacheContext, storageKey: string): SqlDatabaseCacheSnapshot {
	const runtime = getRuntime(context);
	return runtime.snapshots.get(storageKey) ?? parseSnapshot(context.globalState.get<unknown>(storageKey));
}

async function readCurrentSnapshot(context: SqlDatabaseCacheContext, storageKey: string): Promise<SqlDatabaseCacheSnapshot> {
	const snapshotPath = getSnapshotPath(context, storageKey);
	if (snapshotPath) return await readDiskSnapshot(snapshotPath) ?? emptySnapshot();
	return readMemorySnapshot(context, storageKey);
}

function nextVersion(snapshot: SqlDatabaseCacheSnapshot, context: SqlDatabaseCacheContext): number {
	const runtime = getRuntime(context);
	runtime.version = Math.max(runtime.version + 1, snapshot.version + 1);
	return runtime.version;
}

async function writeSnapshot(context: SqlDatabaseCacheContext, storageKey: string, snapshot: SqlDatabaseCacheSnapshot): Promise<void> {
	const snapshotPath = getSnapshotPath(context, storageKey);
	if (snapshotPath) {
		await fs.promises.mkdir(path.dirname(snapshotPath), { recursive: true });
		const tempPath = `${snapshotPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
		await fs.promises.writeFile(tempPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
		try {
			await fs.promises.rename(tempPath, snapshotPath);
		} finally {
			try { await fs.promises.rm(tempPath, { force: true }); } catch { /* ignore */ }
		}
	}
	getRuntime(context).snapshots.set(storageKey, structuredClone(snapshot));
	try { await context.globalState.update(storageKey, snapshot); } catch {
		if (!snapshotPath) throw new Error('Failed to persist SQL database cache snapshot.');
	}
}

async function withSnapshotLock<T>(
	context: SqlDatabaseCacheContext,
	storageKey: string,
	action: (snapshot: SqlDatabaseCacheSnapshot) => Promise<T>,
): Promise<T> {
	const snapshotPath = getSnapshotPath(context, storageKey);
	if (snapshotPath) {
		await fs.promises.mkdir(path.dirname(snapshotPath), { recursive: true });
		const lockTarget = `${snapshotPath}.write`;
		const release = await lockfile.lock(lockTarget, {
			realpath: false,
			stale: CACHE_LOCK_STALE_MS,
			update: 5_000,
			retries: { retries: 100, factor: 1, minTimeout: 25, maxTimeout: 25 },
		});
		try {
			return await action(await readDiskSnapshot(snapshotPath) ?? emptySnapshot());
		} finally {
			await release();
		}
	}
	const runtime = getRuntime(context);
	const previous = runtime.writeTails.get(storageKey) ?? Promise.resolve();
	let result!: T;
	const current = previous.catch(() => undefined).then(async () => {
		result = await action(readMemorySnapshot(context, storageKey));
	});
	runtime.writeTails.set(storageKey, current.then(() => undefined, () => undefined));
	await current;
	return result;
}

export async function beginSqlDatabaseCacheRequest(
	context: SqlDatabaseCacheContext,
	storageKey: string,
	connection: SqlConnection,
): Promise<SqlDatabaseCacheRequest> {
	const id = String(connection.id || '').trim();
	const targetSignature = sqlDatabaseTargetSignature(connection);
	const principalFingerprint = await readCurrentSqlSchemaPrincipalFingerprint(context, connection);
	return withSnapshotLock(context, storageKey, async snapshot => {
		if (activeBlock(snapshot, id)) {
			throw new Error('SQL database requests are blocked while the connection is changing.');
		}
		const currentTargetSignature = snapshot.targetSignatureByConnectionId[id];
		if (currentTargetSignature && currentTargetSignature !== targetSignature) {
			throw new Error('SQL connection target changed in another window.');
		}
		if (Object.prototype.hasOwnProperty.call(snapshot.principalFingerprintByConnectionId, id)) {
			const currentPrincipal = snapshot.principalFingerprintByConnectionId[id];
			if (currentPrincipal === null && principalFingerprint) {
				snapshot.principalFingerprintByConnectionId[id] = principalFingerprint;
				delete snapshot.entries[id];
			} else if (currentPrincipal !== (principalFingerprint ?? null)) {
				throw new Error('SQL connection identity changed in another window.');
			}
		}
		const request: SqlDatabaseCacheRequest = {
			connectionId: id,
			requestId: crypto.randomUUID(),
			version: nextVersion(snapshot, context),
		};
		snapshot.version = request.version;
		snapshot.targetSignatureByConnectionId[id] = targetSignature;
		if (!Object.prototype.hasOwnProperty.call(snapshot.principalFingerprintByConnectionId, id)) {
			snapshot.principalFingerprintByConnectionId[id] = principalFingerprint ?? null;
		}
		snapshot.latestRequestByConnectionId[id] = { requestId: request.requestId, version: request.version };
		await writeSnapshot(context, storageKey, snapshot);
		return Object.freeze(request);
	});
}

function assertRequestCurrent(snapshot: SqlDatabaseCacheSnapshot, request: SqlDatabaseCacheRequest): void {
	const latest = snapshot.latestRequestByConnectionId[request.connectionId];
	if (!latest || latest.requestId !== request.requestId || latest.version !== request.version
		|| request.version <= snapshot.clearedAtVersion
		|| request.version <= (snapshot.deletedAtVersionByConnectionId[request.connectionId] ?? 0)
		|| !!activeBlock(snapshot, request.connectionId)) {
		throw new Error('SQL database request was superseded.');
	}
}

export async function assertSqlDatabaseCacheRequestCurrent(
	context: SqlDatabaseCacheContext,
	storageKey: string,
	request: SqlDatabaseCacheRequest,
): Promise<void> {
	assertRequestCurrent(await readCurrentSnapshot(context, storageKey), request);
}

export async function assertSqlDatabaseCacheTargetCurrent(
	context: SqlDatabaseCacheContext,
	storageKey: string,
	connection: SqlConnection,
): Promise<void> {
	const snapshot = await readCurrentSnapshot(context, storageKey);
	const connectionId = String(connection.id || '').trim();
	const principalFingerprint = await readCurrentSqlSchemaPrincipalFingerprint(context, connection);
	if (activeBlock(snapshot, connectionId)
		|| (snapshot.targetSignatureByConnectionId[connectionId]
			&& snapshot.targetSignatureByConnectionId[connectionId] !== sqlDatabaseTargetSignature(connection))
		|| (Object.prototype.hasOwnProperty.call(snapshot.principalFingerprintByConnectionId, connectionId)
			&& snapshot.principalFingerprintByConnectionId[connectionId] !== (principalFingerprint ?? null))) {
		throw new Error('SQL connection target changed in another window.');
	}
}

export async function getOwnedSqlDatabaseCacheEntry(
	context: SqlDatabaseCacheContext,
	storageKey: string,
	connection: SqlConnection,
): Promise<SqlDatabaseCacheEntry | undefined> {
	const principalFingerprint = await readCurrentSqlSchemaPrincipalFingerprint(context, connection);
	if (!principalFingerprint) return undefined;
	const snapshot = await readCurrentSnapshot(context, storageKey);
	const entry = snapshot.entries[connection.id];
	if (!entry
		|| entry.requestVersion <= snapshot.clearedAtVersion
		|| entry.requestVersion <= (snapshot.deletedAtVersionByConnectionId[connection.id] ?? 0)
		|| !!activeBlock(snapshot, connection.id)
		|| entry.targetSignature !== sqlDatabaseTargetSignature(connection)
		|| entry.principalFingerprint !== principalFingerprint
		|| snapshot.principalFingerprintByConnectionId[connection.id] !== principalFingerprint) return undefined;
	return entry;
}

export async function getOwnedSqlDatabaseLists(
	context: SqlDatabaseCacheContext,
	storageKey: string,
	connections: readonly SqlConnection[],
): Promise<Record<string, string[]>> {
	const lists: Record<string, string[]> = {};
	for (const connection of connections) {
		const entry = await getOwnedSqlDatabaseCacheEntry(context, storageKey, connection);
		if (entry) lists[connection.id] = [...entry.databases];
	}
	return lists;
}

export async function writeOwnedSqlDatabaseCacheEntry(
	context: SqlDatabaseCacheContext,
	storageKey: string,
	connection: SqlConnection,
	principalFingerprint: string,
	databases: readonly string[],
	request: SqlDatabaseCacheRequest,
	assertOwner: () => Promise<void>,
): Promise<void> {
	const writeId = crypto.randomUUID();
	await assertOwner();
	await withSnapshotLock(context, storageKey, async snapshot => {
		assertRequestCurrent(snapshot, request);
		await assertOwner();
		const current = snapshot.entries[connection.id];
		if (current && current.requestVersion > request.version) throw new Error('SQL database cache request is stale.');
		const authoritativePrincipal = snapshot.principalFingerprintByConnectionId[connection.id];
		if (authoritativePrincipal !== null && authoritativePrincipal !== undefined && authoritativePrincipal !== principalFingerprint) {
			throw new Error('SQL database cache principal changed.');
		}
		snapshot.principalFingerprintByConnectionId[connection.id] = principalFingerprint;
		snapshot.entries[connection.id] = {
			version: SQL_DATABASE_CACHE_VERSION,
			connectionId: connection.id,
			targetSignature: sqlDatabaseTargetSignature(connection),
			principalFingerprint,
			databases: normalizeDatabases(databases),
			writeId,
			requestId: request.requestId,
			requestVersion: request.version,
			updatedAt: Date.now(),
		};
		await writeSnapshot(context, storageKey, snapshot);
	});
	try {
		await assertOwner();
		await assertSqlDatabaseCacheRequestCurrent(context, storageKey, request);
	} catch (error) {
		await withSnapshotLock(context, storageKey, async snapshot => {
			if (snapshot.entries[connection.id]?.writeId === writeId) {
				delete snapshot.entries[connection.id];
				await writeSnapshot(context, storageKey, snapshot);
			}
		});
		throw error;
	}
}

export async function deleteSqlDatabaseCacheEntry(
	context: SqlDatabaseCacheContext,
	storageKey: string,
	connectionId: string,
): Promise<void> {
	const id = String(connectionId || '').trim();
	await withSnapshotLock(context, storageKey, async snapshot => {
		const version = nextVersion(snapshot, context);
		snapshot.version = version;
		delete snapshot.entries[id];
		delete snapshot.latestRequestByConnectionId[id];
		delete snapshot.targetSignatureByConnectionId[id];
		delete snapshot.principalFingerprintByConnectionId[id];
		snapshot.deletedAtVersionByConnectionId[id] = version;
		await writeSnapshot(context, storageKey, snapshot);
	});
}

export async function clearSqlDatabaseCacheStore(
	context: SqlDatabaseCacheContext,
	storageKey: string,
): Promise<void> {
	await withSnapshotLock(context, storageKey, async snapshot => {
		const version = nextVersion(snapshot, context);
		snapshot.version = version;
		snapshot.entries = {};
		snapshot.latestRequestByConnectionId = {};
		snapshot.deletedAtVersionByConnectionId = {};
		snapshot.blockedAtVersionByConnectionId = {};
		snapshot.clearedAtVersion = version;
		await writeSnapshot(context, storageKey, snapshot);
	});
}

export async function blockSqlDatabaseCacheConnection(
	context: SqlDatabaseCacheContext,
	storageKey: string,
	connectionId: string,
): Promise<void> {
	const id = String(connectionId || '').trim();
	await withSnapshotLock(context, storageKey, async snapshot => {
		const version = nextVersion(snapshot, context);
		snapshot.version = version;
		delete snapshot.entries[id];
		delete snapshot.latestRequestByConnectionId[id];
		delete snapshot.targetSignatureByConnectionId[id];
		delete snapshot.principalFingerprintByConnectionId[id];
		snapshot.deletedAtVersionByConnectionId[id] = version;
		snapshot.blockedAtVersionByConnectionId[id] = { version, expiresAt: Date.now() + CACHE_BLOCK_LEASE_MS };
		await writeSnapshot(context, storageKey, snapshot);
	});
}

export async function unblockSqlDatabaseCacheConnection(
	context: SqlDatabaseCacheContext,
	storageKey: string,
	connection: SqlConnection,
): Promise<void> {
	const id = String(connection.id || '').trim();
	const principalFingerprint = await readCurrentSqlSchemaPrincipalFingerprint(context, connection);
	await withSnapshotLock(context, storageKey, async snapshot => {
		const version = nextVersion(snapshot, context);
		snapshot.version = version;
		delete snapshot.latestRequestByConnectionId[id];
		delete snapshot.blockedAtVersionByConnectionId[id];
		snapshot.targetSignatureByConnectionId[id] = sqlDatabaseTargetSignature(connection);
		snapshot.principalFingerprintByConnectionId[id] = principalFingerprint ?? null;
		snapshot.deletedAtVersionByConnectionId[id] = version;
		await writeSnapshot(context, storageKey, snapshot);
	});
}

export async function setSqlDatabaseCacheConnectionIdentity(
	context: SqlDatabaseCacheContext,
	storageKey: string,
	connection: SqlConnection,
	principalFingerprintOverride?: string | null,
): Promise<void> {
	const id = String(connection.id || '').trim();
	const principalFingerprint = principalFingerprintOverride === undefined
		? await readCurrentSqlSchemaPrincipalFingerprint(context, connection) ?? null
		: principalFingerprintOverride;
	await withSnapshotLock(context, storageKey, async snapshot => {
		const version = nextVersion(snapshot, context);
		snapshot.version = version;
		delete snapshot.entries[id];
		delete snapshot.latestRequestByConnectionId[id];
		delete snapshot.blockedAtVersionByConnectionId[id];
		snapshot.deletedAtVersionByConnectionId[id] = version;
		snapshot.targetSignatureByConnectionId[id] = sqlDatabaseTargetSignature(connection);
		snapshot.principalFingerprintByConnectionId[id] = principalFingerprint;
		await writeSnapshot(context, storageKey, snapshot);
	});
}
