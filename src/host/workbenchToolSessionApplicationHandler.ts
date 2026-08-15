import type { ConnectionManager } from './connectionManager';
import type { SchemaService } from './queryEditorSchema';
import type { IncomingWebviewMessage } from './queryEditorTypes';
import type { SqlEditorLifecycleCoordinator } from './sql/sqlEditorLifecycleCoordinator';
import type { SqlReadyToolOwner } from './sql/sqlEditorSessionRegistry';
import { canonicalSectionKind } from '../shared/documentSectionCapabilities';
import { resolveKustoConnection, resolveStrictKustoConnection } from '../shared/kustoAuth';
import type { KustoExecutionRequestIdentity } from '../shared/kustoExecution';
import type { DevelopmentNoteMutationWebviewAdmission } from '../shared/developmentNoteMutationProtocol';
import {
	admitToolStateSnapshotWebviewMessage,
	createRequestToolStateMessage,
	type ToolStateSection,
	type ToolStateSnapshotWebviewMessage,
} from '../shared/toolStateSnapshotProtocol';

type WorkbenchToolSessionMessage = Extract<IncomingWebviewMessage, {
	type: 'toolExecutionStarted' | 'toolResponse';
}> | ToolStateSnapshotWebviewMessage;

type WorkbenchToolSection = ToolStateSection & {
	id?: string;
};

type WorkbenchToolSchemaRefreshResult = {
	schemas: Array<{
		clusterUrl: string;
		database: string;
		tables: string[];
		functions: string[];
	}>;
	error?: string;
};

export interface WorkbenchToolSessionOrchestrator {
	connect(
		poster: (message: unknown) => unknown,
		stateGetter: () => Promise<WorkbenchToolSection[] | undefined>,
		schemaRefresher: (clusterUrl: string, connectionId: string) => Promise<WorkbenchToolSchemaRefreshResult>,
		documentUri?: string,
		sqlConnectionResolver?: (sectionId?: string) => string | undefined,
		sqlOwnerResolver?: (sectionId: string) => SqlReadyToolOwner | undefined,
	): number;
	activateConnection(token: number): void;
	disconnectIfOwner(token: number): void;
	handleKustoExecutionStarted(requestId: string, owner: KustoExecutionRequestIdentity): void;
	handleDevelopmentNoteMutationResponse(message: unknown): boolean;
	handleDevelopmentNoteMutationResponseAdmission(
		admission: DevelopmentNoteMutationWebviewAdmission,
	): boolean;
	hasPendingDevelopmentNoteMutationResponse(): boolean;
	handleWebviewResponse(requestId: string, result: unknown, error?: string): void;
}

export interface WorkbenchToolSessionApplicationHandler {
	activate(): void;
	handleDevelopmentNoteMutationResponse(message: unknown): boolean;
	handleDevelopmentNoteMutationResponseAdmission?(
		admission: DevelopmentNoteMutationWebviewAdmission,
	): boolean;
	hasPendingDevelopmentNoteMutationResponse?(): boolean;
	handleMessage(message: IncomingWebviewMessage): Promise<void> | undefined;
	requestSectionsFromWebview(
		purpose?: 'schema-refresh',
		targetConnectionId?: string,
	): Promise<unknown[] | undefined>;
	dispose(): void;
}

export type WorkbenchToolSessionApplicationHandlerOptions = {
	getOrchestrator(): WorkbenchToolSessionOrchestrator | undefined;
	postMessage(message: unknown): boolean | PromiseLike<boolean>;
	isAvailable(): boolean;
	getDocumentUri(): string | undefined;
	connectionManager: Pick<ConnectionManager, 'getConnections'>;
	schema: Pick<SchemaService, 'refreshSchemaForTools'>;
	sqlLifecycle: Pick<SqlEditorLifecycleCoordinator,
		'getConnectionId' | 'getFirstConnectionId' | 'getReadyToolOwner' | 'reconcileComparisonOwners'>;
};

