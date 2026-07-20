import { readCurrentSqlServerAccountMap } from './sqlServerAccountMapStore';
import { normalizeSqlServerUrl } from './sqlAuthState';

type SqlOwnerDispatcher = <T>(
	connection: SqlConnection,
	principalFingerprint: string,
	revocationGeneration: number,
	dispatch: () => T | PromiseLike<T>,
) => Promise<T>;
import { sqlSchemaPrincipalFingerprintForPrincipal } from '../sqlEditorSchema';
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import type { QueryResult } from '../kustoClient';
import type { SqlConnection, SqlConnectionManager } from '../sqlConnectionManager';
import type { WorkbenchLogger } from '../workbenchLogger';
import { buildStsConnectionOptions } from './stsConnectionOptions';
import { SqlQueryCancelledError, SqlQueryExecutionError } from './sqlErrors';
import type { StsProcessManager } from './stsProcessManager';
import {
	STS_METHODS,
	type StsBatchSummary,
	type StsConnectionCompleteParams,
	type StsConnectParams,
	type StsListDatabasesResponse,
	type StsQueryCompleteParams,
	type StsQueryMessageParams,
	type StsResultMessage,
	type StsResultSetSummary,
	type StsSubsetResult,
} from './stsProtocol';
import { createQueryResultFromSts } from './stsResultAdapter';
import type { StsRuntimeLike } from './stsRuntime';
import {
	assertSqlConnectionMayUseSts,
	getSqlLeaveNoTraceConnectionIds,
	isSqlLeaveNoTraceConnection,
	type SqlLeaveNoTracePolicy,
} from './sqlLeaveNoTrace';
import { sanitizeStsLogText } from './stsLogSanitizer';

const CONNECT_REQUEST_TIMEOUT_MS = 15_000;
const CONNECT_COMPLETE_TIMEOUT_MS = 30_000;
const EXECUTE_ACCEPT_TIMEOUT_MS = 15_000;
const SUBSET_TIMEOUT_MS = 30_000;
const CLEANUP_TIMEOUT_MS = 10_000;
const SUBSET_PAGE_SIZE = 1_000;

type ExecutionPhase = 'starting' | 'connecting' | 'executing' | 'paging' | 'cleaning' | 'done';

interface Deferred<T> {
	promise: Promise<T>;
	resolve(value: T): void;
	reject(error: Error): void;
}

function deferred<T>(): Deferred<T> {
	let resolve: (value: T) => void = () => undefined;
	let reject: (error: Error) => void = () => undefined;
	const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
	return { promise, resolve, reject };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new SqlQueryExecutionError(`${label} timed out.`)), timeoutMs);
		promise.then(
			value => { clearTimeout(timer); resolve(value); },
			error => { clearTimeout(timer); reject(error); },
		);
	});
}

function remainingMs(deadline: number | undefined): number | null {
	if (deadline === undefined) return null;
	return Math.max(0, deadline - Date.now());
}

function parseExecutionTime(startedAt: number): string {
	return `${((Date.now() - startedAt) / 1000).toFixed(3)}s`;
}

function firstResultSet(batchSummaries: readonly StsBatchSummary[]): {
	batchIndex: number;
	resultSetIndex: number;
	summary: StsResultSetSummary;
} | undefined {
	for (let batchIndex = 0; batchIndex < batchSummaries.length; batchIndex++) {
		const resultSets = batchSummaries[batchIndex]?.resultSetSummaries ?? [];
		for (let resultSetIndex = 0; resultSetIndex < resultSets.length; resultSetIndex++) {
			const summary = resultSets[resultSetIndex];
			if ((summary.columnInfo?.length ?? 0) > 0) return { batchIndex, resultSetIndex, summary };
		}
	}
	return undefined;
}

export class StsQueryService {
	private readonly activeOperations = new Set<StsExecutionOperation>();
	private readonly leaveNoTracePolicy: SqlLeaveNoTracePolicy;
	private disposed = false;

