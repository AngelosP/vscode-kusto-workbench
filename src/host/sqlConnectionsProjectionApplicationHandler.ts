import type * as vscode from 'vscode';

import type { SqlFavorite } from './connectionManagerFavorites';
import type { SqlConnection, SqlConnectionManager } from './sqlConnectionManager';
import { sqlSchemaPrincipalFingerprintForPrincipal } from './sqlEditorSchema';
import {
	sqlDatabaseTargetSignature,
	type SqlDatabaseCacheEntry,
} from './sqlDatabaseCache';
import type { IncomingWebviewMessage } from './queryEditorTypes';
import { normalizeSqlServerUrl } from './sql/sqlAuthState';
import type { SqlWorkbenchService } from './sql/sqlWorkbenchService';
import {
	admitSqlConnectionsProjectionWebviewMessage,
	parseSqlConnectionsProjectionHostMessage,
	type SqlConnectionsData,
	type SqlConnectionsProjectionHostMessage,
} from '../shared/sqlConnectionsProjectionProtocol';

function readOwnDataProperty(record: Readonly<Record<string, unknown>>, key: string): unknown {
	try {
		const descriptor = Object.getOwnPropertyDescriptor(record, key);
		return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')
			? descriptor.value
			: undefined;
	} catch {
		return undefined;
	}
}

export interface SqlConnectionsProjectionApplicationHandler {
	handleMessage(message: IncomingWebviewMessage): Promise<void> | undefined;
	refresh(): Promise<boolean>;
	dispose(): void;
}

export type SqlConnectionsProjectionApplicationHandlerOptions = {
	applicationState: Pick<vscode.Memento, 'get'>;
	connectionManager: Pick<SqlConnectionManager, 'getConnections'>;
	workbench: Pick<SqlWorkbenchService, 'dispatchSqlOwnerSnapshot'>;
	readDatabaseCache: (connection: SqlConnection) => Promise<SqlDatabaseCacheEntry | undefined>;
	getFavorites: () => SqlFavorite[];
	postMessage: (message: SqlConnectionsProjectionHostMessage) => boolean | PromiseLike<boolean>;
};

export class HostSqlConnectionsProjectionApplicationHandler
	implements SqlConnectionsProjectionApplicationHandler {
	private disposed = false;
	private snapshotRevision = 0;
	private snapshotTail: Promise<boolean> = Promise.resolve(true);

	constructor(private readonly options: SqlConnectionsProjectionApplicationHandlerOptions) {}

	handleMessage(message: IncomingWebviewMessage): Promise<void> | undefined {
		const admission = admitSqlConnectionsProjectionWebviewMessage(message);
		if (!admission.recognized) return undefined;
		if (!admission.parsed.ok) return Promise.resolve();
		if (this.disposed) return Promise.resolve();
		return this.refresh().then(() => undefined);
	}

	refresh(): Promise<boolean> {
		if (this.disposed) return Promise.resolve(false);
		const publish = () => this.disposed ? false : this.publishSnapshot();
		const result = this.snapshotTail.then(publish, publish);
		this.snapshotTail = result.catch(() => false);
		return result;
	}

	dispose(): void {
		this.disposed = true;
	}

	private async publishSnapshot(): Promise<boolean> {
		const revision = ++this.snapshotRevision;
		const capturedConnections = this.options.connectionManager.getConnections();
		const cacheEntries = new Map<string, SqlDatabaseCacheEntry | undefined>();
		for (const connection of capturedConnections) {
			cacheEntries.set(connection.id, await this.options.readDatabaseCache(connection));
			if (this.disposed) return false;
		}
		const lastSqlConnectionId = this.options.applicationState.get<string>('sql.lastConnectionId') || '';
		const lastSqlDatabase = this.options.applicationState.get<string>('sql.lastDatabase') || '';
		return this.options.workbench.dispatchSqlOwnerSnapshot(async snapshot => {
			if (this.disposed) return false;
			const canonicalProtectedIds = snapshot.policy.globallyBlocked
				? new Set(snapshot.connections.map(connection => connection.id))
				: new Set(snapshot.policy.connectionIds);
			const principalByConnectionId = new Map<string, string>();
			const publishedConnections = snapshot.connections.map(connection => {
				const authType = String(connection.authType || '').trim().toLowerCase();
				const account = readOwnDataProperty(
					snapshot.accountsByServer,
					normalizeSqlServerUrl(connection.serverUrl),
				);
				const principal = authType === 'aad'
					? (typeof account === 'string' ? account : undefined)
					: String(connection.username || '').trim();
				const principalFingerprint = sqlSchemaPrincipalFingerprintForPrincipal(connection, principal);
				if (principalFingerprint) principalByConnectionId.set(connection.id, principalFingerprint);
				const candidateGeneration = readOwnDataProperty(snapshot.policy.revocationGenerations, connection.id);
				const revocationGeneration = typeof candidateGeneration === 'number'
					&& Number.isSafeInteger(candidateGeneration) && candidateGeneration >= 0
					? candidateGeneration
					: 0;
				return canonicalProtectedIds.has(connection.id) || !principalFingerprint
					? { ...connection, revocationGeneration }
					: { ...connection, principalFingerprint, revocationGeneration };
			});
			const cachedDatabases = Object.fromEntries(snapshot.connections.flatMap(connection => {
				if (canonicalProtectedIds.has(connection.id)) return [];
				const entry = cacheEntries.get(connection.id);
				if (!entry
					|| entry.targetSignature !== sqlDatabaseTargetSignature(connection)
					|| entry.principalFingerprint !== principalByConnectionId.get(connection.id)) return [];
				return [[connection.id, entry.databases] as const];
			}));
			const message: SqlConnectionsData = {
				type: 'sqlConnectionsData',
				revision,
				sqlStateVersions: {
					policy: snapshot.policy.version,
					connections: snapshot.connectionVersion,
					principals: snapshot.principalVersion,
				},
				connections: publishedConnections,
				lastConnectionId: lastSqlConnectionId,
				lastDatabase: lastSqlDatabase,
				cachedDatabases,
				sqlFavorites: snapshot.policy.globallyBlocked
					? []
					: this.options.getFavorites()
						.filter(favorite => !canonicalProtectedIds.has(favorite.connectionId)),
				sqlLeaveNoTrace: [...canonicalProtectedIds],
			};
			const parsed = parseSqlConnectionsProjectionHostMessage(message);
			if (!parsed.ok) return false;
			const delivered = await this.options.postMessage(parsed.value);
			return delivered === true;
		});
	}
}
