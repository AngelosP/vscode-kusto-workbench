import type * as vscode from 'vscode';

import type { QueryRunCoordinator } from '../queryRunCoordinator';
import type { SqlConnection } from '../sqlConnectionManager';
import { readCurrentSqlSchemaPrincipalFingerprint } from '../sqlEditorSchema';
import { sqlDatabaseTargetSignature } from '../sqlDatabaseCache';
import type { WorkbenchLogger } from '../workbenchLogger';
import { SqlExecutionBroker } from './sqlExecutionBroker';
import {
	SqlEditorSessionRegistry,
	sqlResultOwnersEqual,
	type SqlComparisonOwner,
	type SqlEditorTarget,
	type SqlIssuedOwnerToken,
	type SqlReadyToolOwner,
	type SqlResultOwner,
} from './sqlEditorSessionRegistry';
import { sanitizeStsLogText } from './stsLogSanitizer';
import { StsLanguageService, type StsExpectedOwner } from './stsLanguageService';
import type { StsProcessManager } from './stsProcessManager';
import type { SqlWorkbenchService } from './sqlWorkbenchService';

export type SqlEditorLanguageService = Pick<StsLanguageService,
	| 'onDiagnostics'
	| 'getCompletions'
	| 'getHover'
	| 'getSignatureHelp'
	| 'openDocument'
	| 'changeDocument'
	| 'closeDocumentForOwner'
	| 'closeDocumentUriForOwner'
	| 'connectDocument'
	| 'dispose'
>;

export type SqlDatabaseRequestTicket = Readonly<{
	requestId: string;
	boxId: string;
	sectionInstanceId: string;
	connectionId: string;
	targetGeneration: number;
	sessionEpoch: number;
}>;

type SqlConnectAttempt = Readonly<{
	sequence: number;
	sessionEpoch: number;
	languageEpoch: number;
}>;

type SqlProtectedPublicationTicket = Readonly<{
	sequence: number;
	sessionEpoch: number;
	sectionInstanceId: string;
	connectionId: string;
	database: string | undefined;
	targetGeneration: number;
	expectedRevocationGeneration: number;
	expectedConnectAttempt?: SqlConnectAttempt;
}>;

type SqlLanguageServiceInitialization = Readonly<{
	sessionEpoch: number;
	languageEpoch: number;
	promise: Promise<SqlEditorLanguageService | null>;
}>;

type ConnectionSnapshotRetry = Readonly<{
	sessionEpoch: number;
	timer: ReturnType<typeof setTimeout>;
}>;

type PendingLanguageRequest = Readonly<{
	sessionEpoch: number;
	boxId: string;
	sectionInstanceId: string;
	settleNull: () => void;
}>;

type SqlOwnerChangedPublication = Readonly<{
	message: Record<string, unknown>;
	boxId: string;
	sectionInstanceId: string;
	connectionId: string;
	database?: string;
	targetGeneration: number;
	retired: boolean;
	targetSignature?: string;
	principalFingerprint?: string;
	revocationGeneration: number;
	connectionEventEpoch?: number;
}>;

type SqlOwnerChangeReplay = Readonly<{
	publication: SqlOwnerChangedPublication;
	sessionEpoch: number;
	timer: ReturnType<typeof setTimeout>;
}>;

type SqlTokenPublicationClaim = {
	token: string;
	owner: SqlConnectAttempt | SqlProtectedPublicationTicket;
	acknowledged: boolean;
	stsOwner?: StsExpectedOwner;
};

type SqlProtectedPolicyBarrier = Readonly<{
	sessionEpoch: number;
	connectionId: string;
	revocationGeneration: number;
	ready: Promise<boolean>;
}>;

export interface SqlEditorLifecycleEffects {
	postMessage(message: unknown): boolean | PromiseLike<boolean>;
	cancelCopilotWriteQuery(boxId: string, expectedSequence?: number): void;
	cancelCopilotQueryTarget(sourceBoxId: string, targetBoxId: string, expectedSequence: number): void;
	invalidateSqlCopilot(connectionIds: readonly string[], comparisonBoxIds: readonly string[]): void;
	rejectPendingComparisonEnsures(sourceBoxId: string): void;
	invalidatePersistence(): void;
	refreshConnectionsData(): Promise<boolean>;
	prefetchSchema(connectionId: string, database: string, boxId: string, forceRefresh: boolean): Promise<void>;
}

export interface SqlEditorLifecycleCoordinatorOptions {
	context: vscode.ExtensionContext;
	sqlWorkbench: SqlWorkbenchService;
	queryRuns: QueryRunCoordinator;
	output: WorkbenchLogger;
	effects: SqlEditorLifecycleEffects;
	hasWebview: () => boolean;
	createLanguageService?: (processManager: StsProcessManager) => SqlEditorLanguageService;
	createRequestId?: () => string;
}

export class SqlEditorLifecycleCoordinator {
	private readonly ownership: SqlEditorSessionRegistry;
	readonly executionBroker: SqlExecutionBroker;

	private languageService?: SqlEditorLanguageService;
	private languageServiceInit?: SqlLanguageServiceInitialization;
	private disposed = false;
	private sessionEpoch = 0;
	private languageEpoch = 0;
	private readonly closedBoxIds = new Set<string>();
	private readonly openedBoxIds = new Set<string>();
	private readonly pendingTextByBoxId = new Map<string, string>();
	private readonly sectionInstanceIdByBoxId = new Map<string, string>();
	private readonly retiredSectionInstanceIdByBoxId = new Map<string, string>();
	private readonly databaseRequestIdByBoxId = new Map<string, string>();
	private databaseRequestSequence = 0;
	private readonly activeConnectAttemptByBoxId = new Map<string, SqlConnectAttempt>();
	private readonly connectSequenceByBoxId = new Map<string, number>();
	private readonly documentConnectAttemptByBoxId = new Map<string, SqlConnectAttempt>();
	private readonly changeSequenceByBoxId = new Map<string, number>();
	private readonly changeTailByBoxId = new Map<string, Promise<void>>();
	private readonly pendingLanguageRequestByKey = new Map<string, PendingLanguageRequest>();
	private readonly ownerChangeReplayByBoxId = new Map<string, SqlOwnerChangeReplay>();
	private readonly pendingRetirementByBoxId = new Map<string, SqlOwnerChangedPublication>();
	private readonly connectionEventEpochById = new Map<string, number>();
	private connectionEventSequence = 0;
	private readonly protectedPublicationSequenceByBoxId = new Map<string, number>();
	private readonly protectedPublicationTicketByBoxId = new Map<string, SqlProtectedPublicationTicket>();
	private readonly tokenPublicationClaimByBoxId = new Map<string, SqlTokenPublicationClaim>();
	private readonly protectedPolicyBarrierByConnectionId = new Map<string, SqlProtectedPolicyBarrier>();
	private connectionSignatureById: Map<string, string>;
	private connectionSnapshotRetry?: ConnectionSnapshotRetry;
	private subscriptions: vscode.Disposable[] = [];

	constructor(private readonly options: SqlEditorLifecycleCoordinatorOptions) {
		this.ownership = new SqlEditorSessionRegistry({
			context: options.context,
			sqlWorkbench: options.sqlWorkbench,
		});
		this.executionBroker = new SqlExecutionBroker({
			queryRuns: options.queryRuns,
			getOwnerToken: boxId => this.ownership.getOwnerToken(boxId),
			postMessage: message => options.effects.postMessage(message),
		});
		this.connectionSignatureById = new Map(options.sqlWorkbench.connectionManager.getConnections().map(connection => [
			connection.id,
			sqlDatabaseTargetSignature(connection),
		]));
	}

	startSession(): void {
		if (!this.disposed && this.subscriptions.length > 0) return;
		const previousLanguageService = this.languageService;
		this.clearConnectionSnapshotRetry();
		this.sessionEpoch += 1;
		this.languageEpoch += 1;
		this.protectedPublicationTicketByBoxId.clear();
		this.clearAllTokenPublicationClaims();
		this.protectedPolicyBarrierByConnectionId.clear();
		this.pendingLanguageRequestByKey.clear();
		this.clearAllOwnerChangeReplays();
		this.pendingRetirementByBoxId.clear();
		this.connectionEventEpochById.clear();
		this.connectionEventSequence = 0;
		this.activeConnectAttemptByBoxId.clear();
		this.languageService = undefined;
		this.languageServiceInit = undefined;
		this.openedBoxIds.clear();
		this.documentConnectAttemptByBoxId.clear();
		for (const target of this.ownership.listTargets()) this.retireChanges(target.boxId);
		try { previousLanguageService?.dispose(); } catch { /* ignore */ }
		this.disposed = false;
		this.connectionSignatureById = new Map(this.options.sqlWorkbench.connectionManager.getConnections().map(connection => [
			connection.id,
			sqlDatabaseTargetSignature(connection),
		]));
		this.activate();
	}

	activate(): void {
		if (this.subscriptions.length > 0 || this.disposed) return;
		const { sqlWorkbench } = this.options;
		this.subscriptions = [
			sqlWorkbench.onDidChangeLeaveNoTrace(change => {
				const sessionEpoch = this.sessionEpoch;
				try {
					this.applyLeaveNoTraceChange(
						change.connectionIds,
						change.invalidatedConnectionIds,
						change.disabledConnectionIds,
					);
				} catch {
					this.handleConnectionSnapshotFailure(
						sessionEpoch,
						'[sql-lnt] Leave No Trace change handling failed; scheduling a connection snapshot retry.',
					);
				}
			}),
			sqlWorkbench.runtime.onDidChangeProcessManager(change => {
				const sessionEpoch = this.sessionEpoch;
				void this.handleRuntimeManagerChangeForSession(!!change.current, sessionEpoch).catch(() => {
					if (this.isSessionEpochCurrent(sessionEpoch)) {
						this.options.output.warn('[sts] Runtime manager change handling failed.');
					}
				});
			}),
			sqlWorkbench.connectionManager.onDidChangeConnections(connections => {
				const sessionEpoch = this.sessionEpoch;
				void this.handleConnectionsChangedForSession(connections, sessionEpoch).catch(() => {
					this.handleConnectionSnapshotFailure(
						sessionEpoch,
						'[sql] Connection change handling failed; scheduling a connection snapshot retry.',
					);
				});
			}),
			sqlWorkbench.onDidChangeSqlPrincipals(change => {
				const sessionEpoch = this.sessionEpoch;
				void this.handlePrincipalsChangedForSession(
					change.connectionIds,
					sessionEpoch,
					change.establishedConnectionIds,
				).catch(() => {
					this.handleConnectionSnapshotFailure(
						sessionEpoch,
						'[sql] Principal change handling failed; scheduling a connection snapshot retry.',
					);
				});
			}),
		];
	}

