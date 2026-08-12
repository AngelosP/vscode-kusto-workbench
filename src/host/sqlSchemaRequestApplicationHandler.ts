import type { SqlConnectionManager } from './sqlConnectionManager';
import type { SqlSchemaService } from './sqlEditorSchema';
import type { IncomingWebviewMessage } from './queryEditorTypes';
import {
	isSqlSchemaWebviewMessageType,
	parseSqlSchemaWebviewMessage,
	type SqlSchemaHostMessage,
	type SqlSchemaPrefetchRequest,
} from '../shared/sqlSchemaProtocol';
import type {
	SqlEditorLifecycleCoordinator,
	SqlSchemaRefreshRequest,
} from './sql/sqlEditorLifecycleCoordinator';
import {
	sqlResultOwnersEqual,
	type SqlResultOwner,
} from './sql/sqlEditorSessionRegistry';
import { sanitizeStsLogText } from './sql/stsLogSanitizer';
import type { WorkbenchLogger } from './workbenchLogger';

type SqlSchemaRequestConnection = NonNullable<ReturnType<SqlConnectionManager['getConnection']>>;

type ActiveSqlSchemaRequest = Readonly<{
	sequence: number;
	request: SqlSchemaRefreshRequest;
	owner: SqlResultOwner;
	connection: SqlSchemaRequestConnection;
	abortController: AbortController;
}>;

export interface SqlSchemaRequestApplicationHandler {
	handleMessage(message: IncomingWebviewMessage): Promise<void> | undefined;
	requestSchema(request: SqlSchemaRefreshRequest): Promise<void>;
	dispose(): void;
}

export type SqlSchemaRequestApplicationHandlerOptions = {
	lifecycle: Pick<SqlEditorLifecycleCoordinator,
		| 'adoptTarget'
		| 'dispatchResultOwnerAllowed'
		| 'getResultOwner'
		| 'isSectionCurrent'
		| 'isTargetCurrent'
	>;
	connectionManager: Pick<SqlConnectionManager, 'getConnection'>;
	getSchemaService: () => Pick<SqlSchemaService, 'getSchema'>;
	postMessage: (message: SqlSchemaHostMessage) => boolean | PromiseLike<boolean> | void;
	output: Pick<WorkbenchLogger, 'info' | 'error' | 'warn'>;
};

class SqlSchemaRequestSupersededError extends Error {
	constructor() {
		super('SQL schema request was superseded.');
		this.name = 'SqlSchemaRequestSupersededError';
	}
}

export class HostSqlSchemaRequestApplicationHandler implements SqlSchemaRequestApplicationHandler {
	private disposed = false;
	private requestSequence = 0;
	private readonly activeRequests = new Map<string, ActiveSqlSchemaRequest>();

	constructor(private readonly options: SqlSchemaRequestApplicationHandlerOptions) {}

	handleMessage(message: IncomingWebviewMessage): Promise<void> | undefined {
		if (!isSqlSchemaWebviewMessageType(message)) return undefined;
		const parsed = parseSqlSchemaWebviewMessage(message);
		if (!parsed.ok) return Promise.resolve();
		const request = parsed.value;
		if (this.disposed) return Promise.resolve();
		if (!this.options.lifecycle.adoptTarget(
			request.boxId,
			request.sectionInstanceId,
			request.sqlConnectionId,
			request.database,
			request.targetGeneration,
		)) return Promise.resolve();
		return this.reserveSchemaRequest(this.fromWebviewMessage(request));
	}

