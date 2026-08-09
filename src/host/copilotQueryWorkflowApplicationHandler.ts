import type { KustoCopilotRequestIdentity } from '../shared/kustoExecution';
import type { SqlQueryClient } from './sqlClient';
import type { SqlSchemaService } from './sqlEditorSchema';
import type { SqlConnectionManager } from './sqlConnectionManager';
import type { SqlExecutionBroker } from './sql/sqlExecutionBroker';
import type { SqlEditorLifecycleCoordinator } from './sql/sqlEditorLifecycleCoordinator';
import {
	SQL_COPILOT_OWNER_CHANGED_MESSAGE,
	type CopilotService,
} from './queryEditorCopilot';
import type { IncomingWebviewMessage } from './queryEditorTypes';

type StartCopilotWriteQueryMessage = Extract<IncomingWebviewMessage, {
	type: 'startCopilotWriteQuery';
}>;

type CancelCopilotWriteQueryMessage = Extract<IncomingWebviewMessage, {
	type: 'cancelCopilotWriteQuery';
}>;

const SQL_COPILOT_PREFLIGHT_EXECUTION_ID = 'sql-copilot-owner-preflight';

export interface CopilotQueryWorkflowApplicationHandler {
	handleMessage(message: IncomingWebviewMessage): Promise<void> | undefined;
	dispose(): void;
}

export type CopilotQueryWorkflowApplicationHandlerOptions = {
	copilot: Pick<CopilotService,
		'startCopilotWriteQuery'
		| 'cancelCopilotWriteQuery'
		| 'prepareOptimizeQuery'
		| 'cancelOptimizeQuery'
		| 'optimizeQueryWithCopilot'>;
	sqlExecutionBroker: Pick<SqlExecutionBroker,
		'reservePreflight' | 'clearPreflight' | 'cancelExpected'>;
	sqlLifecycle: Pick<SqlEditorLifecycleCoordinator, 'assertOwnerToken' | 'getOwnerToken'>;
	getSqlConnectionManager(): SqlConnectionManager;
	getSqlSchemaService(): SqlSchemaService;
	getSqlClient(): SqlQueryClient;
	postMessage(message: unknown): boolean | PromiseLike<boolean>;
};

export class HostCopilotQueryWorkflowApplicationHandler
	implements CopilotQueryWorkflowApplicationHandler {
	private disposed = false;

	constructor(private readonly options: CopilotQueryWorkflowApplicationHandlerOptions) {}

	handleMessage(message: IncomingWebviewMessage): Promise<void> | undefined {
		switch (message.type) {
			case 'startCopilotWriteQuery':
				if (this.disposed) return Promise.resolve();
				return this.startCopilotWriteQuery(message);
			case 'cancelCopilotWriteQuery':
				if (this.disposed) return Promise.resolve();
				this.cancelCopilotWriteQuery(message);
				return Promise.resolve();
			case 'prepareOptimizeQuery':
				if (this.disposed) return Promise.resolve();
				return this.options.copilot.prepareOptimizeQuery(message);
			case 'cancelOptimizeQuery':
				if (this.disposed) return Promise.resolve();
				this.options.copilot.cancelOptimizeQuery(message);
				return Promise.resolve();
			case 'optimizeQuery':
				if (this.disposed) return Promise.resolve();
				return this.options.copilot.optimizeQueryWithCopilot(message);
			default:
				return undefined;
		}
	}

	dispose(): void {
		this.disposed = true;
	}

	private async startCopilotWriteQuery(message: StartCopilotWriteQueryMessage): Promise<void> {
		if (message.flavor === 'sql') {
			const preflight = this.options.sqlExecutionBroker.reservePreflight(
				message.boxId,
				SQL_COPILOT_PREFLIGHT_EXECUTION_ID,
				message.sqlOwnerToken,
			);
			try {
				await this.options.sqlLifecycle.assertOwnerToken(message.boxId, message.sqlOwnerToken);
			} catch {
				if (this.options.sqlExecutionBroker.clearPreflight(preflight)) {
					this.options.postMessage({
						type: 'copilotWriteQueryDone',
						boxId: message.boxId,
						ok: false,
						message: SQL_COPILOT_OWNER_CHANGED_MESSAGE,
						ownerToken: String(message.sqlOwnerToken || ''),
					});
				}
				return;
			}
			if (!this.options.sqlExecutionBroker.clearPreflight(preflight)) return;
		}

		await this.options.copilot.startCopilotWriteQuery(
			message,
			this.options.getSqlConnectionManager(),
			this.options.getSqlSchemaService(),
			this.options.getSqlClient(),
		);
	}

	private cancelCopilotWriteQuery(message: CancelCopilotWriteQueryMessage): void {
		if (message.flavor === 'kusto') {
			const expectedRequest: KustoCopilotRequestIdentity = {
				boxId: message.boxId,
				copilotRequestId: message.copilotRequestId,
				sectionInstanceId: message.sectionInstanceId,
				targetGeneration: message.targetGeneration,
			};
			this.options.copilot.cancelCopilotWriteQuery(message.boxId, undefined, expectedRequest);
			return;
		}

		const canceledPreflight = this.options.sqlExecutionBroker.cancelExpected(
			message.boxId,
			SQL_COPILOT_PREFLIGHT_EXECUTION_ID,
			false,
		);
		if (canceledPreflight) {
			const ownerToken = this.options.sqlLifecycle.getOwnerToken(message.boxId);
			this.options.postMessage({
				type: 'copilotWriteQueryDone',
				boxId: message.boxId,
				ok: false,
				message: 'Canceled.',
				...(ownerToken ? { ownerToken } : {}),
			});
		}
		this.options.copilot.cancelCopilotWriteQuery(message.boxId);
	}
}