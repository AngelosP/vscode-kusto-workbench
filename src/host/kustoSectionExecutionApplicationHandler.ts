import type { KustoConnection, ConnectionManager } from './connectionManager';
import {
	QueryExecutionError,
	type CancelableQueryExecution,
	type KustoQueryClient,
	type QueryResult,
} from './kustoClient';
import type { ConnectionService } from './queryEditorConnection';
import type { CacheUnit, IncomingWebviewMessage } from './queryEditorTypes';
import {
	type KustoExecutionLease,
	type KustoExecutionCoordinator,
} from './kustoExecutionCoordinator';
import type {
	KustoComparisonRunIdentity,
	KustoDispatchIdentity,
	KustoExecutionProducer,
	KustoExecutionRequestIdentity,
	KustoExecutionStarted,
	KustoSectionExecutionOutcome,
	KustoSectionExecutionTarget,
} from '../shared/kustoExecution';
import { getKustoConnectionIdentityKey } from '../shared/kustoAuth';
import {
	admitKustoPublicationWebviewMessage,
	parseKustoPublicationHostMessage,
} from '../shared/kustoPublicationProtocol';

type PendingAcknowledgement = {
	resolve: (accepted: boolean) => void;
	timer?: ReturnType<typeof setTimeout>;
};

export type KustoSectionQueryExecutionOptions = {
	target: KustoSectionExecutionTarget;
	executionId: string;
	producer: KustoExecutionProducer;
	comparisonRun?: KustoComparisonRunIdentity;
	copilotRequestId?: string;
	query: string;
	queryMode?: string;
	cacheEnabled?: boolean;
	cacheValue?: number;
	cacheUnit?: CacheUnit | string;
	persistSelection?: boolean;
	ensureResultsVisible?: boolean;
	notifyUserOnError?: boolean;
	preclaimedByWebview?: boolean;
};

export interface KustoSectionExecutionApplicationHandler {
	handleMessage(message: IncomingWebviewMessage): Promise<void> | undefined;
	postKustoPublication(message: unknown): Promise<boolean>;
	getKustoSectionExecutionTarget(boxId: string): KustoSectionExecutionTarget | undefined;
	cancelKustoSectionExecution(target: KustoSectionExecutionTarget, executionId: string): boolean;
	getKustoSectionExecutionAccountPartition(
		target: KustoSectionExecutionTarget,
		executionId: string,
	): string | undefined;
	getCurrentKustoConnectionForDispatch(
		connectionId: string,
		dispatch: KustoDispatchIdentity,
	): KustoConnection | undefined;
	executeKustoSectionQuery(
		options: KustoSectionQueryExecutionOptions,
	): Promise<KustoSectionExecutionOutcome<QueryResult>>;
	dispose(): void;
}

export type KustoSectionExecutionApplicationHandlerOptions = {
	coordinator: KustoExecutionCoordinator;
	kustoClient: Pick<KustoQueryClient,
		'executeQueryCancelable'
		| 'waitForProviderAccountRefresh'
		| 'getConnectionSessionGeneration'
		| 'getAccountPartition'>;
	connection: Pick<ConnectionService, 'saveLastSelection' | 'findConnection'>;
	connectionManager: Pick<ConnectionManager,
		'getConnections' | 'getConnectionIncarnation' | 'admitLeaveNoTraceRevision'>;
	postMessage(message: unknown): boolean | PromiseLike<boolean>;
	refreshConnectionsData(): Promise<void>;
	cancelKustoCopilotSection(boxId: string, sectionInstanceId: string): void;
	getErrorMessage(error: unknown): string;
	formatQueryExecutionErrorForUser(error: unknown, connection: KustoConnection, database?: string): string;
	logQueryExecutionError(
		error: unknown,
		connection: KustoConnection,
		database: string | undefined,
		boxId: string,
		query: string,
	): void;
	appendQueryMode(query: string, queryMode?: string): string;
	isControlCommand(query: string): boolean;
	normalizeControlCommandForExecution(query: string): string;
	buildCacheDirective(enabled?: boolean, value?: number, unit?: CacheUnit | string): string | undefined;
	showErrorMessage(message: string): void;
	isDisposed(): boolean;
	createPublicationId(): string;
	now(): number;
};

