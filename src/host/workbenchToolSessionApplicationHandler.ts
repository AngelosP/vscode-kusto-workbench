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

export interface WorkbenchFileCloseLifecycle {
	inspectDirty(): Promise<boolean>;
	save(): Promise<void>;
}

export type KustoExecutionPreparation = (onReady: (isCurrent: () => boolean) => Promise<boolean>) => Promise<boolean>;

export interface WorkbenchToolSessionOrchestrator {
	connect(
		poster: (message: unknown, signal?: AbortSignal, isCurrent?: () => boolean) => unknown,
		stateGetter: () => Promise<WorkbenchToolSection[] | undefined>,
		schemaRefresher: (clusterUrl: string, connectionId: string) => Promise<WorkbenchToolSchemaRefreshResult>,
		documentUri?: string,
		sqlConnectionResolver?: (sectionId?: string) => string | undefined,
		sqlOwnerResolver?: (sectionId: string) => SqlReadyToolOwner | undefined,
		closeLifecycle?: WorkbenchFileCloseLifecycle,
		waitForMutationReady?: () => Promise<boolean>,
		reactivate?: () => Promise<boolean>,
		waitForReadReady?: () => Promise<boolean>,
		captureStateAdmission?: () => (() => boolean),
		prepareKustoExecution?: KustoExecutionPreparation,
		prepareSqlExecution?: () => Promise<void>,
		captureSqlSectionAdmission?: (sectionId: string) => (() => boolean),
	): number;
	activateConnection(token: number): boolean;
	isConnectionCurrent?(token: number): boolean;
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
	postMessage(message: unknown, signal?: AbortSignal, isCurrent?: () => boolean): boolean | PromiseLike<boolean>;
	isAvailable(): boolean;
	getDocumentUri(): string | undefined;
	getCloseLifecycle?(): WorkbenchFileCloseLifecycle | undefined;
	getMutationReadiness?(): (() => Promise<boolean>) | undefined;
	reactivate?(): Promise<boolean>;
	waitForReadReady?(): Promise<boolean>;
	captureStateAdmission?(): () => boolean;
	prepareKustoExecution?: KustoExecutionPreparation;
	prepareSqlExecution?(): Promise<void>;
	connectionManager: Pick<ConnectionManager, 'getConnections'>;
	schema: Pick<SchemaService, 'refreshSchemaForTools'>;
	sqlLifecycle: Pick<SqlEditorLifecycleCoordinator,
		'getConnectionId' | 'getFirstConnectionId' | 'getReadyToolOwner' | 'reconcileComparisonOwners'
		| 'getSectionInstanceId' | 'getGeneration'>;
};

export class HostWorkbenchToolSessionApplicationHandler
implements WorkbenchToolSessionApplicationHandler {
	private disposed = false;
	private connectedOrchestrator: WorkbenchToolSessionOrchestrator | undefined;
	private connectionToken: number | undefined;
	private readonly stateResponseResolvers = new Map<string, {
		resolve: (sections: unknown[] | undefined) => void;
		timer: ReturnType<typeof setTimeout>;
		controller: AbortController;
		isCurrent: () => boolean;
	}>();

	constructor(private readonly options: WorkbenchToolSessionApplicationHandlerOptions) {}

	activate(): void {
		if (this.disposed) return;
		const orchestrator = this.options.getOrchestrator();
		if (!orchestrator) return;
		if (this.connectionToken !== undefined && this.connectedOrchestrator === orchestrator) {
			if (orchestrator.activateConnection(this.connectionToken)) return;
		}
		this.disconnect();
		const token = orchestrator.connect(
			(message, signal, isCurrent) => isCurrent ? this.options.postMessage(message, signal, isCurrent)
				: signal ? this.options.postMessage(message, signal) : this.options.postMessage(message),
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
			this.options.getCloseLifecycle?.(),
			this.options.getMutationReadiness?.(),
			this.options.reactivate,
			this.options.waitForReadReady,
			this.options.captureStateAdmission,
			this.options.prepareKustoExecution,
			this.options.prepareSqlExecution,
			sectionId => {
				const id = String(sectionId || '').trim();
				const instance = this.options.sqlLifecycle.getSectionInstanceId(id);
				const generation = this.options.sqlLifecycle.getGeneration(id);
				if (!id || !instance || !Number.isSafeInteger(generation) || generation < 0) return () => false;
				return () => !this.disposed && this.options.sqlLifecycle.getSectionInstanceId(id) === instance
					&& this.options.sqlLifecycle.getGeneration(id) === generation;
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
		if (this.options.waitForReadReady) {
			const token = this.connectionToken;
			const orchestrator = this.connectedOrchestrator;
			return this.options.waitForReadReady().then(ready => ready && !this.disposed
				&& this.options.isAvailable() && token === this.connectionToken && orchestrator === this.connectedOrchestrator
				? this.postStateRequest(purpose, targetConnectionId) : undefined, () => undefined);
		}
		return this.postStateRequest(purpose, targetConnectionId);
	}

	private postStateRequest(purpose?: 'schema-refresh', targetConnectionId?: string): Promise<unknown[] | undefined> {
		const requestId = `state_${Date.now()}_${Math.random().toString(36).slice(2)}`;
		const request = createRequestToolStateMessage(requestId, purpose, targetConnectionId);
		if (!request.ok) return Promise.resolve(undefined);
		return new Promise(resolve => {
			const controller = new AbortController();
			const token = this.connectionToken;
			const orchestrator = this.connectedOrchestrator;
			const admission = this.options.captureStateAdmission?.() ?? (() => true);
			const isCurrent = () => token === this.connectionToken && orchestrator === this.connectedOrchestrator
				&& (token === undefined || orchestrator?.isConnectionCurrent?.(token) !== false) && admission();
			const timer = setTimeout(() => this.settleStateRequest(requestId, undefined), 5000);
			this.stateResponseResolvers.set(requestId, { resolve, timer, controller, isCurrent });

			let delivery: boolean | PromiseLike<boolean>;
			try {
				delivery = this.options.postMessage(request.value, controller.signal);
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
		pending.controller.abort();
		if (this.disposed || !this.options.isAvailable() || !pending.isCurrent()) sections = undefined;
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
		for (const requestId of [...this.stateResponseResolvers.keys()]) {
			this.settleStateRequest(requestId, undefined);
		}
		if (this.connectedOrchestrator && this.connectionToken !== undefined) {
			this.connectedOrchestrator.disconnectIfOwner(this.connectionToken);
		}
		this.connectedOrchestrator = undefined;
		this.connectionToken = undefined;
	}
}
