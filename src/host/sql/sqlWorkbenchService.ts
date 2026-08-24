import * as vscode from 'vscode';
import { SqlQueryClient } from '../sqlClient';
import { SqlConnectionManager } from '../sqlConnectionManager';
import type { WorkbenchLogger } from '../workbenchLogger';
import { StsQueryService } from './stsQueryService';
import { cleanupAbandonedProtectedStsSandboxes, createProtectedStsRuntime, StsRuntime } from './stsRuntime';
import { SqlLeaveNoTracePolicyStore } from './sqlLeaveNoTracePolicyStore';
import { SqlServerAccountMapStore } from './sqlServerAccountMapStore';
import { blockSqlDatabaseCacheConnection, setSqlDatabaseCacheConnectionIdentity, SQL_DATABASE_CACHE_STORAGE_KEY } from '../sqlDatabaseCache';
import { sqlSchemaPrincipalFingerprintForPrincipal } from '../sqlEditorSchema';
import { sqlConnectionTargetSignature } from '../../shared/sqlConnectionIdentity';
import type { SqlConnection } from '../sqlConnectionManager';
import { startSqlDispatch, unwrapSqlDispatch } from './sqlDispatch';
import { isSqlStateLockContentionError } from './sqlStateTransaction';

const SQL_OWNER_SNAPSHOT_LOCK_RETRY_DELAY_MS = 25;
const SQL_OWNER_SNAPSHOT_LOCK_RETRIES = Math.ceil(30_000 / SQL_OWNER_SNAPSHOT_LOCK_RETRY_DELAY_MS) + 4;

class SqlOwnerSnapshotCallbackError extends Error {
	constructor(readonly callbackError: unknown) {
		super('SQL owner snapshot callback failed.');
	}
}

export interface SqlLeaveNoTraceChange {
	connectionIds: string[];
	changedConnectionId: string;
	enabled: boolean;
	enabledConnectionIds: string[];
	disabledConnectionIds: string[];
	invalidatedConnectionIds: string[];
	version: number;
	globallyBlocked: boolean;
}

export type SqlStateVersions = Readonly<{
	policy: number;
	principals: number;
	connections: number;
}>;

export type SqlOwnerSnapshot = {
	policy: {
		connectionIds: readonly string[];
		version: number;
		globallyBlocked: boolean;
		revocationGenerations: Readonly<Record<string, number>>;
	};
	connections: readonly SqlConnection[];
	connectionVersion: number;
	accountsByServer: Readonly<Record<string, string>>;
	principalVersion: number;
};

export type SqlOwnerSnapshotLockAttempt<T> =
	| Readonly<{ acquired: true; value: T }>
	| Readonly<{ acquired: false }>;