	constructor(
		private readonly runtime: StsRuntimeLike,
		private readonly connectionManager: SqlConnectionManager,
		private readonly context: vscode.ExtensionContext,
		private readonly output: WorkbenchLogger,
		leaveNoTracePolicy?: SqlLeaveNoTracePolicy,
		private readonly dispatchSqlOwnerAllowed?: SqlOwnerDispatcher,
	) {
		this.leaveNoTracePolicy = leaveNoTracePolicy ?? {
			getConnectionIds: () => getSqlLeaveNoTraceConnectionIds(context),
			getRevocationGeneration: () => 0,
			isProtected: connectionId => isSqlLeaveNoTraceConnection(context, connectionId),
			assertAllowed: async connectionId => assertSqlConnectionMayUseSts(context, connectionId),
			dispatchAllowed: async (connectionId, dispatch) => {
				assertSqlConnectionMayUseSts(context, connectionId);
				return await dispatch();
			},
			refresh: async () => getSqlLeaveNoTraceConnectionIds(context),
		};
	}

	async getDatabases(connection: SqlConnection, passwordOverride?: string, allowUncommittedTarget = false, signal?: AbortSignal): Promise<string[]> {
		await this.leaveNoTracePolicy.assertAllowed(connection.id);
		const operation = this.createOperation(connection, connection.database || 'master', undefined, passwordOverride, allowUncommittedTarget);
		const abort = () => operation.cancel();
		if (signal?.aborted) abort();
		else signal?.addEventListener('abort', abort, { once: true });
		try {
			const response = await operation.runRequest<StsListDatabasesResponse>(
				STS_METHODS.listDatabases,
				{ ownerUri: operation.ownerUri, includeDetails: false },
				CONNECT_REQUEST_TIMEOUT_MS,
			);
			const databaseNames = (response.databaseNames ?? [])
				.map(name => String(name || '').trim())
				.filter(Boolean)
				.sort((left, right) => left.toLowerCase().localeCompare(right.toLowerCase()));
			await operation.assertCurrentOwner();
			return databaseNames;
		} finally {
			signal?.removeEventListener('abort', abort);
			await operation.dispose();
			this.activeOperations.delete(operation);
		}
	}

	executeQuery(
		connection: SqlConnection,
		database: string,
		query: string,
		timeoutMs?: number,
		signal?: AbortSignal,
	): Promise<QueryResult> {
		const execution = this.executeQueryCancelable(connection, database, query, timeoutMs);
		const abort = () => execution.cancel();
		if (signal?.aborted) abort();
		else signal?.addEventListener('abort', abort, { once: true });
		return execution.promise.finally(() => signal?.removeEventListener('abort', abort));
	}

	executeQueryCancelable(
		connection: SqlConnection,
		database: string,
		query: string,
		timeoutMs?: number,
	): { promise: Promise<QueryResult>; cancel: () => void } {
		const operation = this.createOperation(connection, database, timeoutMs);
		const promise = operation.execute(query);
		void operation.whenDisposed().then(() => {
			this.activeOperations.delete(operation);
		});
		return { promise, cancel: () => operation.cancel() };
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		const operations = [...this.activeOperations];
		for (const operation of operations) operation.cancel();
		await Promise.allSettled(operations.map(operation => operation.dispose()));
		this.activeOperations.clear();
	}

	async cancelConnection(connectionId: string): Promise<void> {
		const operations = [...this.activeOperations].filter(operation => operation.connectionId === connectionId);
		for (const operation of operations) operation.cancel();
		await Promise.allSettled(operations.map(operation => operation.dispose()));
	}

	private createOperation(connection: SqlConnection, database: string, timeoutMs: number | undefined, passwordOverride?: string, allowUncommittedTarget = false): StsExecutionOperation {
		if (this.disposed) throw new SqlQueryExecutionError('SQL query service is disposed.');
		if (this.leaveNoTracePolicy.isProtected(connection.id)) assertSqlConnectionMayUseSts(this.context, connection.id);
		const operation = new StsExecutionOperation(
			this.runtime,
			this.connectionManager,
			this.context,
			this.output,
			this.leaveNoTracePolicy,
			connection,
			database,
			timeoutMs,
			passwordOverride,
			allowUncommittedTarget,
			this.dispatchSqlOwnerAllowed,
		);
		this.activeOperations.add(operation);
		return operation;
	}
}