export class HostWorkbenchToolSessionApplicationHandler
implements WorkbenchToolSessionApplicationHandler {
	private disposed = false;
	private connectedOrchestrator: WorkbenchToolSessionOrchestrator | undefined;
	private connectionToken: number | undefined;
	private readonly stateResponseResolvers = new Map<string, {
		resolve: (sections: unknown[] | undefined) => void;
		timer: ReturnType<typeof setTimeout>;
	}>();

	constructor(private readonly options: WorkbenchToolSessionApplicationHandlerOptions) {}

	activate(): void {
		if (this.disposed) return;
		const orchestrator = this.options.getOrchestrator();
		if (!orchestrator) return;
		if (this.connectionToken !== undefined && this.connectedOrchestrator === orchestrator) {
			orchestrator.activateConnection(this.connectionToken);
			return;
		}
		this.disconnect();
		const token = orchestrator.connect(
			message => this.options.postMessage(message),
			async () => {
				const sections = await this.requestSectionsFromWebview();
				return sections as WorkbenchToolSection[] | undefined;
			},
			(clusterUrl, connectionId) => this.refreshSchema(clusterUrl, connectionId),
			this.options.getDocumentUri(),
			sectionId => {
				const id = String(sectionId || '').trim();
				return id ? this.options.sqlLifecycle.getConnectionId(id) : this.options.sqlLifecycle.getFirstConnectionId();
			},
			sectionId => {
				const id = String(sectionId || '').trim();
				return id ? this.options.sqlLifecycle.getReadyToolOwner(id) : undefined;
			},
		);
		this.connectedOrchestrator = orchestrator;
		this.connectionToken = token;
	}

	handleDevelopmentNoteMutationResponse(message: unknown): boolean {
		if (this.disposed) return false;
		return this.options.getOrchestrator()?.handleDevelopmentNoteMutationResponse(message) === true;
	}

	handleDevelopmentNoteMutationResponseAdmission(
		admission: DevelopmentNoteMutationWebviewAdmission,
	): boolean {
		if (this.disposed) return false;
		return this.options.getOrchestrator()
			?.handleDevelopmentNoteMutationResponseAdmission?.(admission) === true;
	}

	hasPendingDevelopmentNoteMutationResponse(): boolean {
		if (this.disposed) return false;
		return this.options.getOrchestrator()?.hasPendingDevelopmentNoteMutationResponse?.() === true;
	}

	handleMessage(message: IncomingWebviewMessage): Promise<void> | undefined {
		const stateAdmission = admitToolStateSnapshotWebviewMessage(message);
		if (stateAdmission.recognized) {
			if (this.disposed || !stateAdmission.parsed.ok) return Promise.resolve();
			this.routeMessage(stateAdmission.parsed.value);
			return Promise.resolve();
		}
		switch (message.type) {
			case 'toolExecutionStarted':
			case 'toolResponse':
				break;
			default:
				return undefined;
		}
		if (this.disposed) return Promise.resolve();
		this.routeMessage(message);
		return Promise.resolve();
	}

	requestSectionsFromWebview(
		purpose?: 'schema-refresh',
		targetConnectionId?: string,
	): Promise<unknown[] | undefined> {
		if (this.disposed || !this.options.isAvailable()) return Promise.resolve(undefined);

		const requestId = `state_${Date.now()}_${Math.random().toString(36).slice(2)}`;
		const request = createRequestToolStateMessage(requestId, purpose, targetConnectionId);
		if (!request.ok) return Promise.resolve(undefined);
		return new Promise(resolve => {
			const timer = setTimeout(() => this.settleStateRequest(requestId, undefined), 5000);
			this.stateResponseResolvers.set(requestId, { resolve, timer });

			let delivery: boolean | PromiseLike<boolean>;
			try {
				delivery = this.options.postMessage(request.value);
			} catch {
				this.settleStateRequest(requestId, undefined);
				return;
			}
			void Promise.resolve(delivery).then(delivered => {
				if (delivered === false) this.settleStateRequest(requestId, undefined);
			}, () => this.settleStateRequest(requestId, undefined));
		});
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const requestId of [...this.stateResponseResolvers.keys()]) {
			this.settleStateRequest(requestId, undefined);
		}
		this.disconnect();
	}

	private routeMessage(message: WorkbenchToolSessionMessage): void {
		const orchestrator = this.options.getOrchestrator();
		switch (message.type) {
			case 'toolExecutionStarted':
				orchestrator?.handleKustoExecutionStarted(message.requestId, message.owner);
				return;
			case 'toolResponse':
				if (message.requestId) {
					orchestrator?.handleWebviewResponse(message.requestId, message.result, message.error);
				}
				return;
			case 'toolStateResponse':
				this.settleStateRequest(message.requestId, message.error ? undefined : message.sections);
				return;
		}
	}

	private settleStateRequest(requestId: string, sections: unknown[] | undefined): void {
		const pending = this.stateResponseResolvers.get(requestId);
		if (!pending) return;
		this.stateResponseResolvers.delete(requestId);
		clearTimeout(pending.timer);
		if (sections) this.options.sqlLifecycle.reconcileComparisonOwners(sections);
		pending.resolve(sections);
	}

	private async refreshSchema(clusterUrl: string, connectionId: string): Promise<WorkbenchToolSchemaRefreshResult> {
		const sections = await this.requestSectionsFromWebview('schema-refresh', connectionId) ?? [];
		const connections = this.options.connectionManager.getConnections();
		const targets = sections.flatMap(section => {
			const candidate = section as {
				id?: unknown;
				type?: unknown;
				connectionId?: unknown;
				schemaRequestToken?: unknown;
				sectionInstanceId?: unknown;
				targetGeneration?: unknown;
				clusterUrl?: unknown;
				authorityId?: unknown;
				connectionIdHint?: unknown;
				database?: unknown;
			};
			if (canonicalSectionKind(candidate.type) !== 'query') return [];
			const boxId = String(candidate.id || '').trim();
			const database = String(candidate.database || '').trim();
			const runtimeConnectionId = String(candidate.connectionId || '').trim();
			const resolution = runtimeConnectionId
				? resolveStrictKustoConnection(connections, {
					clusterUrl: candidate.clusterUrl,
					connectionId: runtimeConnectionId,
				})
				: resolveKustoConnection(connections, candidate);
			return boxId && database && resolution.kind === 'matched' && resolution.connection.id === connectionId
				? [{
					boxId,
					database,
					requestToken: String(candidate.schemaRequestToken || '').trim() || undefined,
					...(typeof candidate.sectionInstanceId === 'string' && Number.isSafeInteger(candidate.targetGeneration)
						? { sectionInstanceId: candidate.sectionInstanceId, targetGeneration: Number(candidate.targetGeneration) }
						: {}),
				}]
				: [];
		});
		return this.options.schema.refreshSchemaForTools(clusterUrl, connectionId, targets);
	}

	private disconnect(): void {
		if (this.connectedOrchestrator && this.connectionToken !== undefined) {
			this.connectedOrchestrator.disconnectIfOwner(this.connectionToken);
		}
		this.connectedOrchestrator = undefined;
		this.connectionToken = undefined;
	}
}
