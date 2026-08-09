import { SqlQueryCancelledError, type SqlQueryClient } from './sqlClient';
import type { SqlConnectionManager } from './sqlConnectionManager';
import { appendSqlQueryMode } from './sqlEditorUtils';
import type { IncomingWebviewMessage } from './queryEditorTypes';
import type { SqlEditorLifecycleCoordinator } from './sql/sqlEditorLifecycleCoordinator';
import type {
	SqlExecutionAdmission,
	SqlExecutionBroker,
	SqlExecutionLease,
} from './sql/sqlExecutionBroker';
import type { SqlIssuedOwnerToken, SqlResultOwner } from './sql/sqlEditorSessionRegistry';
import { sanitizeStsLogText } from './sql/stsLogSanitizer';
import type { SqlWorkbenchService } from './sql/sqlWorkbenchService';
import type { WorkbenchLogger } from './workbenchLogger';

export interface SqlSectionExecutionApplicationHandler {
	handleMessage(message: IncomingWebviewMessage): Promise<void> | undefined;
	dispose(): void;
}

export type SqlSectionExecutionApplicationHandlerOptions = {
	sqlLifecycle: Pick<SqlEditorLifecycleCoordinator,
		'isSectionCurrent'
		| 'assertOwnerToken'
		| 'assertOwnerTokenProtection'
		| 'assertResultOwnerAllowed'
		| 'assertResultOwnerProtection'
		| 'dispatchResultOwnerAllowed'
		| 'dispatchResultOwnerProtection'>;
	sqlExecutionBroker: Pick<SqlExecutionBroker,
		'reservePreflight'
		| 'isPreflightCurrent'
		| 'clearPreflight'
		| 'promotePreflight'
		| 'isAdmissionCurrent'
		| 'start'
		| 'clearPending'
		| 'cancelExpected'>;
	sqlWorkbench: Pick<SqlWorkbenchService, 'isLeaveNoTraceConnection'>;
	connectionManager: Pick<SqlConnectionManager, 'getConnection'>;
	client: Pick<SqlQueryClient, 'executeQueryCancelable'>;
	postMessage(message: unknown): boolean | PromiseLike<boolean>;
	refreshConnectionsData(): PromiseLike<unknown>;
	output: Pick<WorkbenchLogger, 'warn' | 'error'>;
};