class StsExecutionOperation {
	readonly ownerUri = `kw-sql://execution/${crypto.randomUUID()}.sql`;
	get connectionId(): string { return this.connection.id; }
	private process: StsProcessManager | undefined;
	private epoch = 0;
	private phase: ExecutionPhase = 'starting';
	private cancelled = false;
	private connected = false;
	private connectSubmitted = false;
	private connectCompleted = false;
	private submitted = false;
	private queryCompleted = false;
	private cleanupPromise: Promise<void> | undefined;
	private readonly subscriptions: vscode.Disposable[] = [];
	private readonly connectComplete = deferred<StsConnectionCompleteParams>();
	private readonly queryComplete = deferred<StsQueryCompleteParams>();
	private readonly cancelSignal = deferred<never>();
	private readonly cleanupComplete = deferred<void>();
	private readonly messages: StsResultMessage[] = [];
	private principalFingerprint: string | undefined;
	private principalCaptured = false;
	private readonly revocationGeneration: number;
	private resolvedAadAccountId: string | undefined;

	constructor(
		private readonly runtime: StsRuntimeLike,
		private readonly connectionManager: SqlConnectionManager,
		private readonly context: vscode.ExtensionContext,
		private readonly output: WorkbenchLogger,
		private readonly leaveNoTracePolicy: SqlLeaveNoTracePolicy,
		private readonly connection: SqlConnection,
		private readonly database: string,
		private readonly timeoutMs: number | undefined,
		private readonly passwordOverride?: string,
		private readonly allowUncommittedTarget = false,
		private readonly dispatchSqlOwnerAllowed?: SqlOwnerDispatcher,
	) {
		this.revocationGeneration = this.leaveNoTracePolicy.getRevocationGeneration?.(this.connection.id) ?? 0;
		this.cancelSignal.promise.catch(() => { /* consumed by execution race */ });
		this.connectComplete.promise.catch(() => { /* may fail before connect is awaited */ });
		this.queryComplete.promise.catch(() => { /* may fail before execution is awaited */ });
		const policySubscription = this.leaveNoTracePolicy.onDidChange?.(change => {
			if ((change.invalidatedConnectionIds ?? change.enabledConnectionIds).includes(this.connection.id)) this.cancel();
		});
		if (policySubscription) this.subscriptions.push(policySubscription);
	}

	async execute(query: string): Promise<QueryResult> {
		const run = this.executeCore(query).finally(() => this.dispose());
		return Promise.race([run, this.cancelSignal.promise]);
	}

	async runRequest<T>(method: string, params: unknown, timeoutMs: number): Promise<T> {
		await this.connect();
		return this.runGuardedRequest<T>(method, params, timeoutMs);
	}

	private async runGuardedRequest<T>(method: string, params: unknown, timeoutMs: number): Promise<T> {
		await this.assertAllowed();
		const result = await Promise.race([
			this.dispatchAllowed(() => {
				this.assertDispatchCurrent();
				if (method === STS_METHODS.executeString) this.submitted = true;
				return this.process!.sendRequest<T>(method, params, { timeoutMs, expectedEpoch: this.epoch });
			}),
			this.cancelSignal.promise,
		]);
		await this.assertAllowed();
		return result;
	}

	cancel(): void {
		if (this.cancelled || this.phase === 'done') return;
		this.cancelled = true;
		this.cancelSignal.reject(new SqlQueryCancelledError());
		void this.dispose();
	}

	dispose(): Promise<void> {
		if (this.cleanupPromise) return this.cleanupPromise;
		this.cleanupPromise = this.cleanup();
		return this.cleanupPromise;
	}

