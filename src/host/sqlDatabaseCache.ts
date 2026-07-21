import * as crypto from 'crypto';
import * as path from 'path';
import type * as vscode from 'vscode';

import type { SqlConnection } from './sqlConnectionManager';
import { readCurrentSqlSchemaPrincipalFingerprint } from './sqlEditorSchema';
import { sqlConnectionTargetSignature, sqlConnectionTargetSignatureMatches } from '../shared/sqlConnectionIdentity';
import { quarantineCorruptSqlStateFile } from './sql/sqlStateFile';
import {
	atomicReplaceSqlStateFile,
	readSqlJsonStateFile,
	withSqlStateFileLock,
} from './sql/sqlStateTransaction';

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

function parseDatabases(value: unknown): string[] | undefined {
	if (!Array.isArray(value) || value.some(database => typeof database !== 'string' || !database.trim())) return undefined;
	return value.map(database => database.trim());
}

function parseEntry(key: string, value: unknown): SqlDatabaseCacheEntry | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
	const candidate = value as Partial<SqlDatabaseCacheEntry>;
	if (typeof candidate.connectionId !== 'string'
		|| typeof candidate.targetSignature !== 'string'
		|| typeof candidate.principalFingerprint !== 'string'
		|| typeof candidate.writeId !== 'string'
		|| typeof candidate.requestId !== 'string') return undefined;
	const connectionId = candidate.connectionId.trim();
	const targetSignature = candidate.targetSignature;
	const principalFingerprint = candidate.principalFingerprint.trim();
	const writeId = candidate.writeId.trim();
	const requestId = candidate.requestId.trim();
	const databases = parseDatabases(candidate.databases);
	if (candidate.version !== SQL_DATABASE_CACHE_VERSION || !connectionId || connectionId !== key
		|| !targetSignature || !principalFingerprint || !writeId || !requestId || !databases
		|| typeof candidate.requestVersion !== 'number' || !Number.isSafeInteger(candidate.requestVersion) || candidate.requestVersion <= 0
		|| typeof candidate.updatedAt !== 'number' || !Number.isFinite(candidate.updatedAt)) return undefined;
	return {
		version: SQL_DATABASE_CACHE_VERSION,
		connectionId,
		targetSignature,
		principalFingerprint,
		databases,
		writeId,
		requestId,
		requestVersion: candidate.requestVersion,
		updatedAt: candidate.updatedAt,
	};
}

function parseSnapshot(value: unknown): SqlDatabaseCacheSnapshot | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
	const candidate = value as Partial<SqlDatabaseCacheSnapshot>;
	if (candidate.schemaVersion !== SQL_DATABASE_CACHE_VERSION
		|| !Number.isSafeInteger(candidate.version) || Number(candidate.version) < 0
		|| !candidate.entries || typeof candidate.entries !== 'object' || Array.isArray(candidate.entries)) return undefined;
	const snapshot = emptySnapshot();
	snapshot.version = Number(candidate.version);
	for (const [connectionId, entryValue] of Object.entries(candidate.entries)) {
		const entry = parseEntry(connectionId, entryValue);
		if (!entry) return undefined;
		snapshot.entries[connectionId] = entry;
	}
	if (candidate.latestRequestByConnectionId !== undefined) {
		if (!candidate.latestRequestByConnectionId || typeof candidate.latestRequestByConnectionId !== 'object' || Array.isArray(candidate.latestRequestByConnectionId)) return undefined;
		for (const [connectionId, requestValue] of Object.entries(candidate.latestRequestByConnectionId)) {
			if (!connectionId.trim() || !requestValue || typeof requestValue !== 'object' || Array.isArray(requestValue)) return undefined;
			const request = requestValue as { requestId?: unknown; version?: unknown };
			if (typeof request.requestId !== 'string') return undefined;
			const requestId = request.requestId.trim();
			if (!requestId || typeof request.version !== 'number' || !Number.isSafeInteger(request.version) || request.version <= 0) return undefined;
			snapshot.latestRequestByConnectionId[connectionId] = { requestId, version: request.version };
		}
	}
	if (candidate.deletedAtVersionByConnectionId !== undefined) {
		if (!candidate.deletedAtVersionByConnectionId || typeof candidate.deletedAtVersionByConnectionId !== 'object' || Array.isArray(candidate.deletedAtVersionByConnectionId)) return undefined;
		for (const [connectionId, versionValue] of Object.entries(candidate.deletedAtVersionByConnectionId)) {
			if (!connectionId.trim() || typeof versionValue !== 'number' || !Number.isSafeInteger(versionValue) || versionValue <= 0) return undefined;
			snapshot.deletedAtVersionByConnectionId[connectionId] = versionValue;
		}
	}
	if (candidate.blockedAtVersionByConnectionId !== undefined) {
		if (!candidate.blockedAtVersionByConnectionId || typeof candidate.blockedAtVersionByConnectionId !== 'object' || Array.isArray(candidate.blockedAtVersionByConnectionId)) return undefined;
		for (const [connectionId, versionValue] of Object.entries(candidate.blockedAtVersionByConnectionId)) {
			if (!connectionId.trim() || !versionValue || typeof versionValue !== 'object' || Array.isArray(versionValue)) return undefined;
			const block = versionValue as { version?: unknown; expiresAt?: unknown };
			if (typeof block.version !== 'number' || !Number.isSafeInteger(block.version) || block.version <= 0
				|| typeof block.expiresAt !== 'number' || !Number.isFinite(block.expiresAt) || block.expiresAt <= 0) return undefined;
			snapshot.blockedAtVersionByConnectionId[connectionId] = { version: block.version, expiresAt: block.expiresAt };
		}
	}
	if (candidate.targetSignatureByConnectionId !== undefined) {
		if (!candidate.targetSignatureByConnectionId || typeof candidate.targetSignatureByConnectionId !== 'object' || Array.isArray(candidate.targetSignatureByConnectionId)) return undefined;
		for (const [connectionId, signatureValue] of Object.entries(candidate.targetSignatureByConnectionId)) {
			if (!connectionId.trim() || typeof signatureValue !== 'string' || !signatureValue) return undefined;
			snapshot.targetSignatureByConnectionId[connectionId] = signatureValue;
		}
	}
	if (candidate.principalFingerprintByConnectionId !== undefined) {
		if (!candidate.principalFingerprintByConnectionId || typeof candidate.principalFingerprintByConnectionId !== 'object' || Array.isArray(candidate.principalFingerprintByConnectionId)) return undefined;
		for (const [connectionId, fingerprintValue] of Object.entries(candidate.principalFingerprintByConnectionId)) {
			if (!connectionId.trim()) return undefined;
			if (fingerprintValue === null) snapshot.principalFingerprintByConnectionId[connectionId] = null;
			else {
				if (typeof fingerprintValue !== 'string' || !fingerprintValue.trim()) return undefined;
				snapshot.principalFingerprintByConnectionId[connectionId] = fingerprintValue.trim();
			}
		}
	}
	if (candidate.clearedAtVersion !== undefined
		&& (typeof candidate.clearedAtVersion !== 'number' || !Number.isSafeInteger(candidate.clearedAtVersion) || candidate.clearedAtVersion < 0)) return undefined;
	snapshot.clearedAtVersion = candidate.clearedAtVersion ?? 0;
	return snapshot;
}