export class SqlWorkbenchService {
	readonly connectionManager: SqlConnectionManager;
	readonly runtime: StsRuntime;
	readonly queryService: StsQueryService;
	readonly client: SqlQueryClient;
	readonly leaveNoTracePolicy: SqlLeaveNoTracePolicyStore;
	readonly serverAccountMap: SqlServerAccountMapStore;
	private readonly leaveNoTraceEmitter = new vscode.EventEmitter<SqlLeaveNoTraceChange>();
	readonly onDidChangeLeaveNoTrace = this.leaveNoTraceEmitter.event;
	private readonly sqlPrincipalEmitter = new vscode.EventEmitter<{
		serverUrls: string[];
		connectionIds: string[];
		establishedConnectionIds: string[];
		version: number;
	}>();
	readonly onDidChangeSqlPrincipals = this.sqlPrincipalEmitter.event;
	private readonly sqlConnectionEmitter = new vscode.EventEmitter<{ connectionIds: string[]; version: number }>();
	readonly onDidChangeSqlConnections = this.sqlConnectionEmitter.event;
	private readonly readyPromise: Promise<void>;
	private sqlConnectionSignatures = new Map<string, string>();
	private sideEffectTail: Promise<void> = Promise.resolve();
	private readonly lifecycleFinalizers = new Set<() => void>();
	private disposePromise: Promise<void> | undefined;
	private disposed = false;

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly output: WorkbenchLogger,
		cleanupProtectedSandboxes: (output?: WorkbenchLogger) => Promise<void> = cleanupAbandonedProtectedStsSandboxes,
	) {
		this.trackSideEffect(cleanupProtectedSandboxes(output));
		this.connectionManager = new SqlConnectionManager(context);
		this.leaveNoTracePolicy = new SqlLeaveNoTracePolicyStore(context, output);
		this.serverAccountMap = new SqlServerAccountMapStore(context, output);
		this.runtime = new StsRuntime(context, output);
		this.queryService = new StsQueryService(
			this.runtime,
			this.connectionManager,
			context,
			output,
			this.leaveNoTracePolicy,
			(connection, principal, revocation, dispatch) => this.dispatchSqlOwnerAllowed(connection, principal, revocation, dispatch),
			() => createProtectedStsRuntime(context, output),
			(connection, principal, revocation, expectedProtected, dispatch) =>
				this.dispatchSqlOwnerProtection(connection, principal, revocation, expectedProtected, dispatch),
		);
		this.client = new SqlQueryClient(context, this.queryService);
		this.sqlConnectionSignatures = new Map(this.connectionManager.getConnections().map(connection => [connection.id, sqlConnectionTargetSignature(connection)]));
		this.connectionManager.onDidChangeConnections(connections => {
			const next = new Map(connections.map(connection => [connection.id, sqlConnectionTargetSignature(connection)]));
			const changedIds = [...new Set([...this.sqlConnectionSignatures.keys(), ...next.keys()])]
				.filter(connectionId => this.sqlConnectionSignatures.get(connectionId) !== next.get(connectionId));
			this.sqlConnectionSignatures = next;
			if (changedIds.length > 0) {
				this.trackSideEffect(Promise.allSettled(
					changedIds.map(connectionId => this.queryService.cancelConnection(connectionId)),
				).then(() => undefined));
				this.sqlConnectionEmitter.fire({ connectionIds: changedIds, version: this.connectionManager.getVersion() });
			}
		});
		this.leaveNoTracePolicy.onDidChange(change => {
			const allConnectionIds = this.connectionManager.getConnections().map(connection => connection.id);
			const protectedConnectionIds = change.globallyBlocked ? allConnectionIds : change.connectionIds;
			const enabledConnectionIds = change.globallyBlocked ? allConnectionIds : change.enabledConnectionIds;
			const invalidatedConnectionIds = change.globallyBlocked ? allConnectionIds : change.invalidatedConnectionIds;
			this.trackSideEffect(Promise.allSettled(
				invalidatedConnectionIds.map(connectionId => this.queryService.cancelConnection(connectionId)),
			).then(() => undefined));
			this.leaveNoTraceEmitter.fire({
				connectionIds: protectedConnectionIds,
				changedConnectionId: invalidatedConnectionIds[0] ?? change.disabledConnectionIds[0] ?? '',
				enabled: enabledConnectionIds.length > 0,
				enabledConnectionIds,
				disabledConnectionIds: change.disabledConnectionIds,
				invalidatedConnectionIds,
				version: change.version,
				globallyBlocked: change.globallyBlocked,
			});
		});
		this.serverAccountMap.onDidChange(change => {
			const changed = new Set(change.changedServerUrls);
			const established = new Set(change.establishedServerUrls);
			const invalidated = new Set(change.invalidatedServerUrls);
			const changedConnections = this.connectionManager.getConnections()
				.filter(connection => changed.has(String(connection.serverUrl || '').trim().toLowerCase()));
			const establishedConnections = changedConnections
				.filter(connection => established.has(String(connection.serverUrl || '').trim().toLowerCase()));
			const invalidatedConnections = changedConnections
				.filter(connection => invalidated.has(String(connection.serverUrl || '').trim().toLowerCase()));
			this.trackSideEffect(Promise.allSettled(
				invalidatedConnections.map(connection => this.queryService.cancelConnection(connection.id)),
			).then(() => undefined));
			this.sqlPrincipalEmitter.fire({
				serverUrls: change.changedServerUrls,
				connectionIds: changedConnections.map(connection => connection.id),
				establishedConnectionIds: establishedConnections.map(connection => connection.id),
				version: change.version,
			});
			this.trackSideEffect((async () => {
				for (const connection of invalidatedConnections) {
					try { await blockSqlDatabaseCacheConnection(this.context, SQL_DATABASE_CACHE_STORAGE_KEY, connection.id); } catch (error) {
						this.output.warn(`[sql-auth] Failed to block database cache after principal change for ${connection.id}: ${error instanceof Error ? error.message : String(error)}`);
					}
				}
				for (const connection of invalidatedConnections) {
					try { await this.queryService.cancelConnection(connection.id); } catch (error) {
						this.output.warn(`[sql-auth] Failed to cancel SQL work after principal change for ${connection.id}: ${error instanceof Error ? error.message : String(error)}`);
					}
					const serverUrl = String(connection.serverUrl || '').trim().toLowerCase();
					const principalFingerprint = sqlSchemaPrincipalFingerprintForPrincipal(connection, change.accountsByServer[serverUrl]) ?? null;
					try { await setSqlDatabaseCacheConnectionIdentity(this.context, SQL_DATABASE_CACHE_STORAGE_KEY, connection, principalFingerprint); } catch (error) {
						this.output.warn(`[sql-auth] Failed to rebase database cache after principal change for ${connection.id}: ${error instanceof Error ? error.message : String(error)}`);
					}
				}
			})());
		});
		this.readyPromise = Promise.all([
			this.connectionManager.ready(),
			this.serverAccountMap.ready(),
			this.leaveNoTracePolicy.refresh(),
		]).then(() => {
			this.sqlConnectionSignatures = new Map(this.connectionManager.getConnections().map(connection => [
				connection.id,
				sqlConnectionTargetSignature(connection),
			]));
		});
	}

	ready(): Promise<void> {
		return this.readyPromise;
	}

	getLeaveNoTraceConnectionIds(): string[] {
		return this.leaveNoTracePolicy.isGloballyBlocked()
			? this.connectionManager.getConnections().map(connection => connection.id)
			: this.leaveNoTracePolicy.getConnectionIds();
	}

	isLeaveNoTraceConnection(connectionId: string): boolean {
		return this.leaveNoTracePolicy.isProtected(connectionId);
	}

	async refreshLeaveNoTracePolicy(): Promise<string[]> {
		await this.awaitReadyActive();
		await this.leaveNoTracePolicy.refresh();
		return this.getLeaveNoTraceConnectionIds();
	}

	getStateVersions(): SqlStateVersions {
		return {
			policy: this.leaveNoTracePolicy.getVersion(),
			principals: this.serverAccountMap.getVersion(),
			connections: this.connectionManager.getVersion(),
		};
	}

	async assertSqlConnectionAllowed(connectionId: string): Promise<void> {
		await this.awaitReadyActive();
		await this.leaveNoTracePolicy.assertAllowed(connectionId);
	}

	async dispatchSqlConnectionAllowed<T>(connectionId: string, dispatch: () => T | PromiseLike<T>): Promise<T> {
		await this.awaitReadyActive();
		if (this.leaveNoTracePolicy.dispatchAllowed) {
			return this.leaveNoTracePolicy.dispatchAllowed(connectionId, dispatch);
		}
		await this.leaveNoTracePolicy.assertAllowed(connectionId);
		return await dispatch();
	}

	async dispatchSqlOwnerAllowed<T>(
		connection: SqlConnection,
		expectedPrincipalFingerprint: string,
		expectedRevocationGeneration: number,
		dispatch: () => T | PromiseLike<T>,
	): Promise<T> {
		this.assertActive();
		const handle = await this.leaveNoTracePolicy.prepareDispatchAllowed(connection.id, async () =>
			this.connectionManager.prepareDispatchCurrent(connection, async () =>
				this.serverAccountMap.preparePrincipalDispatch(connection, expectedPrincipalFingerprint, dispatch)), expectedRevocationGeneration);
		return unwrapSqlDispatch(handle);
	}

	async dispatchSqlOwnerProtection<T>(
		connection: SqlConnection,
		expectedPrincipalFingerprint: string,
		expectedRevocationGeneration: number,
		expectedProtected: boolean,
		dispatch: () => T | PromiseLike<T>,
	): Promise<T> {
		this.assertActive();
		const handle = await this.leaveNoTracePolicy.prepareDispatchProtectionMode(
			connection.id,
			expectedProtected,
			expectedRevocationGeneration,
			async () => this.connectionManager.prepareDispatchCurrent(connection, async () =>
				this.serverAccountMap.preparePrincipalDispatch(connection, expectedPrincipalFingerprint, dispatch)),
		);
		return unwrapSqlDispatch(handle);
	}

	async dispatchCurrentSqlOwnerAllowed<T>(
		connection: SqlConnection,
		expectedPrincipalFingerprint: string,
		dispatch: () => T | PromiseLike<T>,
	): Promise<T> {
		this.assertActive();
		return this.dispatchSqlOwnerAllowed(
			connection,
			expectedPrincipalFingerprint,
			this.leaveNoTracePolicy.getRevocationGeneration(connection.id),
			dispatch,
		);
	}

	async dispatchSqlPolicySnapshot<T>(dispatch: (snapshot: {
		connectionIds: readonly string[];
		version: number;
		globallyBlocked: boolean;
		revocationGenerations: Readonly<Record<string, number>>;
	}) => T | PromiseLike<T>): Promise<T> {
		await this.awaitReadyActive();
		if (this.leaveNoTracePolicy.dispatchSnapshot) return this.leaveNoTracePolicy.dispatchSnapshot(dispatch);
		await this.leaveNoTracePolicy.refresh();
		return await dispatch({
			connectionIds: this.leaveNoTracePolicy.getConnectionIds(),
			version: this.leaveNoTracePolicy.getConnectionIds().length,
			globallyBlocked: false,
			revocationGenerations: {},
		});
	}

	async dispatchSqlOwnerSnapshot<T>(dispatch: (snapshot: SqlOwnerSnapshot) => T | PromiseLike<T>): Promise<T> {
		this.assertActive();
		return this.retrySqlOwnerSnapshotAcquisition(() => this.tryDispatchSqlOwnerSnapshot(dispatch));
	}

	async runWithSqlOwnerSnapshotLock<T>(run: (snapshot: SqlOwnerSnapshot) => Promise<T>): Promise<T> {
		this.assertActive();
		return this.retrySqlOwnerSnapshotAcquisition(() => this.tryRunWithSqlOwnerSnapshotLock(run));
	}

	async tryDispatchSqlOwnerSnapshot<T>(dispatch: (snapshot: SqlOwnerSnapshot) => T | PromiseLike<T>): Promise<SqlOwnerSnapshotLockAttempt<T>> {
		await this.awaitReadyActive();
		const lockOptions = { retries: 0 } as const;
		let handle;
		try {
			handle = await this.leaveNoTracePolicy.prepareSnapshotDispatch(async policy =>
				this.connectionManager.prepareSnapshotDispatch(async connections =>
					this.serverAccountMap.prepareSnapshotDispatch(principals =>
						startSqlDispatch(() => dispatch({
							policy,
							connections: connections.connections,
							connectionVersion: connections.version,
							accountsByServer: principals.accountsByServer,
							principalVersion: principals.version,
						})), lockOptions), lockOptions), lockOptions);
		} catch (error) {
			if (isSqlStateLockContentionError(error)) return { acquired: false };
			throw error;
		}
		return { acquired: true, value: await unwrapSqlDispatch(handle) };
	}

	async tryRunWithSqlOwnerSnapshotLock<T>(run: (snapshot: SqlOwnerSnapshot) => Promise<T>): Promise<SqlOwnerSnapshotLockAttempt<T>> {
		await this.awaitReadyActive();
		const lockOptions = { retries: 0 } as const;
		try {
			const value = await this.leaveNoTracePolicy.runWithSnapshotLock(async policy =>
				this.connectionManager.runWithSnapshotLock(async connections =>
					this.serverAccountMap.runWithSnapshotLock(async principals => {
						try {
							return await run({
								policy,
								connections: connections.connections,
								connectionVersion: connections.version,
								accountsByServer: principals.accountsByServer,
								principalVersion: principals.version,
							});
						} catch (error) {
							throw new SqlOwnerSnapshotCallbackError(error);
						}
					}, lockOptions), lockOptions), lockOptions);
			return { acquired: true, value };
		} catch (error) {
			if (error instanceof SqlOwnerSnapshotCallbackError) throw error.callbackError;
			if (isSqlStateLockContentionError(error)) return { acquired: false };
			throw error;
		}
	}

	async retrySqlOwnerSnapshotAcquisition<T>(attempt: () => Promise<SqlOwnerSnapshotLockAttempt<T>>): Promise<T> {
		for (let retry = 0; ; retry += 1) {
			this.assertActive();
			const result = await attempt();
			if (result.acquired) return result.value;
			if (retry >= SQL_OWNER_SNAPSHOT_LOCK_RETRIES) {
				throw Object.assign(new Error('Timed out waiting for canonical SQL owner snapshot locks.'), { code: 'ELOCKED' });
			}
			await new Promise<void>(resolve => setTimeout(resolve, SQL_OWNER_SNAPSHOT_LOCK_RETRY_DELAY_MS));
		}
	}

	async setLeaveNoTraceConnection(connectionId: string, enabled: boolean): Promise<void> {
		const id = String(connectionId || '').trim();
		if (!id) return;
		await this.awaitReadyActive();
		await this.leaveNoTracePolicy.setConnection(id, enabled);
		this.assertActive();
		if (enabled) await this.queryService.cancelConnection(id);
	}

	runLifecycleOperation<T>(operation: () => Promise<T>): Promise<T> {
		this.assertActive();
		let accepted: Promise<T>;
		try {
			accepted = operation();
		} catch (error) {
			return Promise.reject(error);
		}
		this.trackSideEffect(accepted.then(() => undefined, () => undefined));
		return accepted;
	}

	trackLifecycleCleanup(operation: PromiseLike<unknown>): void {
		this.trackSideEffect(Promise.resolve(operation).then(() => undefined, () => undefined));
	}

	registerLifecycleFinalizer(finalize: () => void): vscode.Disposable {
		if (this.disposed) {
			finalize();
			return { dispose: () => undefined };
		}
		this.lifecycleFinalizers.add(finalize);
		return { dispose: () => this.lifecycleFinalizers.delete(finalize) };
	}

	dispose(): Promise<void> {
		if (this.disposePromise) return this.disposePromise;
		this.disposed = true;
		this.leaveNoTracePolicy.dispose();
		this.serverAccountMap.dispose();
		this.connectionManager.dispose();
		this.disposePromise = this.finishDisposal();
		return this.disposePromise;
	}

	private async finishDisposal(): Promise<void> {
		let disposalError: unknown;
		try {
			const queryDisposal = this.queryService.dispose();
			for (;;) {
				this.drainLifecycleFinalizers();
				const sideEffectTail = this.sideEffectTail;
				const operationResults = await Promise.allSettled([queryDisposal, sideEffectTail]);
				disposalError ??= operationResults.find(result => result.status === 'rejected')?.reason;
				if (this.lifecycleFinalizers.size === 0 && sideEffectTail === this.sideEffectTail) break;
			}
			const runtimeResult = await Promise.allSettled([this.runtime.dispose()]);
			disposalError ??= runtimeResult.find(result => result.status === 'rejected')?.reason;
		} finally {
			await Promise.all([
				this.leaveNoTracePolicy.waitForRefreshSettlement(),
				this.serverAccountMap.waitForRefreshSettlement(),
				this.connectionManager.waitForRefreshSettlement(),
				this.waitForSideEffectSettlement(),
			]);
			this.leaveNoTraceEmitter.dispose();
			this.sqlPrincipalEmitter.dispose();
			this.sqlConnectionEmitter.dispose();
		}
		if (disposalError !== undefined) throw disposalError;
	}

	private drainLifecycleFinalizers(): void {
		for (const finalize of [...this.lifecycleFinalizers]) {
			this.lifecycleFinalizers.delete(finalize);
			try { finalize(); } catch { /* best-effort language cleanup */ }
		}
	}

	private async awaitReadyActive(): Promise<void> {
		this.assertActive();
		await this.readyPromise;
		this.assertActive();
	}

	private assertActive(): void {
		if (this.disposed) throw new Error('SQL workbench service is disposed.');
	}

	private trackSideEffect(operation: Promise<void>): void {
		const previous = this.sideEffectTail;
		this.sideEffectTail = Promise.allSettled([previous, operation]).then(() => undefined);
	}

	private async waitForSideEffectSettlement(): Promise<void> {
		for (;;) {
			const tail = this.sideEffectTail;
			await tail;
			if (tail === this.sideEffectTail) return;
		}
	}
}