	whenDisposed(): Promise<void> {
		return this.cleanupComplete.promise;
	}

	private async executeCore(query: string): Promise<QueryResult> {
		await this.connect();
		await this.assertAllowed();
		this.phase = 'executing';
		const startedAt = Date.now();
		const deadline = this.timeoutMs && this.timeoutMs > 0 ? startedAt + this.timeoutMs : undefined;

		const acceptance = this.runGuardedRequest<unknown>(
			STS_METHODS.executeString,
			{ ownerUri: this.ownerUri, query, getFullColumnSchema: false },
			EXECUTE_ACCEPT_TIMEOUT_MS,
		);
		await Promise.race([acceptance, this.cancelSignal.promise]);

		const waitMs = remainingMs(deadline);
		if (waitMs === 0) throw new SqlQueryExecutionError('SQL query timed out.');
		const complete = waitMs === null
			? await Promise.race([this.queryComplete.promise, this.cancelSignal.promise])
			: await Promise.race([withTimeout(this.queryComplete.promise, waitMs, 'SQL query'), this.cancelSignal.promise]);
		this.throwIfCancelled();
		this.queryCompleted = true;
		await this.assertAllowed();

		const batches = complete.batchSummaries ?? [];
		const errors = this.messages.filter(message => message.isError).map(message => String(message.message || '').trim()).filter(Boolean);
		if (errors.length > 0 || batches.some(batch => batch.hasError)) {
			throw new SqlQueryExecutionError(errors[0] || 'SQL query execution failed.');
		}

		const selected = firstResultSet(batches);
		if (!selected) {
			await this.assertAllowed();
			return {
				columns: [], rows: [],
				metadata: { cluster: `sql://${this.connection.serverUrl}`, database: this.database, executionTime: parseExecutionTime(startedAt) },
			};
		}

		this.phase = 'paging';
		const rowCount = Number(selected.summary.rowCount ?? 0);
		if (!Number.isSafeInteger(rowCount) || rowCount < 0) {
			throw new SqlQueryExecutionError('SQL Tools Service returned an invalid row count.');
		}
		const rows = [] as NonNullable<NonNullable<StsSubsetResult['resultSubset']>['rows']>;
		while (rows.length < rowCount) {
			await this.assertAllowed();
			const pageDeadline = remainingMs(deadline);
			if (pageDeadline === 0) throw new SqlQueryExecutionError('SQL query timed out while reading results.');
			const requested = Math.min(SUBSET_PAGE_SIZE, rowCount - rows.length);
			const page = await this.runGuardedRequest<StsSubsetResult>(STS_METHODS.querySubset, {
					ownerUri: this.ownerUri,
					batchIndex: selected.batchIndex,
					resultSetIndex: selected.resultSetIndex,
					rowsStartIndex: rows.length,
					rowsCount: requested,
				}, pageDeadline === null ? SUBSET_TIMEOUT_MS : Math.min(SUBSET_TIMEOUT_MS, pageDeadline));
			const pageRows = page.resultSubset?.rows;
			if (!Array.isArray(pageRows) || pageRows.length === 0) {
				throw new SqlQueryExecutionError('SQL Tools Service returned an incomplete result set.');
			}
			if (pageRows.length > requested) {
				throw new SqlQueryExecutionError('SQL Tools Service returned more rows than requested.');
			}
			rows.push(...pageRows);
		}

		const result = createQueryResultFromSts(selected.summary.columnInfo ?? [], rows, {
			cluster: `sql://${this.connection.serverUrl}`,
			database: this.database,
			executionTime: parseExecutionTime(startedAt),
		});
		await this.assertAllowed();
		return result;
	}