	disposeSubscriptions(): void {
		for (const subscription of this.subscriptions.splice(0)) {
			try { subscription.dispose(); } catch { /* ignore */ }
		}
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.sessionEpoch += 1;
		this.languageEpoch += 1;
		this.protectedPublicationTicketByBoxId.clear();
		this.clearAllTokenPublicationClaims();
		this.protectedPolicyBarrierByConnectionId.clear();
		this.pendingLanguageRequestByKey.clear();
		this.clearAllOwnerChangeReplays();
		this.pendingRetirementByBoxId.clear();
		this.connectionEventEpochById.clear();
		this.connectionEventSequence = 0;
		this.clearConnectionSnapshotRetry();
		this.activeConnectAttemptByBoxId.clear();
		this.languageServiceInit = undefined;
		this.disposeSubscriptions();
		for (const { boxId } of this.ownership.listTargets()) {
			this.executionBroker.supersede(boxId);
		}
		for (const { boxId } of this.ownership.listComparisonOwners()) {
			this.executionBroker.supersede(boxId);
		}
		try { this.languageService?.dispose(); } catch { /* ignore */ }
		this.languageService = undefined;
		this.closedBoxIds.clear();
		this.openedBoxIds.clear();
		this.documentConnectAttemptByBoxId.clear();
		this.changeSequenceByBoxId.clear();
		this.changeTailByBoxId.clear();
		this.pendingTextByBoxId.clear();
		this.sectionInstanceIdByBoxId.clear();
		this.retiredSectionInstanceIdByBoxId.clear();
		this.databaseRequestIdByBoxId.clear();
		this.connectSequenceByBoxId.clear();
		this.executionBroker.clear();
		this.ownership.clear();
	}

	getResultOwner(boxId: string): SqlResultOwner | undefined {
		return this.ownership.getOwner(boxId);
	}

	getCanonicalResultOwner(boxId: string): Promise<SqlResultOwner | undefined> {
		return this.ownership.getCanonicalOwner(boxId);
	}

	dispatchResultOwnerAllowed<T>(
		boxId: string,
		expectedOwner: SqlResultOwner,
		dispatch: () => T | PromiseLike<T>,
	): Promise<T> {
		return this.ownership.dispatchOwnerAllowed(boxId, expectedOwner, dispatch);
	}

	dispatchResultOwnerProtection<T>(
		boxId: string,
		expectedOwner: SqlResultOwner,
		expectedProtected: boolean,
		dispatch: () => T | PromiseLike<T>,
	): Promise<T> {
		return this.ownership.dispatchOwnerProtection(boxId, expectedOwner, expectedProtected, dispatch);
	}

	assertResultOwnerAllowed(boxId: string, expectedOwner: SqlResultOwner): Promise<void> {
		return this.ownership.assertOwnerAllowed(boxId, expectedOwner);
	}

	assertResultOwnerProtection(boxId: string, expectedOwner: SqlResultOwner, expectedProtected: boolean): Promise<void> {
		return this.ownership.assertOwnerProtection(boxId, expectedOwner, expectedProtected);
	}

	assertOwnerToken(boxId: string, token: string | undefined): Promise<SqlIssuedOwnerToken> {
		return this.ownership.assertOwnerToken(boxId, token);
	}

	assertOwnerTokenProtection(
		boxId: string,
		token: string | undefined,
		expectedProtected: boolean,
	): Promise<SqlIssuedOwnerToken> {
		return this.ownership.assertOwnerTokenProtection(boxId, token, expectedProtected);
	}

	getOwnerToken(boxId: string): string | undefined {
		return this.ownership.getOwnerToken(boxId);
	}

	getConnectionId(boxId: string): string | undefined {
		return this.ownership.getConnectionId(boxId);
	}

	getFirstConnectionId(): string | undefined {
		return this.ownership.listTargets()[0]?.connectionId;
	}

	getReadyToolOwner(boxId: string): SqlReadyToolOwner | undefined {
		return this.ownership.getReadyToolOwner(boxId);
	}

	getTarget(boxId: string): SqlEditorTarget | undefined {
		return this.ownership.getTarget(boxId);
	}

	getGeneration(boxId: string): number {
		return this.ownership.getGeneration(boxId);
	}

	isTargetCurrent(boxId: string, connectionId: string, database: string | undefined, generation: number): boolean {
		return this.ownership.isTargetCurrent(boxId, connectionId, database, generation);
	}

	getSectionInstanceId(boxId: string): string | undefined {
		return this.sectionInstanceIdByBoxId.get(String(boxId || '').trim());
	}

	isSectionCurrent(boxId: string, sectionInstanceId: string): boolean {
		const id = String(boxId || '').trim();
		return !!id
			&& this.sectionInstanceIdByBoxId.get(id) === String(sectionInstanceId || '').trim()
			&& !this.closedBoxIds.has(id);
	}

	isSectionActive(boxId: string, sectionInstanceId: string): boolean {
		return this.isSectionCurrent(boxId, sectionInstanceId);
	}

	openSection(boxId: string, sectionInstanceId: string): void {
		const id = String(boxId || '').trim();
		const instanceId = String(sectionInstanceId || '').trim();
		if (!id || !instanceId) return;
		const previousInstanceId = this.sectionInstanceIdByBoxId.get(id);
		const retiredInstanceId = this.retiredSectionInstanceIdByBoxId.get(id);
		const isNewIncarnation = (!!previousInstanceId && previousInstanceId !== instanceId)
			|| (!previousInstanceId && !!retiredInstanceId && retiredInstanceId !== instanceId);
		if (previousInstanceId && previousInstanceId !== instanceId) {
			this.retireTargetState(id, this.ownership.getGeneration(id) + 1);
			this.pendingTextByBoxId.delete(id);
		}
		this.sectionInstanceIdByBoxId.set(id, instanceId);
		this.retiredSectionInstanceIdByBoxId.delete(id);
		this.closedBoxIds.delete(id);
		if (isNewIncarnation) {
			this.clearPendingRetirement(id);
			this.ownership.resetRetiredTarget(id);
		}
	}

	adoptTarget(
		boxId: string,
		sectionInstanceId: string,
		connectionId: string,
		database: string | undefined,
		targetGeneration: number,
	): boolean {
		const id = String(boxId || '').trim();
		if (!this.isSectionCurrent(id, sectionInstanceId)) return false;
		const previousStsOwner = this.getExpectedStsOwner(
			id,
			this.ownership.getIssuedOwner(id)?.owner ?? this.ownership.getOwner(id),
		);
		return this.ownership.adoptTarget(id, connectionId, database, targetGeneration, () => {
			this.ownership.removeComparisonOwner(id);
			this.invalidateProtectedPublication(id);
			this.clearTokenPublicationClaim(id, true);
			this.clearOwnerChangeReplay(id);
			this.clearPendingRetirement(id);
			this.retirePendingLanguageRequests(id, sectionInstanceId);
			this.executionBroker.supersede(id, { notifyWebview: true });
			if (previousStsOwner && this.openedBoxIds.delete(id)) {
				this.languageService?.closeDocumentForOwner(id, previousStsOwner);
			}
			this.documentConnectAttemptByBoxId.delete(id);
			this.retireChanges(id);
			this.activeConnectAttemptByBoxId.delete(id);
		}) !== 'rejected';
	}

	retireTarget(boxId: string, sectionInstanceId: string, targetGeneration: number): boolean {
		const id = String(boxId || '').trim();
		if (!this.isSectionCurrent(id, sectionInstanceId)) return false;
		const retired = this.retireTargetState(id, targetGeneration);
		if (retired) {
			this.clearOwnerChangeReplay(id);
			this.clearPendingRetirement(id);
		}
		return retired;
	}

	private retireTargetState(
		boxId: string,
		targetGeneration: number,
		expectedTarget?: SqlEditorTarget,
	): boolean {
		const previousStsOwner = this.getExpectedStsOwner(
			boxId,
			this.ownership.getIssuedOwner(boxId)?.owner ?? this.ownership.getOwner(boxId),
		);
		const comparisonOwners = this.ownership.listComparisonOwners()
			.filter(({ owner }) => owner.sourceBoxId === boxId);
		const staleTarget = {};
		let result: 'rejected' | 'unchanged' | 'changed';
		try {
			result = this.ownership.retireTarget(boxId, targetGeneration, () => {
				this.ownership.removeComparisonOwner(boxId);
				this.invalidateProtectedPublication(boxId);
				this.clearTokenPublicationClaim(boxId, true);
				this.clearOwnerChangeReplay(boxId);
				this.clearPendingRetirement(boxId);
				const sectionInstanceId = this.sectionInstanceIdByBoxId.get(boxId);
				if (sectionInstanceId) this.retirePendingLanguageRequests(boxId, sectionInstanceId);
				this.executionBroker.supersede(boxId, { notifyWebview: true });
				if (expectedTarget && !this.isCapturedTargetCurrent(expectedTarget)) throw staleTarget;
				for (const { boxId: comparisonBoxId, owner } of comparisonOwners) {
					this.executionBroker.supersede(comparisonBoxId, { notifyWebview: true });
					this.options.effects.cancelCopilotWriteQuery(comparisonBoxId);
					if (owner.copilotSequence !== undefined) {
						this.options.effects.cancelCopilotQueryTarget(boxId, comparisonBoxId, owner.copilotSequence);
					}
					if (expectedTarget && !this.isCapturedTargetCurrent(expectedTarget)) throw staleTarget;
				}
				this.options.effects.rejectPendingComparisonEnsures(boxId);
				this.options.effects.cancelCopilotWriteQuery(boxId);
				if (expectedTarget && !this.isCapturedTargetCurrent(expectedTarget)) throw staleTarget;
				if (previousStsOwner && this.openedBoxIds.delete(boxId)) {
					this.languageService?.closeDocumentForOwner(boxId, previousStsOwner);
				}
				if (expectedTarget && !this.isCapturedTargetCurrent(expectedTarget)) throw staleTarget;
				this.documentConnectAttemptByBoxId.delete(boxId);
				this.retireChanges(boxId);
				this.activeConnectAttemptByBoxId.delete(boxId);
				this.databaseRequestIdByBoxId.delete(boxId);
			});
		} catch (error) {
			if (error === staleTarget) return false;
			throw error;
		}
		if (result === 'changed') this.ownership.removeComparisonOwnersForSource(boxId);
		return result !== 'rejected';
	}

	getComparisonOwner(boxId: string): SqlComparisonOwner | undefined {
		return this.ownership.getComparisonOwner(boxId);
	}

	setComparisonOwner(boxId: string, owner: SqlComparisonOwner): void {
		this.ownership.setComparisonOwner(boxId, owner);
	}

	removeComparisonOwner(boxId: string): SqlComparisonOwner | undefined {
		return this.ownership.removeComparisonOwner(boxId);
	}

	listComparisonBoxIds(): readonly string[] {
		return this.ownership.listComparisonOwners().map(({ boxId }) => boxId);
	}

	reconcileComparisonOwners(sections: unknown[]): void {
		this.ownership.reconcileComparisonOwners(sections);
	}

	beginDatabaseRequest(
		connectionId: string,
		boxId: string,
		sectionInstanceId: string,
	): SqlDatabaseRequestTicket | undefined {
		if (!this.isSectionCurrent(boxId, sectionInstanceId)) return undefined;
		const target = this.ownership.getTarget(boxId);
		if (!target || target.connectionId !== connectionId) return undefined;
		const requestId = `${this.options.createRequestId?.()
			?? `sql-db-${Date.now()}-${Math.random().toString(16).slice(2)}`}:${++this.databaseRequestSequence}`;
		this.databaseRequestIdByBoxId.set(boxId, requestId);
		return Object.freeze({
			requestId,
			boxId,
			sectionInstanceId,
			connectionId,
			targetGeneration: target.generation,
			sessionEpoch: this.sessionEpoch,
		});
	}