export function parseSqlDatabaseCacheStore(value: unknown): Record<string, SqlDatabaseCacheEntry> {
	return parseSnapshot(value)?.entries ?? {};
}

function getSnapshotPath(context: SqlDatabaseCacheContext, storageKey: string): string | undefined {
	const root = String(context.globalStorageUri?.fsPath || '').trim();
	if (!root) return undefined;
	const suffix = crypto.createHash('sha1').update(storageKey, 'utf8').digest('hex').slice(0, 12);
	return path.join(root, `sql-database-cache-${suffix}.v1.json`);
}

async function readDiskSnapshotUnderLock(snapshotPath: string): Promise<SqlDatabaseCacheSnapshot | undefined> {
	const read = await readSqlJsonStateFile(snapshotPath, parseSnapshot);
	if (read.kind === 'valid') return read.value;
	if (read.kind === 'missing') return undefined;
	await quarantineCorruptSqlStateFile(snapshotPath);
	const recovered = emptySnapshot();
	recovered.version = Date.now();
	recovered.clearedAtVersion = recovered.version;
	await atomicReplaceSqlStateFile(snapshotPath, `${JSON.stringify(recovered, null, 2)}\n`);
	return recovered;
}

function readMemorySnapshot(context: SqlDatabaseCacheContext, storageKey: string): SqlDatabaseCacheSnapshot {
	const runtime = getRuntime(context);
	return runtime.snapshots.get(storageKey) ?? parseSnapshot(context.globalState.get<unknown>(storageKey)) ?? emptySnapshot();
}

async function readCurrentSnapshot(context: SqlDatabaseCacheContext, storageKey: string): Promise<SqlDatabaseCacheSnapshot> {
	const snapshotPath = getSnapshotPath(context, storageKey);
	if (snapshotPath) {
		return withSqlStateFileLock(`${snapshotPath}.write`, async () =>
			await readDiskSnapshotUnderLock(snapshotPath) ?? emptySnapshot(), { staleMs: CACHE_LOCK_STALE_MS });
	}
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
		await atomicReplaceSqlStateFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);
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
		const lockTarget = `${snapshotPath}.write`;
		return withSqlStateFileLock(lockTarget, async () => {
			return await action(await readDiskSnapshotUnderLock(snapshotPath) ?? emptySnapshot());
		}, { staleMs: CACHE_LOCK_STALE_MS });
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
			if (!sqlConnectionTargetSignatureMatches(connection, currentTargetSignature)) {
				throw new Error('SQL connection target changed in another window.');
			}
			snapshot.targetSignatureByConnectionId[id] = targetSignature;
		}
		const cachedEntry = snapshot.entries[id];
		if (cachedEntry && cachedEntry.targetSignature !== targetSignature) {
			if (principalFingerprint
				&& cachedEntry.principalFingerprint === principalFingerprint
				&& sqlConnectionTargetSignatureMatches(connection, cachedEntry.targetSignature)) {
				snapshot.entries[id] = { ...cachedEntry, targetSignature };
			} else {
				delete snapshot.entries[id];
			}
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