export class HostKustoSectionExecutionApplicationHandler
	implements KustoSectionExecutionApplicationHandler {
	private readonly pendingExecutionStartAcks = new Map<string, PendingAcknowledgement>();
	private readonly pendingPublicationAcks = new Map<string, PendingAcknowledgement>();
	private disposed = false;

	constructor(private readonly options: KustoSectionExecutionApplicationHandlerOptions) {}

	handleMessage(message: IncomingWebviewMessage): Promise<void> | undefined {
		const publicationAdmission = admitKustoPublicationWebviewMessage(message);
		if (publicationAdmission.recognized) {
			if (this.disposed || !publicationAdmission.parsed.ok) return Promise.resolve();
			this.settlePublicationAck(publicationAdmission.parsed.value);
			return Promise.resolve();
		}
		switch (message.type) {
			case 'kustoSectionOpen':
				if (this.disposed) return Promise.resolve();
				this.options.coordinator.openSection(message.boxId, message.sectionInstanceId);
				return Promise.resolve();
			case 'kustoSectionTarget':
				if (this.disposed) return Promise.resolve();
				this.options.coordinator.adoptTarget({
					boxId: message.boxId,
					sectionInstanceId: message.sectionInstanceId,
					targetGeneration: message.targetGeneration,
					connectionId: message.connectionId,
					database: message.database,
					connectionRevision: message.connectionRevision,
					connectionIdentityKey: message.connectionIdentityKey,
				});
				return Promise.resolve();
			case 'kustoSectionClose':
				if (this.disposed) return Promise.resolve();
				this.options.cancelKustoCopilotSection(message.boxId, message.sectionInstanceId);
				this.options.coordinator.closeSection(message.boxId, message.sectionInstanceId);
				return Promise.resolve();
			case 'kustoExecutionStartedAck':
				if (this.disposed) return Promise.resolve();
				this.settleExecutionStartAck(message);
				return Promise.resolve();
			case 'executeQuery':
				if (this.disposed) return Promise.resolve();
				return this.executeQueryFromWebview(message);
			case 'cancelQuery':
				if (this.disposed) return Promise.resolve();
				this.options.coordinator.cancelExpected({
					boxId: message.boxId,
					executionId: message.executionId,
					sectionInstanceId: message.sectionInstanceId,
					targetGeneration: message.targetGeneration,
				});
				return Promise.resolve();
			default:
				return undefined;
		}
	}

	async postKustoPublication(message: unknown): Promise<boolean> {
		if (this.disposed || this.options.isDisposed()) return false;
		const publicationId = `kusto-publication-${this.options.createPublicationId()}`;
		const publicationDeadline = this.options.now() + 5_000;
		const stageMessage = parseKustoPublicationHostMessage({
			type: 'kustoPublicationStage', publicationId, publicationDeadline, payload: message,
		});
		const commitMessage = parseKustoPublicationHostMessage({ type: 'kustoPublicationCommit', publicationId });
		const revokeMessage = parseKustoPublicationHostMessage({ type: 'kustoPublicationRevoke', publicationId });
		if (!stageMessage.ok || !commitMessage.ok || !revokeMessage.ok) return false;
		const waitForAck = (phase: 'staged' | 'applied', timeoutMs?: number): Promise<boolean> => new Promise(resolve => {
			const key = `${publicationId}:${phase}`;
			const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
				this.pendingPublicationAcks.delete(key);
				resolve(false);
			}, timeoutMs);
			this.pendingPublicationAcks.set(key, { resolve, ...(timer ? { timer } : {}) });
		});
		const settleTransportFailure = (phase: 'staged' | 'applied') => {
			const key = `${publicationId}:${phase}`;
			const pending = this.pendingPublicationAcks.get(key);
			if (!pending) return;
			this.pendingPublicationAcks.delete(key);
			if (pending.timer) clearTimeout(pending.timer);
			pending.resolve(false);
		};
		const staged = waitForAck('staged', 5_000);
		if (!await this.options.postMessage(stageMessage.value)) settleTransportFailure('staged');
		if (!await staged) return false;
		const applied = waitForAck('applied');
		const appliedKey = `${publicationId}:applied`;
		const appliedPending = this.pendingPublicationAcks.get(appliedKey);
		if (appliedPending) {
			appliedPending.timer = setTimeout(async () => {
				if (this.pendingPublicationAcks.get(appliedKey) !== appliedPending) return;
				appliedPending.timer = setTimeout(() => settleTransportFailure('applied'), 1_000);
				if (!await this.options.postMessage(revokeMessage.value)) {
					settleTransportFailure('applied');
				}
			}, Math.max(1, publicationDeadline - this.options.now()));
		}
		if (!await this.options.postMessage(commitMessage.value)) {
			settleTransportFailure('applied');
		}
		return applied;
	}

	getKustoSectionExecutionTarget(boxId: string): KustoSectionExecutionTarget | undefined {
		const owner = this.options.coordinator.getTarget(boxId);
		if (!owner?.connectionId || !owner.database) return undefined;
		return Object.freeze({
			engine: 'kusto',
			boxId: owner.boxId,
			sectionInstanceId: owner.sectionInstanceId,
			targetGeneration: owner.targetGeneration,
			connectionId: owner.connectionId,
			database: owner.database,
		});
	}

	cancelKustoSectionExecution(target: KustoSectionExecutionTarget, executionId: string): boolean {
		return this.options.coordinator.cancelExpected({
			boxId: target.boxId,
			executionId,
			sectionInstanceId: target.sectionInstanceId,
			targetGeneration: target.targetGeneration,
		});
	}

	getKustoSectionExecutionAccountPartition(
		target: KustoSectionExecutionTarget,
		executionId: string,
	): string | undefined {
		return this.options.coordinator.getDispatchAccountPartition({
			boxId: target.boxId,
			executionId,
			sectionInstanceId: target.sectionInstanceId,
			targetGeneration: target.targetGeneration,
		});
	}

	async executeKustoSectionQuery(
		options: KustoSectionQueryExecutionOptions,
	): Promise<KustoSectionExecutionOutcome<QueryResult>> {
		const { target } = options;
		const boxId = String(target.boxId || '').trim();
		const database = String(target.database || '').trim();
		const request: KustoExecutionRequestIdentity = {
			...target,
			executionId: String(options.executionId || '').trim(),
			producer: options.producer,
			query: options.query,
			...(options.comparisonRun ? { comparisonRun: options.comparisonRun } : {}),
			...(options.copilotRequestId ? { copilotRequestId: options.copilotRequestId } : {}),
		};
		const expectedPredecessorExecutionId = this.options.coordinator.getActive(boxId)?.executionId;
		let reservation;
		try {
			reservation = this.options.coordinator.reserve(request);
		} catch {
			if ((options.preclaimedByWebview || options.producer === 'manual' || options.producer === 'tool')
				&& !this.options.coordinator.hasExactActiveRequest(request)) {
				await this.options.coordinator.rejectPreclaimedRequest(request);
			}
			return { status: 'superseded', executionId: request.executionId };
		}
		if (!options.preclaimedByWebview && (options.producer === 'copilot' || options.producer === 'comparison')
			&& !await this.claimKustoExecutionInWebview(reservation, options.query, expectedPredecessorExecutionId)) {
			this.options.coordinator.cancelExpected(reservation);
			return { status: 'superseded', executionId: request.executionId };
		}
		if (options.persistSelection) {
			try {
				await this.options.connection.saveLastSelection(target.connectionId, database);
			} catch (error) {
				const userMessage = this.options.getErrorMessage(error);
				this.options.coordinator.fail(reservation, userMessage);
				return { status: 'failed', executionId: request.executionId, error: userMessage };
			}
		}

		const connection = this.options.connection.findConnection(target.connectionId);
		if (!connection) {
			this.options.coordinator.fail(reservation, 'Connection not found.');
			if (options.notifyUserOnError) this.options.showErrorMessage('Connection not found');
			return { status: 'failed', executionId: request.executionId, error: 'Connection not found.' };
		}

		if (!database) {
			this.options.coordinator.fail(reservation, 'Please select a database.');
			if (options.notifyUserOnError) this.options.showErrorMessage('Please select a database');
			return { status: 'failed', executionId: request.executionId, error: 'Please select a database.' };
		}

		const queryWithMode = this.options.appendQueryMode(options.query, options.queryMode);
		const isControl = this.options.isControlCommand(options.query);
		const cacheDirective = isControl
			? ''
			: this.options.buildCacheDirective(options.cacheEnabled, options.cacheValue, options.cacheUnit);
		const finalQuery = cacheDirective ? `${cacheDirective}\n${queryWithMode}` : queryWithMode;
		const executionQuery = this.options.normalizeControlCommandForExecution(finalQuery);

		const cancelClientKey = boxId ? `${boxId}::${connection.id}` : connection.id;
		let lease: KustoExecutionLease<CancelableQueryExecution> | undefined;
		let pendingDispatch: KustoDispatchIdentity | undefined;
		try {
			lease = this.options.coordinator.start(reservation, () => this.options.kustoClient.executeQueryCancelable(
				connection,
				database,
				executionQuery,
				cancelClientKey,
				{
					onDispatch: identity => {
						if (!lease) {
							pendingDispatch = identity;
							return;
						}
						if (!lease.captureDispatch(identity)) {
							throw new Error('Kusto execution was superseded before dispatch.');
						}
					},
				},
			));
			if (pendingDispatch && !lease.captureDispatch(pendingDispatch)) {
				throw new Error('Kusto execution was superseded before dispatch.');
			}
			const result = await lease.execution.promise;
			if (!lease.isCurrent()) return { status: 'superseded', executionId: request.executionId };
			await this.options.kustoClient.waitForProviderAccountRefresh();
			if (!lease.isCurrent()) return { status: 'superseded', executionId: request.executionId };
			await this.options.refreshConnectionsData();
			const dispatch = lease.getDispatch();
			const producingAccountPartition = dispatch?.accountPartition;
			const currentConnection = dispatch
				? this.getCurrentKustoConnectionForDispatch(connection.id, dispatch)
				: undefined;
			if (lease.isCurrent()
				&& dispatch
				&& currentConnection
				&& producingAccountPartition
				&& this.options.kustoClient.getConnectionSessionGeneration(connection) === dispatch.authSessionGeneration
				&& this.options.kustoClient.getAccountPartition(currentConnection) === producingAccountPartition) {
				const admission = await this.options.connectionManager.admitLeaveNoTraceRevision(
					dispatch.clusterEndpoint,
					dispatch.leaveNoTraceRevision,
					() => {
						const admittedConnection = this.getCurrentKustoConnectionForDispatch(connection.id, dispatch);
						return lease?.isCurrent() === true
							&& !!admittedConnection
							&& this.options.kustoClient.getConnectionSessionGeneration(connection)
								=== dispatch.authSessionGeneration
							&& this.options.kustoClient.getAccountPartition(admittedConnection)
								=== producingAccountPartition
							&& this.options.coordinator.succeed(
								reservation,
								result,
								options.ensureResultsVisible === true,
							);
					},
				);
				if (admission.admitted && admission.value === true) {
					return { status: 'success', executionId: request.executionId, result };
				}
			}
			this.options.coordinator.cancelExpected(reservation);
			return { status: 'superseded', executionId: request.executionId };
		} catch (error) {
			const cancellation = error && typeof error === 'object'
				? error as { name?: unknown; isCancelled?: unknown }
				: undefined;
			if (cancellation?.name === 'QueryCancelledError' || cancellation?.isCancelled === true) {
				this.options.coordinator.cancelExpected(reservation);
				return { status: 'cancelled', executionId: request.executionId };
			}
			if (this.options.coordinator.getActive(boxId)?.reservationSequence === reservation.reservationSequence) {
				this.options.logQueryExecutionError(error, connection, database, boxId, executionQuery);
				const userMessage = this.options.formatQueryExecutionErrorForUser(error, connection, database);
				const clientActivityId = error instanceof QueryExecutionError ? error.clientActivityId : undefined;
				if (options.notifyUserOnError) this.options.showErrorMessage(userMessage);
				this.options.coordinator.fail(reservation, userMessage, clientActivityId);
				return { status: 'failed', executionId: request.executionId, error: userMessage };
			}
			return { status: 'superseded', executionId: request.executionId };
		} finally {
			lease?.release();
		}
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.settleAll(this.pendingExecutionStartAcks);
		this.settleAll(this.pendingPublicationAcks);
	}

	private async executeQueryFromWebview(
		message: Extract<IncomingWebviewMessage, { type: 'executeQuery' }>,
	): Promise<void> {
		const boxId = String(message.boxId || '').trim();
		const database = String(message.database || '').trim();
		const target: KustoSectionExecutionTarget = {
			engine: 'kusto',
			boxId,
			sectionInstanceId: String(message.sectionInstanceId || '').trim(),
			targetGeneration: Number(message.targetGeneration),
			connectionId: String(message.connectionId || '').trim(),
			database,
		};
		await this.executeKustoSectionQuery({
			target,
			executionId: String(message.executionId || '').trim(),
			producer: message.producer ?? 'manual',
			comparisonRun: message.comparisonRun,
			query: message.query,
			queryMode: message.queryMode,
			cacheEnabled: message.cacheEnabled,
			cacheValue: message.cacheValue,
			cacheUnit: message.cacheUnit,
			persistSelection: true,
			notifyUserOnError: true,
			preclaimedByWebview: true,
		});
	}

	private executionAckKey(
		identity: Pick<KustoExecutionRequestIdentity,
			'boxId' | 'executionId' | 'sectionInstanceId' | 'targetGeneration'>,
	): string {
		return `${identity.boxId}\u0000${identity.sectionInstanceId}\u0000${identity.targetGeneration}\u0000${identity.executionId}`;
	}

	private async claimKustoExecutionInWebview(
		reservation: import('../shared/kustoExecution').KustoExecutionReservation,
		query: string,
		expectedPredecessorExecutionId?: string,
	): Promise<boolean> {
		const key = this.executionAckKey(reservation);
		const prior = this.pendingExecutionStartAcks.get(key);
		if (prior) {
			if (prior.timer) clearTimeout(prior.timer);
			prior.resolve(false);
		}
		const result = new Promise<boolean>(resolve => {
			const timer = setTimeout(() => {
				this.pendingExecutionStartAcks.delete(key);
				resolve(false);
			}, 5_000);
			this.pendingExecutionStartAcks.set(key, { resolve, timer });
		});
		const message: KustoExecutionStarted = {
			type: 'kustoExecutionStarted',
			...reservation,
			query,
			...(expectedPredecessorExecutionId ? { expectedPredecessorExecutionId } : {}),
		};
		const delivered = await this.options.postMessage(message);
		if (delivered !== true) {
			const pending = this.pendingExecutionStartAcks.get(key);
			if (pending) {
				this.pendingExecutionStartAcks.delete(key);
				if (pending.timer) clearTimeout(pending.timer);
				pending.resolve(false);
			}
		}
		return result;
	}

	private settleExecutionStartAck(
		message: Extract<IncomingWebviewMessage, { type: 'kustoExecutionStartedAck' }>,
	): void {
		const key = this.executionAckKey(message);
		const pending = this.pendingExecutionStartAcks.get(key);
		if (!pending) return;
		this.pendingExecutionStartAcks.delete(key);
		if (pending.timer) clearTimeout(pending.timer);
		pending.resolve(message.accepted === true);
	}

	private settlePublicationAck(
		message: Extract<IncomingWebviewMessage, { type: 'kustoPublicationAck' }>,
	): void {
		const key = `${message.publicationId}:${message.phase}`;
		const pending = this.pendingPublicationAcks.get(key);
		if (!pending) return;
		this.pendingPublicationAcks.delete(key);
		if (pending.timer) clearTimeout(pending.timer);
		pending.resolve(message.accepted === true);
	}

	getCurrentKustoConnectionForDispatch(
		connectionId: string,
		dispatch: KustoDispatchIdentity,
	): KustoConnection | undefined {
		const current = this.options.connectionManager.getConnections()
			.find(connection => connection.id === connectionId);
		return current
			&& this.options.connectionManager.getConnectionIncarnation(connectionId) === dispatch.connectionRevision
			&& getKustoConnectionIdentityKey(current.clusterUrl, current.authorityId) === dispatch.connectionIdentityKey
			&& this.options.kustoClient.getConnectionSessionGeneration(current) === dispatch.authSessionGeneration
			? current
			: undefined;
	}

	private settleAll(ledger: Map<string, PendingAcknowledgement>): void {
		const pendingAcks = [...ledger.values()];
		ledger.clear();
		for (const pending of pendingAcks) {
			if (pending.timer) clearTimeout(pending.timer);
			pending.resolve(false);
		}
	}
}