	isDatabaseRequestCurrent(ticket: SqlDatabaseRequestTicket, database?: string): boolean {
		return this.isSessionEpochCurrent(ticket.sessionEpoch)
			&& this.databaseRequestIdByBoxId.get(ticket.boxId) === ticket.requestId
			&& this.isSectionCurrent(ticket.boxId, ticket.sectionInstanceId)
			&& this.ownership.isTargetCurrent(
				ticket.boxId,
				ticket.connectionId,
				database,
				ticket.targetGeneration,
			);
	}

	completeDatabaseRequest(ticket: SqlDatabaseRequestTicket): boolean {
		if (!this.isDatabaseRequestCurrent(ticket)) return false;
		this.databaseRequestIdByBoxId.delete(ticket.boxId);
		return true;
	}

	isDatabaseSectionOwnerCurrent(ticket: SqlDatabaseRequestTicket): boolean {
		return this.isSessionEpochCurrent(ticket.sessionEpoch)
			&& this.isSectionCurrent(ticket.boxId, ticket.sectionInstanceId)
			&& this.ownership.getConnectionId(ticket.boxId) === ticket.connectionId;
	}

	async handleLanguageRequest(
		requestId: string,
		method: string,
		params: {
			boxId: string;
			sectionInstanceId: string;
			line: number;
			column: number;
			ownerToken?: string;
			targetGeneration?: number;
		},
	): Promise<void> {
		const sessionEpoch = this.sessionEpoch;
		const languageEpoch = this.languageEpoch;
		const isSessionSectionCurrent = () => this.isSessionEpochCurrent(sessionEpoch)
			&& this.isSectionCurrent(params.boxId, params.sectionInstanceId);
		const isLanguageCurrent = (service?: SqlEditorLanguageService) =>
			this.isLanguageEpochCurrent(sessionEpoch, languageEpoch)
			&& this.isSectionCurrent(params.boxId, params.sectionInstanceId)
			&& (!service || this.languageService === service);
		if (!isLanguageCurrent()) return;
		this.options.output.info(`[sts-diag] handleStsRequest method=${method} boxId=${params.boxId} L${params.line}:${params.column}`);
		const pendingRequestKey = `${sessionEpoch}\0${params.boxId}\0${requestId}`;
		let settled = false;
		let pendingRequest: PendingLanguageRequest;
		const settle = (result: unknown, ownerToken: string, targetGeneration: number): boolean => {
			if (settled || !isSessionSectionCurrent()) return false;
			settled = true;
			if (this.pendingLanguageRequestByKey.get(pendingRequestKey) === pendingRequest) {
				this.pendingLanguageRequestByKey.delete(pendingRequestKey);
			}
			this.postMessageContained({
				type: 'stsResponse', boxId: params.boxId, sectionInstanceId: params.sectionInstanceId,
				requestId, result, ownerToken, targetGeneration,
			}, sessionEpoch, '[sts] Language response publication failed.');
			return true;
		};
		const settleNull = () => settle(
			null,
			String(params.ownerToken || ''),
			Number(params.targetGeneration),
		);
		pendingRequest = {
			sessionEpoch,
			boxId: params.boxId,
			sectionInstanceId: params.sectionInstanceId,
			settleNull,
		};
		this.pendingLanguageRequestByKey.set(pendingRequestKey, pendingRequest);
		try {
			const connectionId = this.ownership.getConnectionId(params.boxId);
			if (!connectionId
				|| this.options.sqlWorkbench.isLeaveNoTraceConnection(connectionId)
				|| !this.openedBoxIds.has(params.boxId)) {
				settleNull();
				return;
			}
			let expectedOwner: SqlResultOwner;
			let stsOwner: StsExpectedOwner;
			let issuedOwnerToken: string;
			try {
			const issued = await this.ownership.assertOwnerToken(params.boxId, params.ownerToken);
			if (!isSessionSectionCurrent()) return;
			if (!isLanguageCurrent()) {
				settleNull();
				return;
			}
			expectedOwner = issued.owner;
			const candidateStsOwner = this.getExpectedStsOwner(params.boxId, expectedOwner);
			if (!candidateStsOwner || candidateStsOwner.sectionInstanceId !== params.sectionInstanceId) {
				throw new Error('SQL language section instance changed.');
			}
			stsOwner = candidateStsOwner;
			issuedOwnerToken = issued.token;
			if (expectedOwner.connectionId !== connectionId
				|| expectedOwner.generation !== Number(params.targetGeneration)) {
				throw new Error('SQL language owner unavailable.');
			}
			} catch {
				settleNull();
				return;
			}
			const service = await this.ensureLanguageService();
			if (!isSessionSectionCurrent()) return;
			if (!isLanguageCurrent()) {
				settleNull();
				return;
			}
			if (!service) {
				this.options.output.warn('[sts-diag] handleStsRequest → svc=null, returning null');
				settleNull();
				return;
			}
			try {
				let result: unknown = null;
				switch (method) {
					case 'textDocument/completion':
						result = await service.getCompletions(params.boxId, params.line, params.column, stsOwner);
						break;
					case 'textDocument/hover':
						result = await service.getHover(params.boxId, params.line, params.column, stsOwner);
						break;
					case 'textDocument/signatureHelp':
						result = await service.getSignatureHelp(params.boxId, params.line, params.column, stsOwner);
						break;
					default:
						this.options.output.warn(`[sts] Unknown method: ${method}`);
				}
				if (!isSessionSectionCurrent()) return;
				if (!isLanguageCurrent(service)) {
					settleNull();
					return;
				}
				await this.ownership.assertOwnerAllowed(params.boxId, expectedOwner);
				if (!isSessionSectionCurrent()) return;
				if (!isLanguageCurrent(service)) {
					settleNull();
					return;
				}
				await this.ownership.dispatchOwnerAllowed(params.boxId, expectedOwner, () => {
					if (isLanguageCurrent(service)
						&& sqlResultOwnersEqual(this.ownership.getOwner(params.boxId), expectedOwner)) {
						settle(result, issuedOwnerToken, expectedOwner.generation);
					}
				});
				if (!settled && isSessionSectionCurrent()) settleNull();
			} catch (error) {
				if (!isSessionSectionCurrent()) return;
				if (!isLanguageCurrent(service)) {
					settleNull();
					return;
				}
				const message = error instanceof Error ? error.message : String(error);
				try {
					await this.ownership.dispatchOwnerAllowed(params.boxId, expectedOwner, () => {
						if (!isLanguageCurrent(service)
							|| !sqlResultOwnersEqual(this.ownership.getOwner(params.boxId), expectedOwner)) return;
						this.options.output.error(`[sts] Request error (${method}): ${sanitizeStsLogText(message)}`);
					});
				} catch {
					if (isLanguageCurrent(service)) {
						this.options.output.warn('[sts] Language request failed after owner invalidation; details suppressed.');
					}
				}
				if (!isSessionSectionCurrent()) return;
				settleNull();
			}
		} finally {
			if (this.pendingLanguageRequestByKey.get(pendingRequestKey) === pendingRequest) {
				this.pendingLanguageRequestByKey.delete(pendingRequestKey);
			}
		}
	}

	didOpen(boxId: string, sectionInstanceId: string, text: string): void {
		if (!this.isSectionCurrent(boxId, sectionInstanceId)) return;
		const id = String(boxId || '').trim();
		this.closedBoxIds.delete(id);
		this.pendingTextByBoxId.set(id, text);
		this.options.output.info(`[sts-diag] handleStsDidOpen boxId=${id} textLen=${text.length}`);
	}

	async didChange(boxId: string, sectionInstanceId: string, text: string): Promise<void> {
		const sessionEpoch = this.sessionEpoch;
		const languageEpoch = this.languageEpoch;
		const isCurrent = () => this.isLanguageEpochCurrent(sessionEpoch, languageEpoch)
			&& this.isSectionCurrent(boxId, sectionInstanceId);
		if (!isCurrent()) return;
		const id = String(boxId || '').trim();
		this.pendingTextByBoxId.set(id, text);
		const sequence = (this.changeSequenceByBoxId.get(id) ?? 0) + 1;
		this.changeSequenceByBoxId.set(id, sequence);
		const previous = this.changeTailByBoxId.get(id) ?? Promise.resolve();
		const change = previous.catch(() => undefined).then(async () => {
			if (this.changeSequenceByBoxId.get(id) !== sequence
				|| !isCurrent()
				|| !this.openedBoxIds.has(id)) return;
			const connectionId = this.ownership.getConnectionId(id);
			const service = this.languageService;
			if (!connectionId || !service) return;
			try {
				await this.options.sqlWorkbench.assertSqlConnectionAllowed(connectionId);
				if (this.changeSequenceByBoxId.get(id) !== sequence
					|| !isCurrent()
					|| this.languageService !== service
					|| !this.openedBoxIds.has(id)) return;
				await service.changeDocument(id, text, sectionInstanceId);
			} catch {
				// Policy changes close the owner through the shared policy subscription.
			}
		});
		this.changeTailByBoxId.set(id, change);
		try {
			await change;
		} finally {
			if (this.changeTailByBoxId.get(id) === change) this.changeTailByBoxId.delete(id);
		}
	}

	didClose(boxId: string, sectionInstanceId: string): void {
		if (!this.isSectionCurrent(boxId, sectionInstanceId)) return;
		const id = String(boxId || '').trim();
		this.invalidateProtectedPublication(id);
		this.clearTokenPublicationClaim(id, true);
		this.clearOwnerChangeReplay(id);
		this.clearPendingRetirement(id);
		this.retirePendingLanguageRequests(id, sectionInstanceId);
		const previousStsOwner = this.getExpectedStsOwner(
			id,
			this.ownership.getIssuedOwner(id)?.owner ?? this.ownership.getOwner(id),
		);
		this.ownership.removeComparisonOwner(id);
		const comparisonBoxIds = this.ownership.listComparisonOwners()
			.filter(({ owner }) => owner.sourceBoxId === id)
			.map(({ boxId: comparisonBoxId }) => comparisonBoxId);
		this.executionBroker.supersede(id, { notifyWebview: true });
		for (const comparisonBoxId of comparisonBoxIds) {
			this.executionBroker.supersede(comparisonBoxId, { notifyWebview: true });
		}
		this.options.effects.cancelCopilotWriteQuery(id);
		this.closedBoxIds.add(id);
		this.pendingTextByBoxId.delete(id);
		this.databaseRequestIdByBoxId.delete(id);
		for (const comparisonBoxId of comparisonBoxIds) {
			this.options.effects.cancelCopilotWriteQuery(comparisonBoxId);
		}
		if (previousStsOwner && this.openedBoxIds.delete(id)) {
			this.languageService?.closeDocumentForOwner(id, previousStsOwner);
		}
		this.documentConnectAttemptByBoxId.delete(id);
		this.retireChanges(id);
		this.ownership.removeTarget(id);
		this.ownership.removeComparisonOwnersForSource(id);
		this.activeConnectAttemptByBoxId.delete(id);
		this.retiredSectionInstanceIdByBoxId.set(id, sectionInstanceId);
		this.sectionInstanceIdByBoxId.delete(id);
		this.options.output.info(`[sts-diag] handleStsDidClose boxId=${id}`);
	}