	requestSchema(request: SqlSchemaRefreshRequest): Promise<void> {
		if (this.disposed) return Promise.resolve();
		return this.reserveSchemaRequest(request);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const active of this.activeRequests.values()) active.abortController.abort();
		this.activeRequests.clear();
	}

	private fromWebviewMessage(message: SqlSchemaPrefetchRequest): SqlSchemaRefreshRequest {
		return {
			boxId: message.boxId,
			sectionInstanceId: message.sectionInstanceId,
			connectionId: message.sqlConnectionId,
			database: message.database,
			targetGeneration: message.targetGeneration,
			forceRefresh: !!message.forceRefresh,
		};
	}

	private reserveSchemaRequest(request: SqlSchemaRefreshRequest): Promise<void> {
		if (!this.options.lifecycle.isSectionCurrent(request.boxId, request.sectionInstanceId)
			|| !this.options.lifecycle.isTargetCurrent(
				request.boxId,
				request.connectionId,
				request.database,
				request.targetGeneration,
			)) return Promise.resolve();
		const owner = this.options.lifecycle.getResultOwner(request.boxId);
		const connection = this.options.connectionManager.getConnection(request.connectionId);
		if (!connection
			|| !owner
			|| owner.connectionId !== request.connectionId
			|| owner.database !== request.database
			|| owner.generation !== request.targetGeneration) return Promise.resolve();

		const previous = this.activeRequests.get(request.boxId);
		previous?.abortController.abort();
		const active: ActiveSqlSchemaRequest = Object.freeze({
			sequence: ++this.requestSequence,
			request: Object.freeze({ ...request }),
			owner,
			connection: Object.freeze({ ...connection }),
			abortController: new AbortController(),
		});
		this.activeRequests.set(request.boxId, active);
		return this.runSchemaRequest(active);
	}

	private isCurrent(active: ActiveSqlSchemaRequest): boolean {
		return !this.disposed
			&& !active.abortController.signal.aborted
			&& this.activeRequests.get(active.request.boxId) === active
			&& this.options.lifecycle.isSectionCurrent(
				active.request.boxId,
				active.request.sectionInstanceId,
			)
			&& this.options.lifecycle.isTargetCurrent(
				active.request.boxId,
				active.request.connectionId,
				active.request.database,
				active.request.targetGeneration,
			)
			&& sqlResultOwnersEqual(
				this.options.lifecycle.getResultOwner(active.request.boxId),
				active.owner,
			);
	}

	private assertCurrent(active: ActiveSqlSchemaRequest): void {
		if (!this.isCurrent(active)) throw new SqlSchemaRequestSupersededError();
	}

	private logInfo(message: string): void {
		try { this.options.output.info(message); } catch { /* Ignore logging failures. */ }
	}

	private logError(message: string): void {
		try { this.options.output.error(message); } catch { /* Ignore logging failures. */ }
	}

	private logWarning(message: string): void {
		try { this.options.output.warn(message); } catch { /* Ignore logging failures. */ }
	}

	private async runSchemaRequest(active: ActiveSqlSchemaRequest): Promise<void> {
		const { request, owner, connection } = active;
		try {
			this.logInfo(`[sql-schema] request forceRefresh=${request.forceRefresh}`);
			const { schema, fromCache } = await this.options.getSchemaService().getSchema(
				connection,
				request.database,
				request.forceRefresh,
				{
					signal: active.abortController.signal,
					expectedOwner: {
						principalFingerprint: owner.principalFingerprint,
						targetSignature: owner.targetSignature,
					},
					assertRequestCurrent: () => this.assertCurrent(active),
				},
			);
			this.assertCurrent(active);
			const tablesCount = schema.tables?.length ?? 0;
			let columnsCount = 0;
			if (schema.columnsByTable) {
				for (const table of Object.keys(schema.columnsByTable)) {
					columnsCount += Object.keys(schema.columnsByTable[table] || {}).length;
				}
			}
			await this.options.lifecycle.dispatchResultOwnerAllowed(request.boxId, owner, () => {
				this.assertCurrent(active);
				this.logInfo(`[sql-schema] loaded tables=${tablesCount} columns=${columnsCount} fromCache=${fromCache}`);
				return this.options.postMessage({
					type: 'sqlSchemaData',
					boxId: request.boxId,
					sectionInstanceId: request.sectionInstanceId,
					sqlConnectionId: request.connectionId,
					database: request.database,
					targetGeneration: owner.generation,
					serverUrl: connection.serverUrl,
					schema,
					schemaMeta: { fromCache, tablesCount, columnsCount },
				});
			});
		} catch (error) {
			if (!this.isCurrent(active)) return;
			const message = error instanceof Error ? error.message : String(error);
			try {
				await this.options.lifecycle.dispatchResultOwnerAllowed(request.boxId, owner, () => {
					this.assertCurrent(active);
					this.logError(`[sql-schema] error: ${sanitizeStsLogText(message)}`);
					return this.options.postMessage({
						type: 'sqlSchemaData',
						boxId: request.boxId,
						sectionInstanceId: request.sectionInstanceId,
						sqlConnectionId: request.connectionId,
						database: request.database,
						targetGeneration: owner.generation,
						serverUrl: connection.serverUrl,
						schema: null,
						schemaMeta: { error: true, errorMessage: message },
					});
				});
			} catch {
				if (this.isCurrent(active)) {
					this.logWarning('[sql-schema] Request failed after owner invalidation; details suppressed.');
				}
			}
		} finally {
			if (this.activeRequests.get(request.boxId) === active) {
				this.activeRequests.delete(request.boxId);
			}
		}
	}
}