	private async connect(): Promise<void> {
		if (this.connected) return;
		await this.assertAllowed();
		this.phase = 'connecting';
		const process = await this.runtime.getProcessManager();
		await this.assertAllowed();
		this.process = process;
		this.epoch = process.epoch;
		this.registerHandlers(process);

		const commandTimeoutSeconds = this.timeoutMs && this.timeoutMs > 0 ? Math.max(1, Math.ceil(this.timeoutMs / 1000)) : 0;
		const built = await buildStsConnectionOptions({
			connection: this.connection,
			database: this.database,
			connectionManager: this.connectionManager,
			context: this.context,
			purpose: 'data',
			commandTimeoutSeconds,
			passwordOverride: this.passwordOverride,
			allowUncommittedTarget: this.allowUncommittedTarget,
		});
		const options = built.options;
		if (String(this.connection.authType || '').trim().toLowerCase() === 'aad') {
			const resolvedAadAccountId = String(built.aadAccountId || '').trim() || undefined;
			if (!resolvedAadAccountId) throw new SqlQueryCancelledError('Sign-in cancelled');
			const resolvedFingerprint = sqlSchemaPrincipalFingerprintForPrincipal(this.connection, resolvedAadAccountId);
			if (!resolvedFingerprint || (this.principalFingerprint && this.principalFingerprint !== resolvedFingerprint)) {
				throw new Error('SQL principal changed while authentication was being resolved.');
			}
			this.resolvedAadAccountId = resolvedAadAccountId;
			this.principalFingerprint = resolvedFingerprint;
			this.principalCaptured = true;
		}
		await this.assertAllowed();
		const params: StsConnectParams = { ownerUri: this.ownerUri, connection: { options } };
		const acceptance = this.dispatchAllowed(() => {
			this.assertDispatchCurrent();
			this.connectSubmitted = true;
			return process.sendRequest<unknown>(STS_METHODS.connect, params, {
				timeoutMs: CONNECT_REQUEST_TIMEOUT_MS,
				expectedEpoch: this.epoch,
			});
		});
		const completion = withTimeout(this.connectComplete.promise, CONNECT_COMPLETE_TIMEOUT_MS, 'SQL connection');
		const [, connected] = await Promise.race([
			Promise.all([acceptance, completion]),
			this.cancelSignal.promise,
		]);
		await this.assertAllowed();
		if (!connected.connectionId) {
			throw new SqlQueryExecutionError(connected.errorMessage || connected.messages || 'SQL connection failed.');
		}
		this.connectCompleted = true;
		this.connected = true;
	}

	private registerHandlers(process: StsProcessManager): void {
		const accept = <T extends { ownerUri?: string }>(handler: (params: T) => void) => (params: T, epoch: number) => {
			if (epoch !== this.epoch || params?.ownerUri !== this.ownerUri || this.phase === 'done') return;
			handler(params);
		};
		this.subscriptions.push(
			process.onNotification(STS_METHODS.connectComplete, accept<StsConnectionCompleteParams>(params => this.connectComplete.resolve(params))),
			process.onNotification(STS_METHODS.queryMessage, accept<StsQueryMessageParams>(params => {
				if (params.message) this.messages.push(params.message);
			})),
			process.onNotification(STS_METHODS.queryComplete, accept<StsQueryCompleteParams>(params => this.queryComplete.resolve(params))),
			process.onDidEndEpoch(event => {
				if (event.epoch !== this.epoch || this.phase === 'done') return;
				const error = new SqlQueryExecutionError('SQL Tools Service stopped during the operation. The query outcome may be unknown.');
				this.connectComplete.reject(error);
				this.queryComplete.reject(error);
			}),
		);
	}

	private async cleanup(): Promise<void> {
		const previousPhase = this.phase;
		this.phase = 'cleaning';
		const process = this.process;
		try {
			if (process && process.epoch === this.epoch) {
				if (this.connectSubmitted && !this.connectCompleted) {
					await this.bestEffort(process, STS_METHODS.cancelConnect, { ownerUri: this.ownerUri });
				} else if (this.submitted && !this.queryCompleted && previousPhase === 'executing') {
					await this.bestEffort(process, STS_METHODS.queryCancel, { ownerUri: this.ownerUri });
				}
				if (this.submitted) await this.bestEffort(process, STS_METHODS.queryDispose, { ownerUri: this.ownerUri });
				if (this.connected || this.connectSubmitted || previousPhase === 'connecting') {
					await this.bestEffort(process, STS_METHODS.disconnect, { ownerUri: this.ownerUri });
				}
			}
		} finally {
			this.phase = 'done';
			for (const subscription of this.subscriptions.splice(0)) {
				try { subscription.dispose(); } catch { /* ignore */ }
			}
			this.cleanupComplete.resolve(undefined);
		}
	}