export class HostSqlSectionExecutionApplicationHandler
	implements SqlSectionExecutionApplicationHandler {
	private disposed = false;

	constructor(private readonly options: SqlSectionExecutionApplicationHandlerOptions) {}

	handleMessage(message: IncomingWebviewMessage): Promise<void> | undefined {
		switch (message.type) {
			case 'executeSqlQuery':
				if (this.disposed) return Promise.resolve();
				return this.executeSqlQuery(message);
			case 'cancelSqlQuery':
				if (this.disposed) return Promise.resolve();
				if (this.options.sqlLifecycle.isSectionCurrent(message.boxId, message.sectionInstanceId)) {
					this.options.sqlExecutionBroker.cancelExpected(message.boxId, message.executionId, true);
				}
				return Promise.resolve();
			default:
				return undefined;
		}
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
	}

	private async executeSqlQuery(
		message: Extract<IncomingWebviewMessage, { type: 'executeSqlQuery' }>,
	): Promise<void> {
		const boxId = String(message.boxId || '').trim();
		const executionId = String(message.executionId || '').trim();
		if (!boxId || !executionId
			|| !this.options.sqlLifecycle.isSectionCurrent(boxId, message.sectionInstanceId)) return;
		const comparisonSourceIdentity = message.comparisonSourceBoxId && message.comparisonSourceExecutionId
			? {
				comparisonSourceBoxId: String(message.comparisonSourceBoxId),
				comparisonSourceExecutionId: String(message.comparisonSourceExecutionId),
			}
			: {};

		const preflight = this.options.sqlExecutionBroker.reservePreflight(
			boxId,
			executionId,
			message.ownerToken,
		);
		const protectedExecution = this.options.sqlWorkbench.isLeaveNoTraceConnection(message.sqlConnectionId);
		let admission: SqlExecutionAdmission | undefined;
		let lease: SqlExecutionLease<ReturnType<SqlQueryClient['executeQueryCancelable']>> | undefined;
		const isStillActiveRun = () => {
			if (lease) return lease.isCurrent();
			if (admission) return this.options.sqlExecutionBroker.isAdmissionCurrent(admission);
			return this.options.sqlExecutionBroker.isPreflightCurrent(preflight);
		};
		const postCurrentError = (error: string, ownerToken?: string) => {
			const isCurrent = isStillActiveRun();
			this.options.sqlExecutionBroker.clearPreflight(preflight);
			if (!isCurrent) return;
			this.options.postMessage({
				type: 'queryError', error, boxId,
				...(ownerToken ? { ownerToken } : {}),
				executionId, ...comparisonSourceIdentity,
			});
		};
		let issuedOwner: SqlIssuedOwnerToken | undefined;
		try {
			issuedOwner = protectedExecution
				? await this.options.sqlLifecycle.assertOwnerTokenProtection(boxId, message.ownerToken, true)
				: await this.options.sqlLifecycle.assertOwnerToken(boxId, message.ownerToken);
			if (!isStillActiveRun()
				|| !this.options.sqlLifecycle.isSectionCurrent(boxId, message.sectionInstanceId)) {
				this.options.sqlExecutionBroker.clearPreflight(preflight);
				return;
			}
		} catch (error) {
			postCurrentError(error instanceof Error ? error.message : String(error), message.ownerToken);
			return;
		}

		const connection = this.options.connectionManager.getConnection(message.sqlConnectionId);
		if (!connection) {
			postCurrentError('SQL connection not found. Please configure a connection.', issuedOwner.token);
			return;
		}

		if (!message.database) {
			postCurrentError('Please select a database.', issuedOwner.token);
			return;
		}

		const resultOwner = issuedOwner.owner;
		if (resultOwner.connectionId !== connection.id || resultOwner.database !== message.database) {
			postCurrentError('SQL section target changed. Run the query again.', issuedOwner.token);
			return;
		}
		if (message.toolExecution) {
			const expected = message.expectedOwner;
			if (!message.executionId || !expected
				|| expected.connectionId !== resultOwner.connectionId
				|| expected.database !== resultOwner.database
				|| expected.targetSignature !== resultOwner.targetSignature
				|| expected.principalFingerprint !== resultOwner.principalFingerprint
				|| expected.revocationGeneration !== resultOwner.revocationGeneration) {
				postCurrentError('SQL tool execution owner changed before query dispatch.', issuedOwner.token);
				return;
			}
		}
		const queryWithMode = appendSqlQueryMode(message.query, message.queryMode);
		try {
			if (!isStillActiveRun()
				|| !this.options.sqlLifecycle.isSectionCurrent(boxId, message.sectionInstanceId)) return;
			admission = this.options.sqlExecutionBroker.promotePreflight(preflight);
			if (!admission) return;
			lease = this.options.sqlExecutionBroker.start(admission, () =>
				this.options.client.executeQueryCancelable(connection, message.database, queryWithMode));
			const result = await lease.execution.promise;
			if (isStillActiveRun()) {
				await this.options.refreshConnectionsData();
				if (protectedExecution) {
					await this.options.sqlLifecycle.assertResultOwnerProtection(boxId, resultOwner, true);
				} else {
					await this.options.sqlLifecycle.assertResultOwnerAllowed(boxId, resultOwner);
				}
				if (!isStillActiveRun()) return;
				const resultMessage = {
					type: 'queryResult', result, boxId, ownerToken: issuedOwner.token, executionId,
					query: message.query, connectionId: resultOwner.connectionId, database: resultOwner.database,
					...comparisonSourceIdentity,
				};
				if (protectedExecution) {
					await this.postSqlOwnerMessageProtection(
						boxId, resultOwner, true, resultMessage, isStillActiveRun,
					);
				} else {
					await this.postSqlOwnerMessageAllowed(boxId, resultOwner, resultMessage, isStillActiveRun);
				}
			}
		} catch (error) {
			if (isSqlCancellation(error)) {
				if (isStillActiveRun()) {
					try {
						const cancelledMessage = {
							type: 'queryCancelled', boxId, ownerToken: issuedOwner.token, executionId,
							...comparisonSourceIdentity,
						};
						if (protectedExecution) {
							await this.postSqlOwnerMessageProtection(
								boxId, resultOwner, true, cancelledMessage, isStillActiveRun,
							);
						} else {
							await this.postSqlOwnerMessageAllowed(
								boxId, resultOwner, cancelledMessage, isStillActiveRun,
							);
						}
					} catch { /* owner invalidation provides the terminal UI state */ }
				}
				return;
			}
			if (isStillActiveRun()) {
				const errorMessage = error instanceof Error ? error.message : String(error);
				try {
					const postError = () => {
						if (!isStillActiveRun()) return;
						if (protectedExecution) {
							this.options.output.warn('[sql-lnt] Isolated SQL query failed; details were not logged.');
						} else {
							this.options.output.error([
								`[${new Date().toISOString()}] SQL query execution failed`,
								`  boxId: ${boxId}`,
								`  error: ${sanitizeStsLogText(errorMessage)}`,
							].join('\n'));
						}
						this.options.postMessage({
							type: 'queryError', error: errorMessage, boxId,
							ownerToken: issuedOwner.token, executionId,
							...comparisonSourceIdentity,
						});
					};
					if (protectedExecution) {
						await this.options.sqlLifecycle.dispatchResultOwnerProtection(
							boxId, resultOwner, true, postError,
						);
					} else {
						await this.options.sqlLifecycle.dispatchResultOwnerAllowed(boxId, resultOwner, postError);
					}
				} catch {
					this.options.output.warn('[sql] Query failed after owner invalidation; error details suppressed.');
				}
			}
		} finally {
			this.options.sqlExecutionBroker.clearPreflight(preflight);
			if (admission) this.options.sqlExecutionBroker.clearPending(admission);
			lease?.release();
		}
	}

	private async postSqlOwnerMessageAllowed(
		boxId: string,
		expectedOwner: SqlResultOwner,
		message: Record<string, unknown>,
		isCurrent: () => boolean,
	): Promise<void> {
		await this.options.sqlLifecycle.dispatchResultOwnerAllowed(boxId, expectedOwner, () => {
			if (isCurrent()) this.options.postMessage(message);
		});
	}

	private async postSqlOwnerMessageProtection(
		boxId: string,
		expectedOwner: SqlResultOwner,
		expectedProtected: boolean,
		message: Record<string, unknown>,
		isCurrent: () => boolean,
	): Promise<void> {
		await this.options.sqlLifecycle.dispatchResultOwnerProtection(
			boxId,
			expectedOwner,
			expectedProtected,
			() => {
				if (isCurrent()) this.options.postMessage(message);
			},
		);
	}
}

function isSqlCancellation(error: unknown): boolean {
	return error instanceof SqlQueryCancelledError
		|| (typeof error === 'object' && error !== null
			&& 'isCancelled' in error
			&& (error as { isCancelled?: unknown }).isCancelled === true);
}