	async connect(
		boxId: string,
		sectionInstanceId: string,
		connectionId: string,
		database: string,
		targetGeneration: number,
		expectedOwner?: {
			connectionId: string;
			database: string;
			targetSignature: string;
			principalFingerprint: string;
			revocationGeneration: number;
		},
	): Promise<void> {
		const id = String(boxId || '').trim();
		if (this.disposed) return;
		if (!this.adoptTarget(id, sectionInstanceId, connectionId, database, targetGeneration)) {
			this.options.output.info(`[sts-diag] handleStsConnect skipped closed boxId=${id || '(none)'}`);
			return;
		}
		const attempt = this.beginConnectAttempt(id);
		try {
			await this.connectCore(
				id,
				sectionInstanceId,
				connectionId,
				database,
				expectedOwner,
				attempt,
			);
		} finally {
			this.releaseTokenPublicationClaim(id, attempt);
			if (this.activeConnectAttemptByBoxId.get(id) === attempt) {
				this.activeConnectAttemptByBoxId.delete(id);
			}
		}
	}

	private async connectCore(
		id: string,
		sectionInstanceId: string,
		connectionId: string,
		database: string,
		expectedOwner: {
			connectionId: string;
			database: string;
			targetSignature: string;
			principalFingerprint: string;
			revocationGeneration: number;
		} | undefined,
		attempt: SqlConnectAttempt,
	): Promise<void> {
		this.options.output.info(`[sts-diag] handleStsConnect boxId=${id}`);
		const connection = this.options.sqlWorkbench.connectionManager.getConnection(connectionId);
		if (!connection) {
			this.options.output.warn('[sts-diag] handleStsConnect → connection not found');
			await this.postCurrentConnectError(id, sectionInstanceId, attempt, `SQL connection not found: ${connectionId}`);
			return;
		}
		const assertExpectedOwner = async () => {
			if (!expectedOwner) return;
			if (expectedOwner.connectionId !== connection.id
				|| expectedOwner.database !== database
				|| expectedOwner.targetSignature !== sqlDatabaseTargetSignature(connection)
				|| expectedOwner.revocationGeneration !== this.options.sqlWorkbench.leaveNoTracePolicy.getRevocationGeneration(connection.id)) {
				throw new Error('SQL tool execution target changed before STS connection.');
			}
			await this.options.sqlWorkbench.connectionManager.assertConnectionCurrent(connection);
			if (await readCurrentSqlSchemaPrincipalFingerprint(this.options.context, connection)
				!== expectedOwner.principalFingerprint) {
				throw new Error('SQL tool execution principal changed before STS connection.');
			}
		};
		if (this.options.sqlWorkbench.isLeaveNoTraceConnection(connection.id)) {
			if (!this.isCurrentConnect(id, attempt)) return;
			const policyReady = await this.waitForProtectedPolicyBarrier(connection.id, attempt.sessionEpoch);
			if (!this.isCurrentConnect(id, attempt)) return;
			if (!policyReady) {
				const ticket = this.beginProtectedPublication(id, sectionInstanceId, attempt);
				if (ticket) await this.postProtectedPreparationError(id, ticket);
				return;
			}
			await this.publishProtectedExecutionOwner(id, sectionInstanceId, attempt);
			return;
		}
		try {
			await this.options.sqlWorkbench.assertSqlConnectionAllowed(connection.id);
			await assertExpectedOwner();
		} catch (error) {
			await this.postCurrentConnectError(id, sectionInstanceId, attempt, error instanceof Error ? error.message : String(error));
			return;
		}
		if (!this.isCurrentConnect(id, attempt)) return;
		const resultOwner = await this.ownership.getCanonicalOwner(id);
		if (!this.isCurrentConnect(id, attempt)) return;
		if (!resultOwner || resultOwner.connectionId !== connection.id || resultOwner.database !== database) {
			await this.postCurrentConnectError(id, sectionInstanceId, attempt, 'SQL result owner changed before STS connection.');
			return;
		}
		if (expectedOwner && (expectedOwner.targetSignature !== resultOwner.targetSignature
			|| expectedOwner.principalFingerprint !== resultOwner.principalFingerprint
			|| expectedOwner.revocationGeneration !== resultOwner.revocationGeneration)) {
			await this.postCurrentConnectError(id, sectionInstanceId, attempt, 'SQL tool execution owner changed before STS connection.');
			return;
		}
		const stsOwner = this.getExpectedStsOwner(id, resultOwner);
		if (!stsOwner || stsOwner.sectionInstanceId !== sectionInstanceId) {
			await this.postCurrentConnectError(id, sectionInstanceId, attempt, 'SQL language section instance changed before STS connection.');
			return;
		}
		const service = await this.ensureLanguageService();
		if (!this.isCurrentConnect(id, attempt)) return;
		if (!service) {
			this.options.output.warn('[sts-diag] handleStsConnect → svc=null');
			await this.postCurrentConnectError(id, sectionInstanceId, attempt, 'SQL Tools Service unavailable');
			return;
		}
		let candidateUri = '';
		let connectAttempted = false;
		const closeCandidateOwner = (exactOnly = false) => {
			const documentAttempt = this.documentConnectAttemptByBoxId.get(id);
			const ownsDocument = documentAttempt === undefined || documentAttempt === attempt;
			if (candidateUri && ownsDocument && service.closeDocumentUriForOwner(id, candidateUri, stsOwner)) {
				this.openedBoxIds.delete(id);
				this.documentConnectAttemptByBoxId.delete(id);
				return true;
			}
			if (exactOnly || !connectAttempted) return false;
			if (service.closeDocumentForOwner(id, stsOwner)) {
				this.openedBoxIds.delete(id);
				this.documentConnectAttemptByBoxId.delete(id);
				return true;
			}
			return false;
		};
		try {
			await assertExpectedOwner();
			if (!this.isCurrentConnect(id, attempt)) return;
			if (!this.openedBoxIds.has(id)) {
				candidateUri = await service.openDocument(id, this.pendingTextByBoxId.get(id) || '', connection, stsOwner);
				if (!this.isCurrentConnect(id, attempt)) {
					closeCandidateOwner(true);
					return;
				}
				this.openedBoxIds.add(id);
				this.documentConnectAttemptByBoxId.set(id, attempt);
			} else {
				this.documentConnectAttemptByBoxId.set(id, attempt);
			}
			await assertExpectedOwner();
			if (!this.isCurrentConnect(id, attempt)) {
				closeCandidateOwner(true);
				return;
			}
			connectAttempted = true;
			await service.connectDocument(id, connection, database, stsOwner);
			if (!this.isCurrentConnect(id, attempt)) {
				closeCandidateOwner(true);
				return;
			}
			await this.options.sqlWorkbench.assertSqlConnectionAllowed(connection.id);
			if (!this.isCurrentConnect(id, attempt)) {
				closeCandidateOwner(true);
				return;
			}
			const connectedOwner = await this.ownership.getCanonicalOwner(id);
			if (!this.isCurrentConnect(id, attempt)) {
				closeCandidateOwner(true);
				return;
			}
			if (!connectedOwner || !sqlResultOwnersEqual(connectedOwner, resultOwner)) {
				throw new Error('SQL result owner changed before connection admission.');
			}
			const issuedOwner = await this.ownership.issueOwnerToken(
				id,
				connectedOwner,
				() => this.isCurrentConnect(id, attempt),
			);
			const ownerToken = issuedOwner.token;
			this.claimTokenPublication(id, ownerToken, attempt, stsOwner);
			if (!this.isCurrentConnect(id, attempt)) {
				closeCandidateOwner(true);
				return;
			}
			const readyDelivered = await this.postConnectMessageWithRetry(id, attempt, {
				type: 'stsConnectionState', boxId: id, sectionInstanceId, state: 'ready', ownerToken,
				connectionId: connectedOwner.connectionId, database: connectedOwner.database,
				targetGeneration: connectedOwner.generation,
			}, '[sts] Connection state publication failed.');
			if (readyDelivered) this.acknowledgeTokenPublication(id, ownerToken, attempt);
			if (!readyDelivered && this.isCurrentConnect(id, attempt)) {
				if (this.isUnacknowledgedTokenPublication(id, ownerToken, attempt)) closeCandidateOwner();
				await this.postCurrentConnectError(
					id,
					sectionInstanceId,
					attempt,
					'SQL connection state could not be delivered. Reconnect and retry.',
				);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (!this.isCurrentConnect(id, attempt)) {
				closeCandidateOwner(true);
				return;
			}
			closeCandidateOwner();
			this.options.output.error(`[sts-diag] handleStsConnect → FAILED boxId=${id}: ${sanitizeStsLogText(message)}`);
			await this.postCurrentConnectError(id, sectionInstanceId, attempt, message);
		}
	}

	async handleRuntimeManagerChange(hasCurrentManager: boolean): Promise<void> {
		await this.handleRuntimeManagerChangeForSession(hasCurrentManager, this.sessionEpoch);
	}

	private async handleRuntimeManagerChangeForSession(
		hasCurrentManager: boolean,
		sessionEpoch: number,
	): Promise<void> {
		if (!this.isSessionEpochCurrent(sessionEpoch)) return;
		if (!hasCurrentManager) {
			for (const pending of [...this.pendingLanguageRequestByKey.values()]) {
				if (pending.sessionEpoch === sessionEpoch
					&& this.isSectionCurrent(pending.boxId, pending.sectionInstanceId)) {
					pending.settleNull();
				}
			}
			this.languageEpoch += 1;
			this.activeConnectAttemptByBoxId.clear();
			const previousLanguageService = this.languageService;
			this.languageService = undefined;
			this.languageServiceInit = undefined;
			try { previousLanguageService?.dispose(); } catch { /* ignore */ }
			this.openedBoxIds.clear();
			this.documentConnectAttemptByBoxId.clear();
			for (const target of this.ownership.listTargets()) this.retireChanges(target.boxId);
			return;
		}
		const languageEpoch = this.languageEpoch;
		const initialization = this.languageServiceInit;
		if (initialization
			&& initialization.sessionEpoch === sessionEpoch
			&& initialization.languageEpoch === languageEpoch) {
			await initialization.promise;
			if (!this.isLanguageEpochCurrent(sessionEpoch, languageEpoch)) return;
		}
		for (const target of this.ownership.listTargets()) {
			if (!this.isLanguageEpochCurrent(sessionEpoch, languageEpoch)) return;
			const { boxId, connectionId, database, generation } = target;
			const sectionInstanceId = this.sectionInstanceIdByBoxId.get(boxId);
			if (!sectionInstanceId || !database || this.closedBoxIds.has(boxId)
				|| this.openedBoxIds.has(boxId) || this.hasActiveCurrentConnect(boxId)) continue;
			if (!this.ownership.isTargetCurrent(boxId, connectionId, database, generation)) continue;
			await this.connect(boxId, sectionInstanceId, connectionId, database, generation);
			if (!this.isLanguageEpochCurrent(sessionEpoch, languageEpoch)) return;
		}
	}

	async handleConnectionsChanged(connections: readonly SqlConnection[]): Promise<void> {
		await this.handleConnectionsChangedForSession(connections, this.sessionEpoch);
	}

	private async handleConnectionsChangedForSession(
		connections: readonly SqlConnection[],
		sessionEpoch: number,
	): Promise<void> {
		if (!this.isSessionEpochCurrent(sessionEpoch)) return;
		const previousSignatures = this.connectionSignatureById;
		const nextSignatures = new Map(connections.map(connection => [connection.id, sqlDatabaseTargetSignature(connection)]));
		const changedIds = new Set<string>();
		const removedIds = new Set<string>();
		for (const [connectionId, signature] of this.connectionSignatureById) {
			if (nextSignatures.get(connectionId) !== signature) {
				changedIds.add(connectionId);
				if (!nextSignatures.has(connectionId)) removedIds.add(connectionId);
			}
		}
		for (const connectionId of nextSignatures.keys()) {
			if (!this.connectionSignatureById.has(connectionId)) changedIds.add(connectionId);
		}
		for (const connectionId of changedIds) {
			this.connectionEventEpochById.set(connectionId, ++this.connectionEventSequence);
		}
		for (const [boxId, replay] of [...this.ownerChangeReplayByBoxId]) {
			if (changedIds.has(replay.publication.connectionId)) this.clearOwnerChangeReplay(boxId);
		}
		this.connectionSignatureById = nextSignatures;
		if (changedIds.size === 0) {
			await this.refreshConnectionsDataRequired(sessionEpoch);
			return;
		}
		const capturedTargets = this.ownership.listTargets();
		const ownerChangedMessages: SqlOwnerChangedPublication[] = [];
		this.options.effects.invalidatePersistence();
		const comparisonBoxIds = this.ownership.listComparisonOwners()
			.filter(({ owner }) => changedIds.has(owner.connectionId))
			.map(({ boxId }) => boxId);
		this.options.effects.invalidateSqlCopilot([...changedIds], comparisonBoxIds);
		for (const comparisonBoxId of comparisonBoxIds) {
			this.invalidateProtectedPublication(comparisonBoxId);
			this.executionBroker.supersede(comparisonBoxId, { notifyWebview: true });
		}
		for (const [boxId, pending] of [...this.pendingRetirementByBoxId]) {
			if (!removedIds.has(pending.connectionId)) continue;
			if (!this.isPendingRetirementTombstoneCurrent(pending)) {
				this.clearPendingRetirement(boxId, pending);
				continue;
			}
			const publication = this.restampPendingRetirement(pending);
			this.pendingRetirementByBoxId.set(boxId, publication);
			ownerChangedMessages.push(publication);
		}
		for (const target of capturedTargets) {
			if (!this.isSessionEpochCurrent(sessionEpoch)) return;
			if (!changedIds.has(target.connectionId)) continue;
			if (!this.isCapturedTargetCurrent(target)) continue;
			this.invalidateProtectedPublication(target.boxId);
			if (removedIds.has(target.connectionId)) {
				const retiredOwner = this.ownership.getIssuedOwner(target.boxId)?.owner
					?? this.ownership.getOwner(target.boxId);
				const retiredTargetSignature = previousSignatures.get(target.connectionId);
				const sectionInstanceId = this.sectionInstanceIdByBoxId.get(target.boxId);
				const retired = sectionInstanceId && this.isSectionCurrent(target.boxId, sectionInstanceId)
					? this.retireTargetState(target.boxId, target.generation + 1, target)
					: !sectionInstanceId && this.retireTargetState(target.boxId, target.generation + 1, target);
				if (retired && sectionInstanceId) {
					const publication: SqlOwnerChangedPublication = {
						message: {
							type: 'sqlConnectionOwnerChanged', boxId: target.boxId, sectionInstanceId,
							connectionId: target.connectionId, targetGeneration: target.generation + 1,
							retired: true,
						},
						boxId: target.boxId,
						sectionInstanceId,
						connectionId: target.connectionId,
						targetGeneration: target.generation + 1,
						retired: true,
						database: target.database,
						targetSignature: retiredOwner?.targetSignature ?? retiredTargetSignature,
						principalFingerprint: retiredOwner?.principalFingerprint,
						revocationGeneration:
							this.options.sqlWorkbench.leaveNoTracePolicy.getRevocationGeneration(target.connectionId),
						connectionEventEpoch: this.connectionEventEpochById.get(target.connectionId),
					};
					this.pendingRetirementByBoxId.set(target.boxId, publication);
					ownerChangedMessages.push(publication);
				}
				continue;
			}
			const previousStsOwner = this.getExpectedStsOwner(
				target.boxId,
				this.ownership.getIssuedOwner(target.boxId)?.owner ?? this.ownership.getOwner(target.boxId),
			);
			const currentSectionInstanceId = this.sectionInstanceIdByBoxId.get(target.boxId);
			if (currentSectionInstanceId) {
				this.retirePendingLanguageRequests(target.boxId, currentSectionInstanceId);
			}
			this.executionBroker.supersede(target.boxId, { notifyWebview: true });
			if (!this.isCapturedTargetCurrent(target)) continue;
			const rotatedTarget = this.ownership.rotateTargetOwner(target.boxId);
			this.databaseRequestIdByBoxId.delete(target.boxId);
			if (previousStsOwner && this.openedBoxIds.delete(target.boxId)) {
				this.languageService?.closeDocumentForOwner(target.boxId, previousStsOwner);
			}
			if (!rotatedTarget || !this.isCapturedTargetCurrent(rotatedTarget)) continue;
			this.documentConnectAttemptByBoxId.delete(target.boxId);
			this.retireChanges(target.boxId);
			this.activeConnectAttemptByBoxId.delete(target.boxId);
			const sectionInstanceId = this.sectionInstanceIdByBoxId.get(target.boxId);
			if (rotatedTarget && sectionInstanceId) {
				ownerChangedMessages.push({
					message: {
						type: 'sqlConnectionOwnerChanged', boxId: target.boxId, sectionInstanceId,
						connectionId: target.connectionId, targetGeneration: rotatedTarget.generation,
					},
					boxId: target.boxId,
					sectionInstanceId,
					connectionId: rotatedTarget.connectionId,
					database: rotatedTarget.database,
					targetGeneration: rotatedTarget.generation,
					retired: false,
					targetSignature: this.ownership.getOwner(target.boxId)?.targetSignature,
					principalFingerprint: this.ownership.getOwner(target.boxId)?.principalFingerprint,
					revocationGeneration:
						this.options.sqlWorkbench.leaveNoTracePolicy.getRevocationGeneration(rotatedTarget.connectionId),
					connectionEventEpoch: this.connectionEventEpochById.get(rotatedTarget.connectionId),
				});
			}
		}
		for (const publication of ownerChangedMessages) {
			if (!this.isSessionEpochCurrent(sessionEpoch)) return;
			await this.publishOwnerChangeWithRetry(publication, sessionEpoch);
		}
		if (!this.isSessionEpochCurrent(sessionEpoch)) return;
		await this.refreshConnectionsDataRequired(sessionEpoch);
		for (const connectionId of removedIds) this.pruneConnectionEventEpoch(connectionId);
	}

	async handlePrincipalsChanged(
		connectionIds: readonly string[],
		establishedConnectionIds: readonly string[] = [],
	): Promise<void> {
		await this.handlePrincipalsChangedForSession(
			connectionIds,
			this.sessionEpoch,
			establishedConnectionIds,
		);
	}

	private async handlePrincipalsChangedForSession(
		connectionIds: readonly string[],
		sessionEpoch: number,
		establishedConnectionIds: readonly string[] = [],
	): Promise<void> {
		if (!this.isSessionEpochCurrent(sessionEpoch)) return;
		const allChangedIds = new Set(connectionIds);
		if (allChangedIds.size === 0) return;
		const establishedIds = new Set(establishedConnectionIds);
		const changedIds = new Set([...allChangedIds].filter(connectionId => !establishedIds.has(connectionId)));
		if (changedIds.size === 0) {
			await this.refreshConnectionsDataRequired(sessionEpoch);
			return;
		}
		const capturedTargets = this.ownership.listTargets();
		const ownerChangedMessages: SqlOwnerChangedPublication[] = [];
		const schemaTargets: Array<{
			boxId: string;
			connectionId: string;
			database: string;
			generation: number;
		}> = [];
		this.options.effects.invalidatePersistence();
		const comparisonBoxIds = this.ownership.listComparisonOwners()
			.filter(({ owner }) => changedIds.has(owner.connectionId))
			.map(({ boxId }) => boxId);
		this.options.effects.invalidateSqlCopilot([...changedIds], comparisonBoxIds);
		for (const comparisonBoxId of comparisonBoxIds) {
			this.invalidateProtectedPublication(comparisonBoxId);
			this.executionBroker.supersede(comparisonBoxId, { notifyWebview: true });
		}
		for (const target of capturedTargets) {
			if (!this.isSessionEpochCurrent(sessionEpoch)) return;
			if (!changedIds.has(target.connectionId)) continue;
			if (!this.isCapturedTargetCurrent(target)) continue;
			this.invalidateProtectedPublication(target.boxId);
			const previousStsOwner = this.getExpectedStsOwner(
				target.boxId,
				this.ownership.getIssuedOwner(target.boxId)?.owner ?? this.ownership.getOwner(target.boxId),
			);
			const currentSectionInstanceId = this.sectionInstanceIdByBoxId.get(target.boxId);
			if (currentSectionInstanceId) {
				this.retirePendingLanguageRequests(target.boxId, currentSectionInstanceId);
			}
			this.executionBroker.supersede(target.boxId, { notifyWebview: true });
			if (!this.isCapturedTargetCurrent(target)) continue;
			const rotatedTarget = this.ownership.rotateTargetOwner(target.boxId);
			if (previousStsOwner && this.openedBoxIds.delete(target.boxId)) {
				this.languageService?.closeDocumentForOwner(target.boxId, previousStsOwner);
			}
			if (!rotatedTarget || !this.isCapturedTargetCurrent(rotatedTarget)) continue;
			this.documentConnectAttemptByBoxId.delete(target.boxId);
			this.retireChanges(target.boxId);
			this.activeConnectAttemptByBoxId.delete(target.boxId);
			const sectionInstanceId = this.sectionInstanceIdByBoxId.get(target.boxId);
			if (rotatedTarget && sectionInstanceId) {
				ownerChangedMessages.push({
					message: {
						type: 'sqlConnectionOwnerChanged', boxId: target.boxId, sectionInstanceId,
						connectionId: target.connectionId, targetGeneration: rotatedTarget.generation,
					},
					boxId: target.boxId,
					sectionInstanceId,
					connectionId: rotatedTarget.connectionId,
					database: rotatedTarget.database,
					targetGeneration: rotatedTarget.generation,
					retired: false,
					targetSignature: this.ownership.getOwner(target.boxId)?.targetSignature,
					principalFingerprint: this.ownership.getOwner(target.boxId)?.principalFingerprint,
					revocationGeneration:
						this.options.sqlWorkbench.leaveNoTracePolicy.getRevocationGeneration(rotatedTarget.connectionId),
				});
				if (rotatedTarget.database) {
					schemaTargets.push({
						boxId: target.boxId,
						connectionId: rotatedTarget.connectionId,
						database: rotatedTarget.database,
						generation: rotatedTarget.generation,
					});
				}
			}
		}
		let ownerChangesDelivered = true;
		for (const publication of ownerChangedMessages) {
			if (!this.isSessionEpochCurrent(sessionEpoch)) return;
			ownerChangesDelivered = await this.publishOwnerChangeWithRetry(publication, sessionEpoch)
				&& ownerChangesDelivered;
		}
		if (!this.isSessionEpochCurrent(sessionEpoch)) return;
		if (!await this.refreshConnectionsDataRequired(sessionEpoch)) return;
		if (!ownerChangesDelivered) return;
		for (const target of schemaTargets) {
			if (!this.isSessionEpochCurrent(sessionEpoch)) return;
			if (!this.ownership.isTargetCurrent(
				target.boxId,
				target.connectionId,
				target.database,
				target.generation,
			)) continue;
			await this.options.effects.prefetchSchema(target.connectionId, target.database, target.boxId, false);
		}
	}

	applyLeaveNoTraceChange(
		connectionIds: string[],
		invalidatedConnectionIds: string[],
		disabledConnectionIds: string[],
	): void {
		const sessionEpoch = this.sessionEpoch;
		if (!this.isSessionEpochCurrent(sessionEpoch)) return;
		const invalidated = new Set(invalidatedConnectionIds);
		const changed = new Set([...invalidatedConnectionIds, ...disabledConnectionIds]);
		const changedComparisonBoxIds = this.ownership.listComparisonOwners()
			.filter(({ owner }) => changed.has(owner.connectionId))
			.map(({ boxId }) => boxId);
		const changedSourceBoxIds = this.ownership.listTargets()
			.filter(target => changed.has(target.connectionId))
			.map(target => target.boxId);
		for (const comparisonBoxId of changedComparisonBoxIds) {
			this.invalidateProtectedPublication(comparisonBoxId);
			this.clearOwnerChangeReplay(comparisonBoxId);
		}
		for (const boxId of changedSourceBoxIds) {
			this.invalidateProtectedPublication(boxId);
			this.clearOwnerChangeReplay(boxId);
		}
		for (const [boxId, pending] of this.pendingRetirementByBoxId) {
			if (changed.has(pending.connectionId)) this.clearOwnerChangeReplay(boxId);
		}
		const comparisonBoxIds = this.ownership.listComparisonOwners()
			.filter(({ owner }) => invalidated.has(owner.connectionId))
			.map(({ boxId }) => boxId);
		const sourceBoxIds = this.ownership.listTargets()
			.filter(target => invalidated.has(target.connectionId))
			.map(target => target.boxId);
		const stsOwners = new Map(sourceBoxIds.map(boxId => [
			boxId,
			this.getExpectedStsOwner(
				boxId,
				this.ownership.getIssuedOwner(boxId)?.owner ?? this.ownership.getOwner(boxId),
			),
		]));
		for (const comparisonBoxId of changedComparisonBoxIds) {
			this.executionBroker.supersede(comparisonBoxId, { notifyWebview: true });
		}
		for (const boxId of changedSourceBoxIds) {
			this.executionBroker.supersede(boxId, { notifyWebview: true });
		}
		for (const boxId of changedSourceBoxIds) {
			const sectionInstanceId = this.sectionInstanceIdByBoxId.get(boxId);
			if (sectionInstanceId) this.retirePendingLanguageRequests(boxId, sectionInstanceId);
		}
		for (const comparisonBoxId of changedComparisonBoxIds) this.ownership.revokeOwnerToken(comparisonBoxId);
		for (const boxId of changedSourceBoxIds) this.ownership.revokeOwnerToken(boxId);
		const policyReady = this.publishLeaveNoTraceState(connectionIds, sessionEpoch);
		this.republishPendingRetirementsForPolicyChange(changed, sessionEpoch);
		for (const connectionId of changed) {
			if (this.options.sqlWorkbench.isLeaveNoTraceConnection(connectionId)) {
				this.protectedPolicyBarrierByConnectionId.set(connectionId, {
					sessionEpoch,
					connectionId,
					revocationGeneration:
						this.options.sqlWorkbench.leaveNoTracePolicy.getRevocationGeneration(connectionId),
					ready: policyReady,
				});
			} else {
				this.protectedPolicyBarrierByConnectionId.delete(connectionId);
			}
		}
		if (invalidatedConnectionIds.length === 0) return;
		this.options.effects.invalidatePersistence();
		this.options.effects.invalidateSqlCopilot(invalidatedConnectionIds, comparisonBoxIds);
		for (const boxId of sourceBoxIds) {
			this.clearOwnerChangeReplay(boxId);
			const sectionInstanceId = this.sectionInstanceIdByBoxId.get(boxId);
			const target = this.ownership.getTarget(boxId);
			const preparationTicket = sectionInstanceId && target?.database
				? this.beginProtectedPublication(boxId, sectionInstanceId)
				: undefined;
			const previousStsOwner = stsOwners.get(boxId);
			if (previousStsOwner && this.openedBoxIds.delete(boxId)) {
				this.languageService?.closeDocumentForOwner(boxId, previousStsOwner);
			}
			this.documentConnectAttemptByBoxId.delete(boxId);
			this.retireChanges(boxId);
			this.activeConnectAttemptByBoxId.delete(boxId);
			if (sectionInstanceId) {
				void policyReady.then(async ready => {
					if (!preparationTicket
						|| !this.isProtectedPublicationCurrent(boxId, preparationTicket)) return;
					if (ready) {
						await this.publishProtectedExecutionOwner(
							boxId,
							sectionInstanceId,
							undefined,
							preparationTicket,
						);
						return;
					}
					await this.postProtectedPreparationError(
						boxId,
						preparationTicket,
					);
				}).catch(() => {
					if (this.isSessionEpochCurrent(sessionEpoch)) {
						this.options.output.warn('[sql-lnt] Failed to prepare isolated SQL execution.');
					}
				});
			}
		}
	}

	private async publishLeaveNoTraceState(
		connectionIds: string[],
		sessionEpoch: number,
	): Promise<boolean> {
		const policyDelivered = await this.postMessageRequiredContained(
			{ type: 'sqlLeaveNoTraceData', connectionIds },
			sessionEpoch,
			'[sql-lnt] Leave No Trace state publication failed.',
		);
		if (policyDelivered) {
			this.refreshConnectionsDataContained(sessionEpoch);
			return true;
		}
		return this.refreshConnectionsDataRequired(sessionEpoch);
	}

	private async waitForProtectedPolicyBarrier(
		connectionId: string,
		sessionEpoch: number,
	): Promise<boolean> {
		const barrier = this.protectedPolicyBarrierByConnectionId.get(connectionId);
		if (!barrier) return true;
		const ready = await barrier.ready;
		return ready
			&& this.isSessionEpochCurrent(sessionEpoch)
			&& this.protectedPolicyBarrierByConnectionId.get(connectionId) === barrier
			&& this.options.sqlWorkbench.isLeaveNoTraceConnection(connectionId)
			&& this.options.sqlWorkbench.leaveNoTracePolicy.getRevocationGeneration(connectionId)
				=== barrier.revocationGeneration;
	}

	private async postProtectedPreparationError(
		boxId: string,
		ticket: SqlProtectedPublicationTicket,
	): Promise<void> {
		await this.postProtectedMessageWithRetry(boxId, ticket, {
			type: 'stsConnectionState', boxId, sectionInstanceId: ticket.sectionInstanceId, state: 'error',
			error: 'Unable to prepare isolated SQL execution. Reconnect and retry.',
			targetGeneration: ticket.targetGeneration,
		}, '[sql-lnt] Failed to publish isolated SQL execution state.');
	}

	private async publishProtectedExecutionOwner(
		boxId: string,
		sectionInstanceId: string,
		expectedConnectAttempt?: SqlConnectAttempt,
		existingTicket?: SqlProtectedPublicationTicket,
	): Promise<void> {
		const ticket = existingTicket
			?? this.beginProtectedPublication(boxId, sectionInstanceId, expectedConnectAttempt);
		if (!ticket) return;
		let issuedOwnerToken: string | undefined;
		try {
			if (!this.isProtectedPublicationCurrent(boxId, ticket)) return;
			const owner = await this.ownership.getCanonicalOwner(boxId);
			if (!this.isProtectedPublicationCurrent(boxId, ticket)) return;
			if (!owner || owner.connectionId !== ticket.connectionId
				|| owner.database !== ticket.database || owner.generation !== ticket.targetGeneration
				|| owner.revocationGeneration !== ticket.expectedRevocationGeneration) {
				throw new Error('Protected SQL execution owner unavailable.');
			}
			if (!this.isProtectedPublicationCurrent(boxId, ticket)) return;
			const issuedOwner = await this.ownership.issueOwnerTokenProtection(
				boxId,
				owner,
				true,
				() => this.isProtectedPublicationCurrent(boxId, ticket),
			);
			issuedOwnerToken = issuedOwner.token;
			this.claimTokenPublication(boxId, issuedOwnerToken, ticket);
			if (!this.isProtectedPublicationCurrent(boxId, ticket)) return;
			if (!sqlResultOwnersEqual(this.ownership.getOwner(boxId), owner)) {
				throw new Error('Protected SQL execution owner changed.');
			}
			if (!this.isProtectedPublicationCurrent(boxId, ticket)) return;
			if (!await this.postProtectedMessageWithRetry(boxId, ticket, {
				type: 'sqlExecutionOwnerState', boxId, sectionInstanceId, ownerToken: issuedOwnerToken,
				targetGeneration: owner.generation,
			}, '[sql-lnt] Isolated SQL execution owner publication failed.')) {
				throw new Error('Protected SQL execution owner delivery failed.');
			}
			this.acknowledgeTokenPublication(boxId, issuedOwnerToken, ticket);
			if (!this.isProtectedPublicationCurrent(boxId, ticket)) return;
		} catch {
			if (!this.isProtectedPublicationCurrent(boxId, ticket)) return;
			this.options.output.warn('[sql-lnt] Failed to prepare isolated SQL execution.');
			if (!this.isProtectedPublicationCurrent(boxId, ticket)) return;
			try {
				await this.postProtectedMessageWithRetry(boxId, ticket, {
					type: 'stsConnectionState', boxId, sectionInstanceId, state: 'error',
					error: 'Unable to prepare isolated SQL execution. Reconnect and retry.',
					targetGeneration: ticket.targetGeneration,
				}, '[sql-lnt] Failed to publish isolated SQL execution state.');
				if (!this.isProtectedPublicationCurrent(boxId, ticket)) return;
			} catch {
				if (this.isProtectedPublicationCurrent(boxId, ticket)) {
					this.options.output.warn('[sql-lnt] Failed to publish isolated SQL execution state.');
				}
			}
		} finally {
			this.releaseTokenPublicationClaim(boxId, ticket);
		}
	}

	private async ensureLanguageService(): Promise<SqlEditorLanguageService | null> {
		if (this.languageService) return this.languageService;
		const sessionEpoch = this.sessionEpoch;
		const languageEpoch = this.languageEpoch;
		const currentInitialization = this.languageServiceInit;
		if (currentInitialization
			&& currentInitialization.sessionEpoch === sessionEpoch
			&& currentInitialization.languageEpoch === languageEpoch) {
			return currentInitialization.promise;
		}
		let createdService: SqlEditorLanguageService | undefined;
		const promise = (async () => {
			try {
				const processManager = await this.options.sqlWorkbench.runtime.getProcessManager();
				if (!this.isLanguageEpochCurrent(sessionEpoch, languageEpoch) || !this.options.hasWebview()) return null;
				createdService = this.options.createLanguageService?.(processManager)
					?? new StsLanguageService(
						processManager,
						this.options.sqlWorkbench.connectionManager,
						this.options.context,
						this.options.output,
						undefined,
						this.options.sqlWorkbench.leaveNoTracePolicy,
						(connection, principal, revocation, dispatch) =>
							this.options.sqlWorkbench.dispatchSqlOwnerAllowed(connection, principal, revocation, dispatch),
					);
				if (!this.isLanguageEpochCurrent(sessionEpoch, languageEpoch)) {
					try { createdService.dispose(); } catch { /* ignore */ }
					createdService = undefined;
					return null;
				}
				createdService.onDiagnostics(event => {
					if (!this.isLanguageEpochCurrent(sessionEpoch, languageEpoch)
						|| this.languageService !== createdService) return;
					if (!event.owner || !Number.isSafeInteger(event.owner.generation)) return;
					const owner: SqlResultOwner = { ...event.owner, generation: Number(event.owner.generation) };
					if (!sqlResultOwnersEqual(this.ownership.getOwner(event.boxId), owner)) return;
					const sectionInstanceId = this.sectionInstanceIdByBoxId.get(event.boxId);
					if (!sectionInstanceId) return;
					this.postMessageContained({
						type: 'stsDiagnostics', boxId: event.boxId, sectionInstanceId, markers: event.markers,
					}, sessionEpoch, '[sts] Diagnostics publication failed.');
				});
				if (!this.isLanguageEpochCurrent(sessionEpoch, languageEpoch)) {
					try { createdService.dispose(); } catch { /* ignore */ }
					createdService = undefined;
					return null;
				}
				this.languageService = createdService;
				return createdService;
			} catch (error) {
				if (createdService && this.languageService !== createdService) {
					try { createdService.dispose(); } catch { /* ignore */ }
				}
				if (this.isLanguageEpochCurrent(sessionEpoch, languageEpoch)) {
					this.options.output.error(`[sts] Init failed: ${sanitizeStsLogText(error instanceof Error ? error.message : error)}`);
				}
				return null;
			}
		})();
		const initialization: SqlLanguageServiceInitialization = { sessionEpoch, languageEpoch, promise };
		this.languageServiceInit = initialization;
		try {
			return await promise;
		} finally {
			if (this.languageServiceInit === initialization) this.languageServiceInit = undefined;
		}
	}

	private getExpectedStsOwner(boxId: string, owner: SqlResultOwner | undefined): StsExpectedOwner | undefined {
		const sectionInstanceId = this.sectionInstanceIdByBoxId.get(String(boxId || '').trim());
		return owner && sectionInstanceId ? { ...owner, sectionInstanceId } : undefined;
	}

	private retireChanges(boxId: string): void {
		const id = String(boxId || '').trim();
		if (!id) return;
		this.changeSequenceByBoxId.set(id, (this.changeSequenceByBoxId.get(id) ?? 0) + 1);
		this.changeTailByBoxId.delete(id);
	}

	private retirePendingLanguageRequests(boxId: string, sectionInstanceId: string): void {
		for (const [key, pending] of [...this.pendingLanguageRequestByKey]) {
			if (pending.boxId !== boxId || pending.sectionInstanceId !== sectionInstanceId) continue;
			pending.settleNull();
			if (this.pendingLanguageRequestByKey.get(key) === pending) {
				this.pendingLanguageRequestByKey.delete(key);
			}
		}
	}

	private invalidateProtectedPublication(boxId: string): void {
		this.protectedPublicationTicketByBoxId.delete(String(boxId || '').trim());
	}

	private beginProtectedPublication(
		boxId: string,
		sectionInstanceId: string,
		expectedConnectAttempt?: SqlConnectAttempt,
	): SqlProtectedPublicationTicket | undefined {
		const id = String(boxId || '').trim();
		const sequence = (this.protectedPublicationSequenceByBoxId.get(id) ?? 0) + 1;
		this.protectedPublicationSequenceByBoxId.set(id, sequence);
		this.invalidateProtectedPublication(id);
		const target = this.ownership.getTarget(id);
		if (!target) return undefined;
		const ticket: SqlProtectedPublicationTicket = Object.freeze({
			sequence,
			sessionEpoch: this.sessionEpoch,
			sectionInstanceId,
			connectionId: target.connectionId,
			database: target.database,
			targetGeneration: target.generation,
			expectedRevocationGeneration:
				this.options.sqlWorkbench.leaveNoTracePolicy.getRevocationGeneration(target.connectionId),
			...(expectedConnectAttempt ? { expectedConnectAttempt } : {}),
		});
		this.protectedPublicationTicketByBoxId.set(id, ticket);
		if (this.isProtectedPublicationCurrent(id, ticket)) return ticket;
		this.invalidateProtectedPublication(id);
		return undefined;
	}

	private isProtectedPublicationCurrent(boxId: string, ticket: SqlProtectedPublicationTicket): boolean {
		const target = this.ownership.getTarget(boxId);
		return this.protectedPublicationTicketByBoxId.get(boxId) === ticket
			&& this.isSessionEpochCurrent(ticket.sessionEpoch)
			&& this.isSectionCurrent(boxId, ticket.sectionInstanceId)
			&& !!target
			&& target.connectionId === ticket.connectionId
			&& target.database === ticket.database
			&& target.generation === ticket.targetGeneration
			&& this.ownership.isTargetCurrent(
				boxId,
				ticket.connectionId,
				ticket.database,
				ticket.targetGeneration,
			)
			&& this.options.sqlWorkbench.isLeaveNoTraceConnection(ticket.connectionId)
			&& this.options.sqlWorkbench.leaveNoTracePolicy.getRevocationGeneration(ticket.connectionId)
				=== ticket.expectedRevocationGeneration
			&& (!ticket.expectedConnectAttempt
				|| this.isCurrentConnect(boxId, ticket.expectedConnectAttempt));
	}

	private async postProtectedMessageWithRetry(
		boxId: string,
		ticket: SqlProtectedPublicationTicket,
		message: Record<string, unknown>,
		warning: string,
	): Promise<boolean> {
		if (!this.isProtectedPublicationCurrent(boxId, ticket)) return false;
		if (await this.postMessageRequiredContained(message, ticket.sessionEpoch, warning)) return true;
		if (!this.isProtectedPublicationCurrent(boxId, ticket)) return false;
		await new Promise<void>(resolve => setTimeout(resolve, 100));
		if (!this.isProtectedPublicationCurrent(boxId, ticket)) return false;
		return this.postMessageRequiredContained(message, ticket.sessionEpoch, warning);
	}

	private isCapturedTargetCurrent(target: SqlEditorTarget): boolean {
		return this.ownership.isTargetCurrent(
			target.boxId,
			target.connectionId,
			target.database,
			target.generation,
		) && this.ownership.getTarget(target.boxId)?.database === target.database;
	}

	private beginConnectAttempt(boxId: string): SqlConnectAttempt {
		this.invalidateProtectedPublication(boxId);
		this.closeUnacknowledgedClaimedDocument(boxId);
		const sequence = (this.connectSequenceByBoxId.get(boxId) ?? 0) + 1;
		this.connectSequenceByBoxId.set(boxId, sequence);
		const attempt: SqlConnectAttempt = {
			sequence,
			sessionEpoch: this.sessionEpoch,
			languageEpoch: this.languageEpoch,
		};
		this.activeConnectAttemptByBoxId.set(boxId, attempt);
		return attempt;
	}

	private isCurrentConnect(boxId: string, attempt: SqlConnectAttempt): boolean {
		return this.isLanguageEpochCurrent(attempt.sessionEpoch, attempt.languageEpoch)
			&& !this.closedBoxIds.has(boxId)
			&& this.activeConnectAttemptByBoxId.get(boxId) === attempt;
	}

	private hasActiveCurrentConnect(boxId: string): boolean {
		const attempt = this.activeConnectAttemptByBoxId.get(boxId);
		return !!attempt && this.isCurrentConnect(boxId, attempt);
	}

	private async postCurrentConnectError(
		boxId: string,
		sectionInstanceId: string,
		attempt: SqlConnectAttempt,
		message: string,
	): Promise<boolean> {
		if (!this.isCurrentConnect(boxId, attempt)
			|| this.sectionInstanceIdByBoxId.get(boxId) !== sectionInstanceId) return false;
		this.options.output.error(`[sts-diag] handleStsConnect → FAILED boxId=${boxId}: ${sanitizeStsLogText(message)}`);
		return this.postConnectMessageWithRetry(boxId, attempt, {
			type: 'stsConnectionState', boxId, sectionInstanceId, state: 'error', error: message,
			targetGeneration: this.ownership.getGeneration(boxId),
		}, '[sts] Connection error publication failed.');
	}

	private async postConnectMessageWithRetry(
		boxId: string,
		attempt: SqlConnectAttempt,
		message: Record<string, unknown>,
		warning: string,
	): Promise<boolean> {
		if (!this.isCurrentConnect(boxId, attempt)) return false;
		if (await this.postMessageRequiredContained(message, attempt.sessionEpoch, warning)) return true;
		if (!this.isCurrentConnect(boxId, attempt)) return false;
		await new Promise<void>(resolve => setTimeout(resolve, 100));
		if (!this.isCurrentConnect(boxId, attempt)) return false;
		return this.postMessageRequiredContained(message, attempt.sessionEpoch, warning);
	}

	private async publishOwnerChangeWithRetry(
		publication: SqlOwnerChangedPublication,
		sessionEpoch: number,
	): Promise<boolean> {
		const isCurrent = () => this.isOwnerChangePublicationCurrent(publication, sessionEpoch);
		if (!isCurrent()) return false;
		this.clearOwnerChangeReplay(publication.boxId);
		if (await this.postMessageRequiredContained(
			publication.message,
			sessionEpoch,
			'[sql] Owner change publication failed.',
		)) {
			if (isCurrent()) this.acknowledgeRetirement(publication);
			return true;
		}
		if (!isCurrent()) return false;
		await new Promise<void>(resolve => setTimeout(resolve, 100));
		if (!isCurrent()) return false;
		const delivered = await this.postMessageRequiredContained(
			publication.message,
			sessionEpoch,
			'[sql] Owner change retry failed.',
		);
		if (delivered && isCurrent()) this.acknowledgeRetirement(publication);
		else if (isCurrent()) this.scheduleOwnerChangeReplay(publication, sessionEpoch);
		return delivered;
	}

	private scheduleOwnerChangeReplay(
		publication: SqlOwnerChangedPublication,
		sessionEpoch: number,
	): void {
		if (!this.isOwnerChangePublicationCurrent(publication, sessionEpoch)) return;
		this.clearOwnerChangeReplay(publication.boxId);
		const timer = setTimeout(() => {
			const replay = this.ownerChangeReplayByBoxId.get(publication.boxId);
			if (!replay || replay.timer !== timer) return;
			this.ownerChangeReplayByBoxId.delete(publication.boxId);
			void this.replayOwnerChange(replay);
		}, 250);
		this.ownerChangeReplayByBoxId.set(publication.boxId, { publication, sessionEpoch, timer });
	}

	private async replayOwnerChange(replay: SqlOwnerChangeReplay): Promise<void> {
		const { publication, sessionEpoch } = replay;
		try {
			if (!this.isOwnerChangePublicationCurrent(publication, sessionEpoch)) return;
			if (await this.postMessageRequiredContained(
				publication.message,
				sessionEpoch,
				'[sql] Owner change replay failed.',
			)) {
				const publicationWasCurrent = this.isOwnerChangePublicationCurrent(publication, sessionEpoch);
				if (publicationWasCurrent) this.acknowledgeRetirement(publication);
				if (publicationWasCurrent) {
					const snapshotDelivered = await this.refreshConnectionsDataRequired(sessionEpoch);
					if (snapshotDelivered
						&& !publication.retired
						&& publication.database
						&& this.isOwnerChangePublicationCurrent(publication, sessionEpoch)) {
						await this.options.effects.prefetchSchema(
							publication.connectionId,
							publication.database,
							publication.boxId,
							false,
						);
					}
				}
				return;
			}
			if (this.isOwnerChangePublicationCurrent(publication, sessionEpoch)) {
				this.scheduleOwnerChangeReplay(publication, sessionEpoch);
			}
		} finally {
			this.pruneConnectionEventEpoch(publication.connectionId);
		}
	}

	private isOwnerChangePublicationCurrent(
		publication: SqlOwnerChangedPublication,
		sessionEpoch: number,
	): boolean {
		const owner = this.ownership.getOwner(publication.boxId);
		return this.isSessionEpochCurrent(sessionEpoch)
			&& this.isSectionCurrent(publication.boxId, publication.sectionInstanceId)
			&& (!publication.retired
				|| this.pendingRetirementByBoxId.get(publication.boxId) === publication)
			&& (publication.connectionEventEpoch === undefined
				|| this.connectionEventEpochById.get(publication.connectionId) === publication.connectionEventEpoch)
			&& this.options.sqlWorkbench.leaveNoTracePolicy.getRevocationGeneration(publication.connectionId)
				=== publication.revocationGeneration
			&& (publication.retired
				? !this.ownership.getTarget(publication.boxId)
					&& !this.options.sqlWorkbench.connectionManager.getConnection(publication.connectionId)
					&& this.ownership.getGeneration(publication.boxId) === publication.targetGeneration
				: this.ownership.isTargetCurrent(
					publication.boxId,
					publication.connectionId,
					publication.database,
					publication.targetGeneration,
				)
					&& owner?.targetSignature === publication.targetSignature
					&& owner?.principalFingerprint === publication.principalFingerprint);
	}

	private isPendingRetirementTombstoneCurrent(publication: SqlOwnerChangedPublication): boolean {
		return publication.retired
			&& this.pendingRetirementByBoxId.get(publication.boxId) === publication
			&& this.isSectionCurrent(publication.boxId, publication.sectionInstanceId)
			&& !this.ownership.getTarget(publication.boxId)
			&& this.ownership.getGeneration(publication.boxId) === publication.targetGeneration;
	}

	private restampPendingRetirement(publication: SqlOwnerChangedPublication): SqlOwnerChangedPublication {
		return {
			...publication,
			revocationGeneration:
				this.options.sqlWorkbench.leaveNoTracePolicy.getRevocationGeneration(publication.connectionId),
			connectionEventEpoch: this.connectionEventEpochById.get(publication.connectionId),
		};
	}

	private republishPendingRetirementsForPolicyChange(
		changedConnectionIds: ReadonlySet<string>,
		sessionEpoch: number,
	): void {
		for (const [boxId, pending] of [...this.pendingRetirementByBoxId]) {
			if (!changedConnectionIds.has(pending.connectionId)) continue;
			if (!this.isPendingRetirementTombstoneCurrent(pending)) {
				this.clearPendingRetirement(boxId, pending);
				continue;
			}
			const publication = this.restampPendingRetirement(pending);
			this.pendingRetirementByBoxId.set(boxId, publication);
			if (this.options.sqlWorkbench.connectionManager.getConnection(publication.connectionId)) continue;
			void this.publishOwnerChangeWithRetry(publication, sessionEpoch).catch(() => {
				if (this.isSessionEpochCurrent(sessionEpoch)) {
					this.options.output.warn('[sql] Retired owner publication failed after a policy change.');
				}
			});
		}
	}

	private acknowledgeRetirement(publication: SqlOwnerChangedPublication): void {
		if (publication.retired) this.clearPendingRetirement(publication.boxId, publication);
	}

	private clearPendingRetirement(boxId: string, expected?: SqlOwnerChangedPublication): void {
		const id = String(boxId || '').trim();
		if (!id || (expected && this.pendingRetirementByBoxId.get(id) !== expected)) return;
		const connectionId = this.pendingRetirementByBoxId.get(id)?.connectionId;
		this.pendingRetirementByBoxId.delete(id);
		if (connectionId) this.pruneConnectionEventEpoch(connectionId);
	}

	private pruneConnectionEventEpoch(connectionId: string): void {
		if (this.options.sqlWorkbench.connectionManager.getConnection(connectionId)) return;
		if ([...this.pendingRetirementByBoxId.values()]
			.some(publication => publication.connectionId === connectionId)) return;
		if ([...this.ownerChangeReplayByBoxId.values()]
			.some(replay => replay.publication.connectionId === connectionId)) return;
		this.connectionEventEpochById.delete(connectionId);
	}

	private clearOwnerChangeReplay(boxId: string): void {
		const replay = this.ownerChangeReplayByBoxId.get(String(boxId || '').trim());
		if (!replay) return;
		clearTimeout(replay.timer);
		this.ownerChangeReplayByBoxId.delete(String(boxId || '').trim());
		this.pruneConnectionEventEpoch(replay.publication.connectionId);
	}

	private clearAllOwnerChangeReplays(): void {
		for (const replay of this.ownerChangeReplayByBoxId.values()) clearTimeout(replay.timer);
		this.ownerChangeReplayByBoxId.clear();
	}

	private claimTokenPublication(
		boxId: string,
		token: string,
		owner: SqlConnectAttempt | SqlProtectedPublicationTicket,
		stsOwner?: StsExpectedOwner,
	): void {
		const existing = this.tokenPublicationClaimByBoxId.get(boxId);
		this.tokenPublicationClaimByBoxId.set(boxId, {
			token,
			owner,
			acknowledged: existing?.token === token && existing.acknowledged,
			...(stsOwner ? { stsOwner } : existing?.token === token && existing.stsOwner
				? { stsOwner: existing.stsOwner }
				: {}),
		});
	}

	private acknowledgeTokenPublication(
		boxId: string,
		token: string,
		owner: SqlConnectAttempt | SqlProtectedPublicationTicket,
	): void {
		const claim = this.tokenPublicationClaimByBoxId.get(boxId);
		if (!claim || claim.token !== token || claim.owner !== owner) return;
		claim.acknowledged = true;
	}

	private isUnacknowledgedTokenPublication(
		boxId: string,
		token: string,
		owner: SqlConnectAttempt | SqlProtectedPublicationTicket,
	): boolean {
		const claim = this.tokenPublicationClaimByBoxId.get(boxId);
		return !!claim && claim.token === token && claim.owner === owner && !claim.acknowledged;
	}

	private releaseTokenPublicationClaim(
		boxId: string,
		owner: SqlConnectAttempt | SqlProtectedPublicationTicket,
	): void {
		const claim = this.tokenPublicationClaimByBoxId.get(boxId);
		if (!claim || claim.owner !== owner) return;
		if (claim.acknowledged) return;
		this.tokenPublicationClaimByBoxId.delete(boxId);
		if (!claim.acknowledged && this.ownership.getOwnerToken(boxId) === claim.token) {
			this.ownership.revokeOwnerToken(boxId);
		}
	}

	private clearTokenPublicationClaim(boxId: string, revokeUnacknowledged: boolean): void {
		const claim = this.tokenPublicationClaimByBoxId.get(boxId);
		if (!claim) return;
		this.tokenPublicationClaimByBoxId.delete(boxId);
		if (revokeUnacknowledged && !claim.acknowledged
			&& this.ownership.getOwnerToken(boxId) === claim.token) {
			this.ownership.revokeOwnerToken(boxId);
		}
	}

	private closeUnacknowledgedClaimedDocument(boxId: string): void {
		const claim = this.tokenPublicationClaimByBoxId.get(boxId);
		if (!claim || claim.acknowledged || !claim.stsOwner) return;
		if (this.openedBoxIds.delete(boxId)) {
			this.languageService?.closeDocumentForOwner(boxId, claim.stsOwner);
		}
		this.documentConnectAttemptByBoxId.delete(boxId);
	}

	private clearAllTokenPublicationClaims(): void {
		for (const boxId of [...this.tokenPublicationClaimByBoxId.keys()]) {
			this.clearTokenPublicationClaim(boxId, true);
		}
	}

	private isSessionEpochCurrent(sessionEpoch: number): boolean {
		return !this.disposed && this.sessionEpoch === sessionEpoch;
	}

	private isLanguageEpochCurrent(sessionEpoch: number, languageEpoch: number): boolean {
		return this.isSessionEpochCurrent(sessionEpoch) && this.languageEpoch === languageEpoch;
	}

	private postMessageContained(
		message: unknown,
		sessionEpoch: number,
		warning: string,
		onFailure?: () => void,
	): void {
		void this.postMessageRequiredContained(message, sessionEpoch, warning, onFailure);
	}

	private async postMessageRequiredContained(
		message: unknown,
		sessionEpoch: number,
		warning: string,
		onFailure?: () => void,
	): Promise<boolean> {
		try {
			await this.postMessageRequired(message);
			return true;
		} catch {
			if (!this.isSessionEpochCurrent(sessionEpoch)) return false;
			this.options.output.warn(warning);
			onFailure?.();
			return false;
		}
	}

	private async postMessageRequired(message: unknown): Promise<void> {
		if (await this.options.effects.postMessage(message) !== true) {
			throw new Error('Required webview message delivery failed.');
		}
	}

	private async refreshConnectionsDataRequired(sessionEpoch: number): Promise<boolean> {
		try {
			if (await this.options.effects.refreshConnectionsData() === true) return true;
		} catch {
			// Report all rejected and unresolved deliveries through the same fixed path.
		}
		this.handleConnectionSnapshotFailure(
			sessionEpoch,
			'[sql] Connection snapshot refresh failed; scheduling one retry.',
		);
		return false;
	}

	private refreshConnectionsDataContained(sessionEpoch: number): void {
		void this.refreshConnectionsDataRequired(sessionEpoch);
	}

	private handleConnectionSnapshotFailure(sessionEpoch: number, warning: string): void {
		if (!this.isSessionEpochCurrent(sessionEpoch)) return;
		this.options.output.warn(warning);
		this.scheduleConnectionSnapshotRetry(sessionEpoch);
	}

	private scheduleConnectionSnapshotRetry(sessionEpoch: number): void {
		if (!this.isSessionEpochCurrent(sessionEpoch)) return;
		if (this.connectionSnapshotRetry?.sessionEpoch === sessionEpoch) return;
		this.clearConnectionSnapshotRetry();
		const timer = setTimeout(() => {
			if (this.connectionSnapshotRetry?.timer !== timer) return;
			this.connectionSnapshotRetry = undefined;
			if (!this.isSessionEpochCurrent(sessionEpoch)) return;
			void (async () => {
				try {
					if (await this.options.effects.refreshConnectionsData() === true) return;
				} catch {
					// Log the same fixed failure for rejected and false deliveries.
				}
				if (this.isSessionEpochCurrent(sessionEpoch)) {
					this.options.output.warn('[sql] Connection snapshot retry failed.');
				}
			})();
		}, 250);
		this.connectionSnapshotRetry = { sessionEpoch, timer };
	}

	private clearConnectionSnapshotRetry(): void {
		if (!this.connectionSnapshotRetry) return;
		clearTimeout(this.connectionSnapshotRetry.timer);
		this.connectionSnapshotRetry = undefined;
	}
}