	private async bestEffort(process: StsProcessManager, method: string, params: unknown): Promise<void> {
		try {
			await process.sendRequest(method, params, { timeoutMs: CLEANUP_TIMEOUT_MS, expectedEpoch: this.epoch });
		} catch (error) {
			this.output.warn(`[sts] Cleanup request failed (${method}): ${sanitizeStsLogText(error instanceof Error ? error.message : error)}`);
		}
	}

	private throwIfCancelled(): void {
		if (this.cancelled) throw new SqlQueryCancelledError();
	}

	async assertCurrentOwner(): Promise<void> {
		await this.assertAllowed();
	}

	private assertDispatchCurrent(): void {
		this.throwIfCancelled();
		if (!this.process || this.process.epoch !== this.epoch || this.phase === 'cleaning' || this.phase === 'done') {
			throw new SqlQueryCancelledError();
		}
	}

	private async assertAllowed(): Promise<void> {
		this.throwIfCancelled();
		await this.leaveNoTracePolicy.assertAllowed(this.connection.id);
		if ((this.leaveNoTracePolicy.getRevocationGeneration?.(this.connection.id) ?? 0) !== this.revocationGeneration) {
			throw new SqlQueryCancelledError();
		}
		if (!this.allowUncommittedTarget) await this.connectionManager.assertConnectionCurrent(this.connection);
		const authType = String(this.connection.authType || '').trim().toLowerCase();
		const principal = authType === 'aad'
			? (await readCurrentSqlServerAccountMap(this.context))[normalizeSqlServerUrl(this.connection.serverUrl)]
			: String(this.connection.username || '').trim();
		const currentFingerprint = sqlSchemaPrincipalFingerprintForPrincipal(this.connection, principal);
		if (authType === 'aad' && this.resolvedAadAccountId) {
			const resolvedFingerprint = sqlSchemaPrincipalFingerprintForPrincipal(this.connection, this.resolvedAadAccountId);
			if (!resolvedFingerprint || currentFingerprint !== resolvedFingerprint) {
				throw new Error('SQL principal changed while the operation was running.');
			}
			this.principalFingerprint = resolvedFingerprint;
			this.principalCaptured = true;
			this.throwIfCancelled();
			return;
		}
		if (!this.principalCaptured) {
			this.principalFingerprint = currentFingerprint;
			this.principalCaptured = true;
		} else if (!this.principalFingerprint && currentFingerprint) {
			this.principalFingerprint = currentFingerprint;
		} else if (this.principalFingerprint !== currentFingerprint) {
			throw new Error('SQL principal changed while the operation was running.');
		}
		await this.leaveNoTracePolicy.assertAllowed(this.connection.id);
		this.throwIfCancelled();
	}

	private async dispatchAllowed<T>(dispatch: () => T | PromiseLike<T>): Promise<T> {
		if (!this.allowUncommittedTarget && this.dispatchSqlOwnerAllowed) {
			if (!this.principalFingerprint) throw new Error('SQL principal is unavailable before STS dispatch.');
			return this.dispatchSqlOwnerAllowed(this.connection, this.principalFingerprint, this.revocationGeneration, dispatch);
		}
		if (this.leaveNoTracePolicy.dispatchAllowed) {
			return this.leaveNoTracePolicy.dispatchAllowed(this.connection.id, dispatch, this.revocationGeneration);
		}
		await this.leaveNoTracePolicy.assertAllowed(this.connection.id);
		return await dispatch();
	}
}