import * as vscode from 'vscode';

import * as crypto from 'crypto';

import { ConnectionManager, KustoConnection } from './connectionManager';
import { KustoQueryClient, QueryExecutionError, type CancelableQueryExecution } from './kustoClient';
import { SqlQueryClient, SqlQueryCancelledError } from './sqlClient';
import { SqlSchemaService, sqlSchemaPrincipalFingerprintForPrincipal } from './sqlEditorSchema';
import { SqlWorkbenchService, type SqlOwnerSnapshot } from './sql/sqlWorkbenchService';
import {
	sqlResultOwnersEqual,
	type SqlComparisonOwner,
	type SqlResultOwner,
} from './sql/sqlEditorSessionRegistry';
import {
	type SqlExecutionAdmission,
	type SqlExecutionLease,
} from './sql/sqlExecutionBroker';
import { SqlEditorLifecycleCoordinator } from './sql/sqlEditorLifecycleCoordinator';
import { sanitizeStsLogText } from './sql/stsLogSanitizer';
import { normalizeSqlServerUrl } from './sql/sqlAuthState';
import { clearSqlTokenOverride, setSqlServerAccountMapEntry, setSqlTokenOverride } from './sql/sqlAuthState';
import { KustoConnectionLifecycle } from './kustoConnectionLifecycle';
import {
	getOwnedSqlDatabaseCacheEntry,
	sqlDatabaseTargetSignature,
	SQL_DATABASE_CACHE_STORAGE_KEY,
} from './sqlDatabaseCache';
import { getQueryEditorHtml } from './queryEditorHtml';
import { toolOrchestrator } from './extension';
import { CopilotService, CopilotServiceHost, SQL_COPILOT_OWNER_CHANGED_MESSAGE } from './queryEditorCopilot';
import { ConnectionService, ConnectionServiceHost } from './queryEditorConnection';
import { kustoClusterKey } from '../shared/kustoClusterUrls';
import { canonicalSectionKind } from '../shared/documentSectionCapabilities';
import { sqlConnectionTargetSignatureMatches } from '../shared/sqlConnectionIdentity';
import { SchemaService, SchemaServiceHost } from './queryEditorSchema';
import {
	getErrorMessage as getErrorMessageFn,
	formatQueryExecutionErrorForUser as formatQueryExecutionErrorForUserFn,
	isControlCommand as isControlCommandFn,
	appendQueryMode as appendQueryModeFn,
	normalizeControlCommandForExecution as normalizeControlCommandForExecutionFn,
	buildCacheDirective as buildCacheDirectiveFn
} from './queryEditorUtils';
import { appendSqlQueryMode as appendSqlQueryModeFn } from './sqlEditorUtils';
import {
	STORAGE_KEYS,
	CachedSchemaEntry,
	CacheUnit,
	IncomingWebviewMessage,
	findPreferredDefaultCopilotModel
} from './queryEditorTypes';
import { EditorCursorStatusBar } from './editorCursorStatusBar';
import { KustoAuthPreferenceService, type KustoAuthPreferenceChange } from './kustoAuthPreferenceService';
import type { KustoLeaveNoTracePolicySnapshot } from './kustoLeaveNoTracePolicyStore';
import { getKustoConnectionIdentityKey, resolveKustoConnection, resolveStrictKustoConnection } from '../shared/kustoAuth';
import { EmbeddedTutorialWebviewHost, EmbeddedTutorialWebviewRegistry } from './tutorials/embeddedTutorialWebviewHost';
import { perfMark } from './perfTrace';
import { getWorkbenchLogger, type WorkbenchLogger } from './workbenchLogger';
import type { FileOpenTrace } from './fileOpenTrace';
import { getEditingPreferencesData } from './editingPreferences';
import { QueryRunCoordinator } from './queryRunCoordinator';
import { KustoExecutionCoordinator, type KustoExecutionLease } from './kustoExecutionCoordinator';
import { hasKustoCopilotRequestIdentity, kustoCopilotRequestIdentityEquals, type KustoComparisonRunIdentity, type KustoCopilotRequestIdentity, type KustoDispatchIdentity, type KustoExecutionProducer, type KustoExecutionRequestIdentity, type KustoExecutionStarted, type KustoSectionExecutionOutcome, type KustoSectionExecutionTarget, type PreparedComparisonSection } from '../shared/kustoExecution';
import {
	HostDashboardApplicationHandler,
	type DashboardApplicationHandler,
} from './dashboardApplicationHandler';
import {
	HostArtifactCsvSaveApplicationHandler,
	type ArtifactCsvSaveApplicationHandler,
} from './artifactCsvSaveApplicationHandler';
import {
	HostPythonExecutionApplicationHandler,
	type PythonExecutionApplicationHandler,
} from './pythonExecutionApplicationHandler';
import {
	HostImportedCsvSaveApplicationHandler,
	type ImportedCsvSaveApplicationHandler,
} from './importedCsvSaveApplicationHandler';
import {
	HostQuerySharingApplicationHandler,
	type QuerySharingApplicationHandler,
} from './querySharingApplicationHandler';
import {
	HostUrlContentApplicationHandler,
	type UrlContentApplicationHandler,
} from './urlContentApplicationHandler';
import {
	HostControlCommandSyntaxApplicationHandler,
	type ControlCommandSyntaxApplicationHandler,
} from './controlCommandSyntaxApplicationHandler';
import {
	HostResourceUriApplicationHandler,
	type ResourceUriApplicationHandler,
} from './resourceUriApplicationHandler';
import {
	HostCopilotContentOpenApplicationHandler,
	type CopilotContentOpenApplicationHandler,
} from './copilotContentOpenApplicationHandler';
import {
	HostInformationNotificationApplicationHandler,
	type InformationNotificationApplicationHandler,
} from './informationNotificationApplicationHandler';
import {
	HostCachedValuesOpenApplicationHandler,
	type CachedValuesOpenApplicationHandler,
} from './cachedValuesOpenApplicationHandler';
import {
	HostCopilotAgentOpenApplicationHandler,
	type CopilotAgentOpenApplicationHandler,
} from './copilotAgentOpenApplicationHandler';
import {
	HostEditorCursorStatusApplicationHandler,
	type EditorCursorStatusApplicationHandler,
} from './editorCursorStatusApplicationHandler';
import {
	HostEditingPreferencesApplicationHandler,
	type EditingPreferencesApplicationHandler,
} from './editingPreferencesApplicationHandler';
import {
	HostKustoConnectionIntakeApplicationHandler,
	type KustoConnectionIntakeApplicationHandler,
} from './kustoConnectionIntakeApplicationHandler';
import {
	HostKustoConnectionOnboardingApplicationHandler,
	type KustoConnectionOnboardingApplicationHandler,
} from './kustoConnectionOnboardingApplicationHandler';
import {
	HostSqlConnectionOnboardingApplicationHandler,
	type SqlConnectionOnboardingApplicationHandler,
} from './sqlConnectionOnboardingApplicationHandler';
import {
	HostSqlFavoritesApplicationHandler,
	type SqlFavoritesApplicationHandler,
} from './sqlFavoritesApplicationHandler';
import {
	HostKustoFavoritesApplicationHandler,
	type KustoFavoritesApplicationHandler,
} from './kustoFavoritesApplicationHandler';
import {
	HostSqlDatabaseDiscoveryApplicationHandler,
	type SqlDatabaseDiscoveryApplicationHandler,
} from './sqlDatabaseDiscoveryApplicationHandler';
import {
	HostKqlLanguageRequestApplicationHandler,
	type KqlLanguageRequestApplicationHandler,
} from './kqlLanguageRequestApplicationHandler';
import {
	HostSqlLastSelectionApplicationHandler,
	type SqlLastSelectionApplicationHandler,
} from './sqlLastSelectionApplicationHandler';
import {
	HostDevelopmentNoteMutationApplicationHandler,
	type DevelopmentNoteMutationApplicationHandler,
} from './developmentNoteMutationApplicationHandler';
import {
	HostCopilotInlineCompletionApplicationHandler,
	type CopilotInlineCompletionApplicationHandler,
} from './copilotInlineCompletionApplicationHandler';

type PendingComparisonEnsure = {
	resolve: (comparison: PreparedComparisonSection) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
	sourceBoxId: string;
	sqlConnectionId?: string;
	sqlSourceSectionInstanceId?: string;
	sqlSourceTargetGeneration?: number;
	sqlSourceDatabase?: string;
	copilotSequence?: number;
	kustoRequest?: KustoCopilotRequestIdentity;
	comparisonBoxId?: string;
	cancellationDisposable?: vscode.Disposable;
	previousSqlComparisonOwnerCaptured?: boolean;
	previousSqlComparisonOwner?: SqlComparisonOwner;
	provisionalSqlComparisonOwner?: SqlComparisonOwner;
	rollbackInProgress?: boolean;
	rollbackRetryTimer?: ReturnType<typeof setTimeout>;
	completionStarted?: boolean;
	sqlAdmissionAck?: {
		comparisonBoxId: string;
		phase: 'staged' | 'committed' | 'finalized' | 'completed' | 'rolledBack';
		resolve: (accepted: boolean) => void;
		timer: ReturnType<typeof setTimeout>;
	};
};

const SQL_COPILOT_PREFLIGHT_EXECUTION_ID = 'sql-copilot-owner-preflight';


export class QueryEditorProvider implements CopilotServiceHost, ConnectionServiceHost, SchemaServiceHost {
	private static readonly activeProviders = new Set<QueryEditorProvider>();

	private static activeProviderForTest(): QueryEditorProvider {
		const candidates = [...QueryEditorProvider.activeProviders]
			.filter(provider => !provider._panelDisposed && !!provider.panel
				&& provider.context.extensionMode !== vscode.ExtensionMode.Production);
		const provider = candidates.find(candidate => candidate.panel?.active)
			?? candidates.find(candidate => candidate.panel?.visible)
			?? candidates.at(-1);
		if (!provider) throw new Error('No active Kusto Workbench editor is available.');
		return provider;
	}

	static async prepareSqlComparisonForTest(sourceBoxId: string, query: string): Promise<PreparedComparisonSection> {
		const provider = QueryEditorProvider.activeProviderForTest();
		const cancellation = new vscode.CancellationTokenSource();
		try {
			return await provider.ensureComparisonBoxInWebview(sourceBoxId, query, cancellation.token);
		} finally {
			cancellation.dispose();
		}
	}

	static async assertNestedSqlComparisonRejectedForTest(query: string): Promise<void> {
		const provider = QueryEditorProvider.activeProviderForTest();
		const comparisonBoxIds = provider.sqlLifecycle.listComparisonBoxIds();
		if (comparisonBoxIds.length !== 1) {
			throw new Error(`Expected exactly one committed SQL comparison, found ${comparisonBoxIds.length}.`);
		}
		try {
			await QueryEditorProvider.prepareSqlComparisonForTest(comparisonBoxIds[0], query);
		} catch (error) {
			if (error instanceof Error && error.message.includes('cannot be used as another comparison source')) return;
			throw error;
		}
		throw new Error('Nested SQL comparison preparation unexpectedly succeeded.');
	}

	private panel?: vscode.WebviewPanel;
	private _panelDisposed = true;
	readonly kustoClient: KustoQueryClient;
	readonly output: WorkbenchLogger = getWorkbenchLogger();
	readonly connection: ConnectionService;
	readonly schema: SchemaService;
	private _queryRunCoordinator?: QueryRunCoordinator;
	private _kustoExecutionCoordinator?: KustoExecutionCoordinator;
	private readonly pendingKustoExecutionStartAcks = new Map<string, {
		resolve: (accepted: boolean) => void;
		timer: ReturnType<typeof setTimeout>;
	}>();
	private readonly pendingKustoPublicationAcks = new Map<string, {
		resolve: (accepted: boolean) => void;
		timer?: ReturnType<typeof setTimeout>;
	}>();
	readonly dashboardApplication: DashboardApplicationHandler;
	readonly artifactCsvSaveApplication: ArtifactCsvSaveApplicationHandler;
	readonly pythonExecutionApplication: PythonExecutionApplicationHandler;
	readonly importedCsvSaveApplication: ImportedCsvSaveApplicationHandler;
	readonly querySharingApplication: QuerySharingApplicationHandler;
	readonly urlContentApplication: UrlContentApplicationHandler;
	readonly controlCommandSyntaxApplication: ControlCommandSyntaxApplicationHandler;
	readonly resourceUriApplication: ResourceUriApplicationHandler;
	readonly copilotContentOpenApplication: CopilotContentOpenApplicationHandler;
	readonly informationNotificationApplication: InformationNotificationApplicationHandler;
	readonly cachedValuesOpenApplication: CachedValuesOpenApplicationHandler;
	readonly copilotAgentOpenApplication: CopilotAgentOpenApplicationHandler;
	readonly editorCursorStatusApplication: EditorCursorStatusApplicationHandler;
	readonly editingPreferencesApplication: EditingPreferencesApplicationHandler;
	readonly kustoConnectionIntakeApplication: KustoConnectionIntakeApplicationHandler;
	readonly kustoConnectionOnboardingApplication: KustoConnectionOnboardingApplicationHandler;
	readonly sqlConnectionOnboardingApplication: SqlConnectionOnboardingApplicationHandler;
	readonly sqlFavoritesApplication: SqlFavoritesApplicationHandler;
	readonly kustoFavoritesApplication: KustoFavoritesApplicationHandler;
	readonly sqlDatabaseDiscoveryApplication: SqlDatabaseDiscoveryApplicationHandler;
	readonly kqlLanguageRequestApplication: KqlLanguageRequestApplicationHandler;
	readonly sqlLastSelectionApplication: SqlLastSelectionApplicationHandler;
	readonly developmentNoteMutationApplication: DevelopmentNoteMutationApplicationHandler;
	readonly copilotInlineCompletionApplication: CopilotInlineCompletionApplicationHandler;

	private get queryRuns(): QueryRunCoordinator {
		return this._queryRunCoordinator ??= new QueryRunCoordinator();
	}

	private get kustoExecutionCoordinator(): KustoExecutionCoordinator {
		return this._kustoExecutionCoordinator ??= new KustoExecutionCoordinator({
			queryRuns: this.queryRuns,
			postMessage: message => this.postKustoPublication(message),
			getCurrentConnectionOwner: connectionId => {
				const connection = this.connectionManager.getConnections().find(candidate => candidate.id === connectionId);
				if (!connection) return undefined;
				try {
					return Object.freeze({
						connectionRevision: this.connectionManager.getConnectionIncarnation(connection.id),
						connectionIdentityKey: getKustoConnectionIdentityKey(connection.clusterUrl, connection.authorityId),
					});
				} catch { return undefined; }
			},
		});
	}

	async postKustoPublication(message: unknown): Promise<boolean> {
		if (this._panelDisposed) return false;
		const publicationId = `kusto-publication-${crypto.randomUUID()}`;
		const publicationDeadline = Date.now() + 5_000;
		const waitForAck = (phase: 'staged' | 'applied', timeoutMs?: number): Promise<boolean> => new Promise(resolve => {
			const key = `${publicationId}:${phase}`;
			const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
				this.pendingKustoPublicationAcks.delete(key);
				resolve(false);
			}, timeoutMs);
			this.pendingKustoPublicationAcks.set(key, { resolve, ...(timer ? { timer } : {}) });
		});
		const settleTransportFailure = (phase: 'staged' | 'applied') => {
			const key = `${publicationId}:${phase}`;
			const pending = this.pendingKustoPublicationAcks.get(key);
			if (!pending) return;
			this.pendingKustoPublicationAcks.delete(key);
			if (pending.timer) clearTimeout(pending.timer);
			pending.resolve(false);
		};
		const staged = waitForAck('staged', 5_000);
		if (!await this.postMessage({
			type: 'kustoPublicationStage', publicationId, publicationDeadline,
			payload: message,
		})) settleTransportFailure('staged');
		if (!await staged) return false;
		const applied = waitForAck('applied');
		const appliedKey = `${publicationId}:applied`;
		const appliedPending = this.pendingKustoPublicationAcks.get(appliedKey);
		if (appliedPending) {
			appliedPending.timer = setTimeout(async () => {
				if (this.pendingKustoPublicationAcks.get(appliedKey) !== appliedPending) return;
				appliedPending.timer = setTimeout(() => settleTransportFailure('applied'), 1_000);
				if (!await this.postMessage({ type: 'kustoPublicationRevoke', publicationId })) settleTransportFailure('applied');
			}, Math.max(1, publicationDeadline - Date.now()));
		}
		if (!await this.postMessage({ type: 'kustoPublicationCommit', publicationId })) settleTransportFailure('applied');
		return applied;
	}

	private kustoExecutionAckKey(identity: Pick<KustoExecutionRequestIdentity, 'boxId' | 'executionId' | 'sectionInstanceId' | 'targetGeneration'>): string {
		return `${identity.boxId}\u0000${identity.sectionInstanceId}\u0000${identity.targetGeneration}\u0000${identity.executionId}`;
	}

	private async claimKustoExecutionInWebview(
		reservation: import('../shared/kustoExecution').KustoExecutionReservation, query: string,
		expectedPredecessorExecutionId?: string,
	): Promise<boolean> {
		const key = this.kustoExecutionAckKey(reservation);
		const prior = this.pendingKustoExecutionStartAcks.get(key);
		if (prior) {
			clearTimeout(prior.timer);
			prior.resolve(false);
		}
		const result = new Promise<boolean>(resolve => {
			const timer = setTimeout(() => {
				this.pendingKustoExecutionStartAcks.delete(key);
				resolve(false);
			}, 5000);
			this.pendingKustoExecutionStartAcks.set(key, { resolve, timer });
		});
		const message: KustoExecutionStarted = {
			type: 'kustoExecutionStarted', ...reservation, query,
			...(expectedPredecessorExecutionId ? { expectedPredecessorExecutionId } : {}),
		};
		const delivered = await this.postMessage(message);
		if (delivered !== true) {
			const pending = this.pendingKustoExecutionStartAcks.get(key);
			if (pending) {
				this.pendingKustoExecutionStartAcks.delete(key);
				clearTimeout(pending.timer);
				pending.resolve(false);
			}
		}
		return result;
	}

	private rejectPendingKustoExecutionStartAcks(): void {
		const pendingAcks = [...this.pendingKustoExecutionStartAcks.values()];
		this.pendingKustoExecutionStartAcks.clear();
		for (const pending of pendingAcks) {
			clearTimeout(pending.timer);
			pending.resolve(false);
		}
	}

	getKustoSectionExecutionTarget(boxId: string): KustoSectionExecutionTarget | undefined {
		const owner = this.kustoExecutionCoordinator.getTarget(boxId);
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
		return this.kustoExecutionCoordinator.cancelExpected({
			boxId: target.boxId,
			executionId,
			sectionInstanceId: target.sectionInstanceId,
			targetGeneration: target.targetGeneration,
		});
	}

	getKustoSectionExecutionAccountPartition(target: KustoSectionExecutionTarget, executionId: string): string | undefined {
		return this.kustoExecutionCoordinator.getDispatchAccountPartition({
			boxId: target.boxId,
			executionId,
			sectionInstanceId: target.sectionInstanceId,
			targetGeneration: target.targetGeneration,
		});
	}

	getCurrentKustoConnectionForDispatch(connectionId: string, dispatch: KustoDispatchIdentity): KustoConnection | undefined {
		const current = this.connectionManager.getConnections().find(connection => connection.id === connectionId);
		return current
			&& this.connectionManager.getConnectionIncarnation(connectionId) === dispatch.connectionRevision
			&& getKustoConnectionIdentityKey(current.clusterUrl, current.authorityId) === dispatch.connectionIdentityKey
			&& this.kustoClient.getConnectionSessionGeneration(current) === dispatch.authSessionGeneration
			? current
			: undefined;
	}

	// SQL schema responses and persistence remain provider adapters. Editor lifecycle
	// state is owned by SqlEditorLifecycleCoordinator; shared runtime state stays in SqlWorkbenchService.
	private _sqlSchemaService?: SqlSchemaService;
	private readonly sqlLifecycle: SqlEditorLifecycleCoordinator;
	private readonly _comparisonOwnerByBoxId = new Map<string, {
		sourceBoxId: string;
		copilotSequence?: number;
		comparisonRequestId?: string;
	}>();
	private _sqlConnectionsSnapshotRevision = 0;
	private sqlConnectionsSnapshotTail: Promise<boolean> = Promise.resolve(true);
	private readonly sqlPersistenceInvalidationEmitter = new vscode.EventEmitter<void>();
	readonly onDidInvalidateSqlPersistence = this.sqlPersistenceInvalidationEmitter.event;
	private readonly kustoPersistenceInvalidationEmitter = new vscode.EventEmitter<void>();
	readonly onDidInvalidateKustoPersistence = this.kustoPersistenceInvalidationEmitter.event;

	get sqlExecutionBroker() {
		return this.sqlLifecycle.executionBroker;
	}

	get sqlConnectionManager() {
		return this.sqlWorkbench.connectionManager;
	}

	get sqlClient(): SqlQueryClient {
		return this.sqlWorkbench.client;
	}

	get sqlSchemaService(): SqlSchemaService {
		if (!this._sqlSchemaService) {
			this._sqlSchemaService = new SqlSchemaService({
				context: this.context,
				sqlClient: this.sqlClient,
				output: this.output,
				assertSqlConnectionAllowed: connectionId => this.sqlWorkbench.assertSqlConnectionAllowed(connectionId),
				getCurrentSqlConnection: connectionId => this.sqlConnectionManager.getConnection(connectionId),
				postMessage: (msg) => this.postMessage(msg),
			});
		}
		return this._sqlSchemaService;
	}

	assertSqlConnectionAllowed(connectionId: string): Promise<void> {
		return this.sqlWorkbench.assertSqlConnectionAllowed(connectionId);
	}

	dispatchSqlConnectionAllowed<T>(connectionId: string, dispatch: () => T | PromiseLike<T>): Promise<T> {
		return this.sqlWorkbench.dispatchSqlConnectionAllowed(connectionId, dispatch);
	}

	dispatchSqlResultOwnerAllowed<T>(
		boxId: string,
		expectedOwner: SqlResultOwner,
		dispatch: () => T | PromiseLike<T>,
	): Promise<T> {
		return this.sqlLifecycle.dispatchResultOwnerAllowed(boxId, expectedOwner, dispatch);
	}

	getSqlResultOwner(boxId: string): SqlResultOwner | undefined {
		return this.sqlLifecycle.getResultOwner(boxId);
	}

	private async getCanonicalSqlResultOwner(boxId: string): Promise<SqlResultOwner | undefined> {
		return this.sqlLifecycle.getCanonicalResultOwner(boxId);
	}

	async assertSqlResultOwnerAllowed(boxId: string, expectedOwner: SqlResultOwner): Promise<void> {
		await this.sqlLifecycle.assertResultOwnerAllowed(boxId, expectedOwner);
	}

	async assertSqlResultOwnerProtection(boxId: string, expectedOwner: SqlResultOwner, expectedProtected: boolean): Promise<void> {
		await this.sqlLifecycle.assertResultOwnerProtection(boxId, expectedOwner, expectedProtected);
	}

	private sqlResultOwnersEqual(left: SqlResultOwner | undefined, right: SqlResultOwner | undefined): boolean {
		return sqlResultOwnersEqual(left, right);
	}

	private async assertSqlOwnerToken(boxId: string, token: string | undefined): Promise<{ token: string; owner: SqlResultOwner }> {
		return this.sqlLifecycle.assertOwnerToken(boxId, token);
	}

	private readonly pendingComparisonEnsureByRequestId = new Map<string, PendingComparisonEnsure>();

	private settlePendingComparisonEnsure(
		requestId: string,
		pending: PendingComparisonEnsure,
		outcome: { comparison: PreparedComparisonSection } | { error: Error },
		options: { rollbackConfirmed?: boolean } = {},
	): void {
		if (this.pendingComparisonEnsureByRequestId.get(requestId) !== pending) return;
		if ('error' in outcome && pending.completionStarted
			&& options.rollbackConfirmed !== true && !this._panelDisposed) return;
		if ('error' in outcome && pending.sqlConnectionId && pending.comparisonBoxId
			&& options.rollbackConfirmed !== true && !this._panelDisposed) {
			void this.rollbackPendingSqlComparison(requestId, pending, outcome.error);
			return;
		}
		this.pendingComparisonEnsureByRequestId.delete(requestId);
		try { clearTimeout(pending.timer); } catch { /* ignore */ }
		try { if (pending.rollbackRetryTimer) clearTimeout(pending.rollbackRetryTimer); } catch { /* ignore */ }
		try { pending.cancellationDisposable?.dispose(); } catch { /* ignore */ }
		if (pending.sqlAdmissionAck) {
			const admissionAck = pending.sqlAdmissionAck;
			pending.sqlAdmissionAck = undefined;
			try { clearTimeout(admissionAck.timer); } catch { /* ignore */ }
			admissionAck.resolve(false);
		}
		if ('error' in outcome) {
			const comparisonBoxId = String(pending.comparisonBoxId || '').trim();
			if (comparisonBoxId
				&& this._comparisonOwnerByBoxId.get(comparisonBoxId)?.comparisonRequestId === requestId) {
				this._comparisonOwnerByBoxId.delete(comparisonBoxId);
			}
			if (comparisonBoxId
				&& this.sqlLifecycle.getComparisonOwner(comparisonBoxId)?.comparisonRequestId === requestId) {
				this.sqlLifecycle.removeComparisonOwner(comparisonBoxId);
			}
			pending.reject(outcome.error);
			return;
		}
		pending.resolve(outcome.comparison);
	}

	private async rollbackPendingSqlComparison(
		requestId: string,
		pending: PendingComparisonEnsure,
		error: Error,
	): Promise<void> {
		if (this.pendingComparisonEnsureByRequestId.get(requestId) !== pending || pending.rollbackInProgress) return;
		pending.rollbackInProgress = true;
		try { clearTimeout(pending.timer); } catch { /* ignore */ }
		if (pending.sqlAdmissionAck) {
			const currentAck = pending.sqlAdmissionAck;
			pending.sqlAdmissionAck = undefined;
			try { clearTimeout(currentAck.timer); } catch { /* ignore */ }
			currentAck.resolve(false);
		}
		const comparisonBoxId = String(pending.comparisonBoxId || '').trim();
		let rolledBack = false;
		for (let attempt = 0; attempt < 3 && !rolledBack; attempt += 1) {
			if (this.pendingComparisonEnsureByRequestId.get(requestId) !== pending || this._panelDisposed) return;
			rolledBack = await this.waitForSqlComparisonAdmission(
				requestId, pending, comparisonBoxId, 'rolledBack',
			);
		}
		if (this.pendingComparisonEnsureByRequestId.get(requestId) !== pending) return;
		if (!rolledBack) {
			pending.rollbackInProgress = false;
			pending.rollbackRetryTimer = setTimeout(() => {
				pending.rollbackRetryTimer = undefined;
				void this.rollbackPendingSqlComparison(requestId, pending, error);
			}, 1_000);
			return;
		}
		pending.rollbackInProgress = false;
		void this.postMessage({
			type: 'sqlComparisonAdmissionRelease', outcome: 'rolledBack', requestId,
			sourceBoxId: pending.sourceBoxId, comparisonBoxId,
		});
		this.settlePendingComparisonEnsure(requestId, pending, { error }, { rollbackConfirmed: true });
	}

	private waitForSqlComparisonAdmission(
		requestId: string,
		pending: PendingComparisonEnsure,
		comparisonBoxId: string,
		phase: 'staged' | 'committed' | 'finalized' | 'completed' | 'rolledBack',
	): Promise<boolean> {
		if (this.pendingComparisonEnsureByRequestId.get(requestId) !== pending) return Promise.resolve(false);
		return new Promise<boolean>(resolve => {
			let settled = false;
			const complete = (accepted: boolean) => {
				if (settled) return;
				settled = true;
				const admissionAck = pending.sqlAdmissionAck;
				if (admissionAck?.comparisonBoxId === comparisonBoxId && admissionAck.phase === phase) {
					pending.sqlAdmissionAck = undefined;
					try { clearTimeout(admissionAck.timer); } catch { /* ignore */ }
				}
				resolve(accepted);
			};
			const timer = setTimeout(() => complete(false), 5_000);
			pending.sqlAdmissionAck = { comparisonBoxId, phase, resolve: complete, timer };
			void Promise.resolve(this.postMessage({
				type: phase === 'staged' ? 'sqlComparisonAdmission'
					: phase === 'committed' ? 'sqlComparisonAdmissionCommit'
						: phase === 'finalized' ? 'sqlComparisonAdmissionFinalize'
							: phase === 'completed' ? 'sqlComparisonAdmissionComplete'
								: 'sqlComparisonAdmissionRollback',
				requestId, sourceBoxId: pending.sourceBoxId, comparisonBoxId,
				...(phase === 'staged' ? { accepted: true } : {}),
			})).then(delivered => {
				if (delivered === false) complete(false);
			}, () => complete(false));
		});
	}
	private readonly latestComparisonSummaryByKey = new Map<
		string,
		{ dataMatches: boolean; headersMatch: boolean; timestamp: number }
	>();
	private readonly pendingComparisonSummaryByKey = new Map<
		string,
		Array<{
			resolve: (summary: { dataMatches: boolean; headersMatch: boolean }) => void;
			reject: (error: Error) => void;
			timer: ReturnType<typeof setTimeout>;
		}>
	>();
	private readonly copilot: CopilotService;
	private configSubscription?: vscode.Disposable;
	private authPreferenceSubscription?: vscode.Disposable;
	private readonly kustoConnectionLifecycle: KustoConnectionLifecycle;
	private embeddedTutorialHost?: EmbeddedTutorialWebviewHost;
	private embeddedTutorialRegistration?: vscode.Disposable;
	fileOpenTrace?: FileOpenTrace;

	getErrorMessage(error: unknown): string {
		return getErrorMessageFn(error);
	}

	formatQueryExecutionErrorForUser(error: unknown, connection: KustoConnection, database?: string): string {
		const raw = this.getErrorMessage(error);
		return formatQueryExecutionErrorForUserFn(raw, connection.clusterUrl, database);
	}

	logQueryExecutionError(error: unknown, connection: KustoConnection, database: string | undefined, boxId: string, query: string): void {
		try {
			const raw = this.getErrorMessage(error);
			const cluster = String(connection.clusterUrl || '').trim();
			this.output.error([
				`[${new Date().toISOString()}] Query execution failed`,
				`  cluster: ${cluster}`,
				...(database ? [`  database: ${database}`] : []),
				...(boxId ? [`  boxId: ${boxId}`] : []),
				'  query:',
				query,
				'  error:',
				raw,
			].join('\n'));
		} catch {
			// ignore
		}
	}

	constructor(
		readonly extensionUri: vscode.Uri,
		readonly connectionManager: ConnectionManager,
		readonly context: vscode.ExtensionContext,
		private readonly sqlWorkbench: SqlWorkbenchService,
		editorCursorStatusBar?: EditorCursorStatusBar,
		dashboardApplication?: DashboardApplicationHandler,
		artifactCsvSaveApplication?: ArtifactCsvSaveApplicationHandler,
		pythonExecutionApplication?: PythonExecutionApplicationHandler,
		importedCsvSaveApplication?: ImportedCsvSaveApplicationHandler,
		querySharingApplication?: QuerySharingApplicationHandler,
		urlContentApplication?: UrlContentApplicationHandler,
		controlCommandSyntaxApplication?: ControlCommandSyntaxApplicationHandler,
		resourceUriApplication?: ResourceUriApplicationHandler,
		copilotContentOpenApplication?: CopilotContentOpenApplicationHandler,
		informationNotificationApplication?: InformationNotificationApplicationHandler,
		cachedValuesOpenApplication?: CachedValuesOpenApplicationHandler,
		copilotAgentOpenApplication?: CopilotAgentOpenApplicationHandler,
		editorCursorStatusApplication?: EditorCursorStatusApplicationHandler,
		editingPreferencesApplication?: EditingPreferencesApplicationHandler,
		kustoConnectionIntakeApplication?: KustoConnectionIntakeApplicationHandler,
		kustoConnectionOnboardingApplication?: KustoConnectionOnboardingApplicationHandler,
		sqlConnectionOnboardingApplication?: SqlConnectionOnboardingApplicationHandler,
		sqlFavoritesApplication?: SqlFavoritesApplicationHandler,
		kustoFavoritesApplication?: KustoFavoritesApplicationHandler,
		sqlDatabaseDiscoveryApplication?: SqlDatabaseDiscoveryApplicationHandler,
		kqlLanguageRequestApplication?: KqlLanguageRequestApplicationHandler,
		sqlLastSelectionApplication?: SqlLastSelectionApplicationHandler,
		developmentNoteMutationApplication?: DevelopmentNoteMutationApplicationHandler,
		copilotInlineCompletionApplication?: CopilotInlineCompletionApplicationHandler,
	) {
		this.kustoClient = new KustoQueryClient(this.context, undefined, this.connectionManager);
		this.dashboardApplication = dashboardApplication ?? new HostDashboardApplicationHandler({
			postMessage: message => this.postMessage(message),
			isDisposed: () => this._panelDisposed,
			output: this.output,
			connectionManager: this.connectionManager,
		});
		this.artifactCsvSaveApplication = artifactCsvSaveApplication ?? new HostArtifactCsvSaveApplicationHandler({
			postMessage: message => this.postMessage(message),
			isDisposed: () => this._panelDisposed,
		});
		this.pythonExecutionApplication = pythonExecutionApplication ?? new HostPythonExecutionApplicationHandler({
			postMessage: message => this.postMessage(message),
		});
		this.importedCsvSaveApplication = importedCsvSaveApplication ?? new HostImportedCsvSaveApplicationHandler();
		this.querySharingApplication = querySharingApplication ?? new HostQuerySharingApplicationHandler({
			findConnection: connectionId => this.connection.findConnection(connectionId),
			postMessage: message => this.postMessage(message),
		});
		this.urlContentApplication = urlContentApplication ?? new HostUrlContentApplicationHandler({
			postMessage: message => this.postMessage(message),
		});
		this.controlCommandSyntaxApplication = controlCommandSyntaxApplication ?? new HostControlCommandSyntaxApplicationHandler({
			postMessage: message => this.postMessage(message),
		});
		this.resourceUriApplication = resourceUriApplication ?? new HostResourceUriApplicationHandler({
			postMessage: message => this.postMessage(message),
			asWebviewUri: uri => this.panel?.webview.asWebviewUri(uri),
		});
		this.copilotContentOpenApplication = copilotContentOpenApplication
			?? new HostCopilotContentOpenApplicationHandler();
		this.informationNotificationApplication = informationNotificationApplication
			?? new HostInformationNotificationApplicationHandler();
		this.cachedValuesOpenApplication = cachedValuesOpenApplication
			?? new HostCachedValuesOpenApplicationHandler();
		this.copilotAgentOpenApplication = copilotAgentOpenApplication
			?? new HostCopilotAgentOpenApplicationHandler();
		this.editorCursorStatusApplication = editorCursorStatusApplication
			?? new HostEditorCursorStatusApplicationHandler({
				statusBar: editorCursorStatusBar,
				extensionMode: this.context.extensionMode,
				postMessage: message => this.postMessage(message),
			});
		this.editingPreferencesApplication = editingPreferencesApplication
			?? new HostEditingPreferencesApplicationHandler({
				context: this.context,
				getPublisher: () => toolOrchestrator,
				postMessage: message => this.postMessage(message),
			});
		this.kustoConnectionIntakeApplication = kustoConnectionIntakeApplication
			?? new HostKustoConnectionIntakeApplicationHandler({
				connectionManager: this.connectionManager,
				postMessage: message => this.postMessage(message),
				refreshConnections: () => this.sendConnectionsData(),
			});
		this.authPreferenceSubscription = KustoAuthPreferenceService.getInstance(this.context).onDidChange(change => {
			this.handleKustoAuthPreferenceChange(change);
		});
		this.connection = new ConnectionService(this);
		this.kustoConnectionOnboardingApplication = kustoConnectionOnboardingApplication
			?? new HostKustoConnectionOnboardingApplicationHandler({
				connectionManager: this.connectionManager,
				authPreferences: KustoAuthPreferenceService.getInstance(this.context),
				kustoClient: this.kustoClient,
				saveLastSelection: (connectionId, database) => this.connection.saveLastSelection(connectionId, database),
				getLastSelection: () => ({
					lastConnectionId: this.connection.getLastConnectionId(),
					lastDatabase: this.connection.getLastDatabase(),
				}),
				postMessage: message => this.postMessage(message),
				refreshConnections: () => this.sendConnectionsData(),
				output: this.output,
			});
		this.sqlConnectionOnboardingApplication = sqlConnectionOnboardingApplication
			?? new HostSqlConnectionOnboardingApplicationHandler({
				connectionManager: this.sqlConnectionManager,
				globalState: this.context.globalState,
				postMessage: message => this.postMessage(message),
			});
		this.sqlFavoritesApplication = sqlFavoritesApplication
			?? new HostSqlFavoritesApplicationHandler({
				connectionManager: this.sqlConnectionManager,
				globalState: this.context.globalState,
				postMessage: message => this.postMessage(message),
				output: this.output,
			});
		this.kustoFavoritesApplication = kustoFavoritesApplication
			?? new HostKustoFavoritesApplicationHandler({
				context: this.context,
				connectionManager: this.connectionManager,
				kustoClient: this.kustoClient,
				authPreferences: KustoAuthPreferenceService.getInstance(this.context),
				postMessage: message => this.postMessage(message),
				output: this.output,
			});
		this.schema = new SchemaService(this);
		this.sqlLifecycle = new SqlEditorLifecycleCoordinator({
			context: this.context,
			sqlWorkbench: this.sqlWorkbench,
			queryRuns: this.queryRuns,
			output: this.output,
			hasWebview: () => !!this.panel && !this._panelDisposed,
			effects: {
				postMessage: message => this.postMessage(message),
				cancelCopilotWriteQuery: (boxId, expectedSequence) => this.copilot.cancelCopilotWriteQuery(boxId, expectedSequence),
				cancelCopilotQueryTarget: (sourceBoxId, targetBoxId, expectedSequence) =>
					this.copilot.cancelCopilotQueryTarget(sourceBoxId, targetBoxId, expectedSequence),
				invalidateSqlCopilot: (connectionIds, comparisonBoxIds) =>
					this.copilot.invalidateSqlConnections([...connectionIds], [...comparisonBoxIds]),
				rejectPendingComparisonEnsures: sourceBoxId => {
					for (const [requestId, pending] of [...this.pendingComparisonEnsureByRequestId]) {
						if (pending.sourceBoxId === sourceBoxId) {
							this.settlePendingComparisonEnsure(requestId, pending, { error: new Error('Canceled') });
						}
					}
				},
				deleteComparisonSummary: (sourceBoxId, comparisonBoxId) =>
					this.deleteComparisonSummary(`${sourceBoxId}::${comparisonBoxId}`),
				invalidatePersistence: () => this.sqlPersistenceInvalidationEmitter.fire(),
				refreshConnectionsData: () => this.sendSqlConnectionsData(),
				prefetchSchema: (connectionId, database, boxId, forceRefresh) =>
					this.prefetchSqlSchema(connectionId, database, boxId, forceRefresh),
			},
		});
		this.sqlDatabaseDiscoveryApplication = sqlDatabaseDiscoveryApplication
			?? new HostSqlDatabaseDiscoveryApplicationHandler({
				context: this.context,
				lifecycle: this.sqlLifecycle,
				workbench: this.sqlWorkbench,
				connectionManager: this.sqlConnectionManager,
				client: this.sqlClient,
				postMessage: message => this.postMessage(message),
				output: this.output,
			});
		this.kqlLanguageRequestApplication = kqlLanguageRequestApplication
			?? new HostKqlLanguageRequestApplicationHandler({
				connectionManager: this.connectionManager,
				context: this.context,
				postMessage: message => this.postMessage(message),
				output: this.output,
			});
		this.sqlLastSelectionApplication = sqlLastSelectionApplication
			?? new HostSqlLastSelectionApplicationHandler({
				globalState: this.context.globalState,
			});
		this.developmentNoteMutationApplication = developmentNoteMutationApplication
			?? new HostDevelopmentNoteMutationApplicationHandler({
				postMessage: message => this.postMessage(message),
				isAvailable: () => !!this.panel,
			});
		this.copilotInlineCompletionApplication = copilotInlineCompletionApplication
			?? new HostCopilotInlineCompletionApplicationHandler({
				assertSqlOwnerToken: (boxId, ownerToken) => this.assertSqlOwnerToken(boxId, ownerToken),
				handleCopilotInlineCompletionRequest: (message, expectedSqlOwner, ownerToken) =>
					this.copilot.handleCopilotInlineCompletionRequest(message, expectedSqlOwner, ownerToken),
				postMessage: message => this.postMessage(message),
			});
		this.copilot = new CopilotService(this);
		this.kustoConnectionLifecycle = new KustoConnectionLifecycle(this.connectionManager, {
			invalidateConnections: connectionIds => {
				this.kustoExecutionCoordinator.revokeConnections(connectionIds);
				this.copilot.invalidateKustoConnections([...connectionIds]);
				this.kustoPersistenceInvalidationEmitter.fire();
			},
			invalidatePhysicalTargets: connectionIds => this.kustoExecutionCoordinator.invalidatePhysicalConnections(connectionIds),
			publishIdentityChange: connectionIds => this.postMessage({
				type: 'kustoAuthIdentityChanged', connectionIds: [...connectionIds], reason: 'connection-mutated',
			}),
			refreshConnections: () => this.sendConnectionsData(),
		});
		this.sqlLifecycle.startSession();
	}

	private handleKustoAuthPreferenceChange(change: KustoAuthPreferenceChange): void {
		const establishingAccountPartition = change.reason === 'success' && change.firstEstablishment === true
			? change.accountPartition
			: undefined;
		if (change.connectionIds.length > 0) {
			this.kustoExecutionCoordinator.revokeConnections(
				change.connectionIds,
				establishingAccountPartition,
			);
			this.copilot.invalidateKustoConnections(change.connectionIds, {
				preserveEstablishingAccountPartition: establishingAccountPartition,
			});
			this.kustoPersistenceInvalidationEmitter.fire();
			if (change.reason !== 'success' || change.firstEstablishment !== true) {
				this.postMessage({ type: 'kustoAuthIdentityChanged', connectionIds: change.connectionIds, reason: change.reason });
			}
		}
		void this.sendConnectionsData();
	}

	async initializeWebviewPanel(
		panel: vscode.WebviewPanel,
		options?: { registerMessageHandler?: boolean; hideFooterControls?: boolean; initialDocumentLoading?: boolean }
	): Promise<void> {
		this.sqlLifecycle.startSession();
		this._panelDisposed = false;
		perfMark('host.queryEditorProvider.initialize.start', { initialDocumentLoading: !!options?.initialDocumentLoading });
		this.fileOpenTrace?.mark('queryEditorProvider.initialize.start', { visible: panel.visible, active: panel.active, viewType: panel.viewType, documentUri: this.documentUri });
		this.kustoFavoritesApplication.activate();
		this.fileOpenTrace?.mark('queryEditorProvider.connection.activate.done');
		this.panel = panel;
		this.editorCursorStatusApplication.setPanelVisible(panel.visible);
		QueryEditorProvider.activeProviders.add(this);
		this.registerPanelDisposal(panel);
		// Do NOT set panel.iconPath here — this method is called for custom editors
		// where VS Code owns the panel. Setting iconPath on a custom-editor panel
		// can crash VS Code's renderer-side editor integration ("Unexpected type"
		// in $setIconPath) and break the entire webview. Standalone panels set
		// their icon in openEditor() instead.
		this.fileOpenTrace?.mark('queryEditorProvider.html.load.start');
		const webview = panel.webview;
		const html = await getQueryEditorHtml(webview, this.extensionUri, this.context, {
			hideFooterControls: !!options?.hideFooterControls,
			initialDocumentLoading: !!options?.initialDocumentLoading
		});
		if (this._panelDisposed || this.panel !== panel) return;
		this.editorCursorStatusApplication.setPanelVisible(panel.visible);
		webview.html = html;
		perfMark('host.queryEditorProvider.htmlAssigned');
		this.fileOpenTrace?.mark('queryEditorProvider.html.assigned');
		this.embeddedTutorialHost = new EmbeddedTutorialWebviewHost(this.panel, this.documentUri);
		this.embeddedTutorialRegistration = EmbeddedTutorialWebviewRegistry.register(this.embeddedTutorialHost);
		this.fileOpenTrace?.mark('queryEditorProvider.embeddedTutorial.registered');

		const shouldRegisterMessageHandler = options?.registerMessageHandler !== false;
		if (shouldRegisterMessageHandler) {
			// Ensure messages from the webview are handled in all host contexts (including custom editors).
			// openEditor() also wires this up for the standalone panel, but custom editors call initializeWebviewPanel().
			this.panel.webview.onDidReceiveMessage((message: IncomingWebviewMessage) => {
				this.fileOpenTrace?.mark('queryEditorProvider.webviewMessage.received', { type: message?.type });
				return this.handleWebviewMessage(message);
			});
		}
		this.fileOpenTrace?.mark('queryEditorProvider.messageHandler.configured', { shouldRegisterMessageHandler });

		// Connect the tool orchestrator to this webview instance
		this.connectToolOrchestrator();
		this.fileOpenTrace?.mark('queryEditorProvider.toolOrchestrator.connected');

		// Reconnect the orchestrator when this panel becomes visible again
		// (e.g. user switches from another .kqlx tab back to this one).
		this.panel.onDidChangeViewState(() => {
			this.fileOpenTrace?.mark('queryEditorProvider.viewState.changed', { visible: this.panel?.visible, active: this.panel?.active });
			const visible = this.panel?.visible === true;
			this.editorCursorStatusApplication.setPanelVisible(visible);
			if (visible) {
				this.connectToolOrchestrator();
			}
		});

		this.sendWorkbenchSettings();
		this.watchWorkbenchSettings();
		perfMark('host.queryEditorProvider.initialize.end');
		this.fileOpenTrace?.mark('queryEditorProvider.initialize.end');
	}

	// Token returned by the orchestrator's connect(), used to guard disconnect.
	private toolOrchestratorToken: number | undefined;

	/** URI string of the backing document (set by custom editor providers before initializeWebviewPanel). */
	documentUri?: string;

	private connectToolOrchestrator(): void {
		if (!toolOrchestrator) return;
		if (this.toolOrchestratorToken !== undefined) {
			toolOrchestrator.activateConnection(this.toolOrchestratorToken);
			return;
		}

		this.toolOrchestratorToken = toolOrchestrator.connect(
			(message: unknown) => this.postMessage(message),
			async () => {
				const sections = await this.requestSectionsFromWebview();
				return sections as Array<{ id?: string; type: string; [key: string]: unknown }> | undefined;
			},
			async (clusterUrl: string, connectionId: string) => {
				const sections = await this.requestSectionsFromWebview('schema-refresh', connectionId) ?? [];
				const connections = this.connectionManager.getConnections();
				const targets = sections.flatMap(section => {
					const candidate = section as {
						id?: unknown; type?: unknown; connectionId?: unknown; schemaRequestToken?: unknown;
						sectionInstanceId?: unknown; targetGeneration?: unknown;
						clusterUrl?: unknown; authorityId?: unknown; connectionIdHint?: unknown; database?: unknown;
					};
					if (canonicalSectionKind(candidate.type) !== 'query') return [];
					const boxId = String(candidate.id || '').trim();
					const database = String(candidate.database || '').trim();
					const runtimeConnectionId = String(candidate.connectionId || '').trim();
					const resolution = runtimeConnectionId
						? resolveStrictKustoConnection(connections, { clusterUrl: candidate.clusterUrl, connectionId: runtimeConnectionId })
						: resolveKustoConnection(connections, candidate);
					return boxId && database && resolution.kind === 'matched' && resolution.connection.id === connectionId
						? [{
							boxId, database, requestToken: String(candidate.schemaRequestToken || '').trim() || undefined,
							...(typeof candidate.sectionInstanceId === 'string' && Number.isSafeInteger(candidate.targetGeneration)
								? { sectionInstanceId: candidate.sectionInstanceId, targetGeneration: Number(candidate.targetGeneration) }
								: {}),
						}]
						: [];
				});
				return this.schema.refreshSchemaForTools(clusterUrl, connectionId, targets);
			},
			this.documentUri,
			(sectionId?: string) => {
				const id = String(sectionId || '').trim();
				if (id) return this.sqlLifecycle.getConnectionId(id);
				return this.sqlLifecycle.getFirstConnectionId();
			},
			(sectionId: string) => {
				const id = String(sectionId || '').trim();
				return id ? this.sqlLifecycle.getReadyToolOwner(id) : undefined;
			},
		);
	}

	private disconnectToolOrchestrator(): void {
		if (!toolOrchestrator || this.toolOrchestratorToken === undefined) return;
		toolOrchestrator.disconnectIfOwner(this.toolOrchestratorToken);
		this.toolOrchestratorToken = undefined;
	}

	private toolStateResponseResolvers = new Map<string, (sections: unknown[] | undefined) => void>();
	private connectionsDataRevision = 0;
	private connectionsDataTail: Promise<void> = Promise.resolve();

	async requestSectionsFromWebview(purpose?: 'schema-refresh', targetConnectionId?: string): Promise<unknown[] | undefined> {
		if (!this.panel) return undefined;
		
		const requestId = `state_${Date.now()}_${Math.random().toString(36).slice(2)}`;
		
		return new Promise<unknown[] | undefined>((resolve) => {
			const timer = setTimeout(() => {
				this.toolStateResponseResolvers.delete(requestId);
				resolve(undefined);
			}, 5000);
			
			this.toolStateResponseResolvers.set(requestId, (sections) => {
				clearTimeout(timer);
				this.toolStateResponseResolvers.delete(requestId);
				if (sections) this.rebuildSqlComparisonOwners(sections);
				resolve(sections);
			});
			
			this.postMessage({
				type: 'requestToolState', requestId,
				...(purpose ? { purpose } : {}),
				...(targetConnectionId ? { targetConnectionId } : {}),
			});
		});
	}

	updateDevelopmentNotes(message: Record<string, unknown>): Promise<{ success: boolean; error?: string }> {
		return this.developmentNoteMutationApplication.updateDevelopmentNotes(message);
	}

	private rebuildSqlComparisonOwners(sections: unknown[]): void {
		this.sqlLifecycle.reconcileComparisonOwners(sections);
	}

	async openEditor(): Promise<void> {
		if (this.panel) {
			this.panel.reveal(vscode.ViewColumn.One);
			return;
		}
		this.kustoFavoritesApplication.activate();
		this.sqlLifecycle.startSession();
		this._panelDisposed = false;

		this.panel = vscode.window.createWebviewPanel(
			'kustoQueryEditor',
			'Kusto Query Editor',
			vscode.ViewColumn.One,
			{
				enableScripts: true,
				localResourceRoots: [this.extensionUri],
				retainContextWhenHidden: true
			}
		);
		const panel = this.panel;
		this.editorCursorStatusApplication.setPanelVisible(panel.visible);
		this.registerPanelDisposal(panel);
		try {
			const light = vscode.Uri.joinPath(this.extensionUri, 'media', 'images', 'kusto-file-light.svg');
			const dark = vscode.Uri.joinPath(this.extensionUri, 'media', 'images', 'kusto-file-dark.svg');
			this.panel.iconPath = { light, dark };
		} catch {
			// ignore
		}

		const webview = panel.webview;
		const html = await getQueryEditorHtml(webview, this.extensionUri, this.context);
		if (this._panelDisposed || this.panel !== panel) return;
		this.editorCursorStatusApplication.setPanelVisible(panel.visible);
		webview.html = html;


		this.panel.webview.onDidReceiveMessage((message: IncomingWebviewMessage) => {
			return this.handleWebviewMessage(message);
		});

		// Connect the tool orchestrator to this webview instance
		this.connectToolOrchestrator();

		// Reconnect the orchestrator when this panel becomes visible again
		this.panel.onDidChangeViewState(() => {
			const visible = this.panel?.visible === true;
			this.editorCursorStatusApplication.setPanelVisible(visible);
			if (visible) {
				this.connectToolOrchestrator();
			}
		});

		this.sendWorkbenchSettings();
		this.watchWorkbenchSettings();
	}

	public async handleWebviewMessage(message: IncomingWebviewMessage): Promise<void> {
		if (message?.type === 'fileOpenTrace') {
			this.fileOpenTrace?.mark(`webview.${message.event}`, { timeMs: message.timeMs, sequence: message.sequence, detail: message.detail });
			return;
		}
		if (this.embeddedTutorialHost?.handleMessage(message)) {
			return;
		}
		const dashboardApplicationMessage = this.dashboardApplication?.handleMessage(message);
		if (dashboardApplicationMessage) {
			await dashboardApplicationMessage;
			return;
		}
		const artifactCsvSaveApplicationMessage = this.artifactCsvSaveApplication?.handleMessage(message);
		if (artifactCsvSaveApplicationMessage) {
			await artifactCsvSaveApplicationMessage;
			return;
		}
		const pythonExecutionApplicationMessage = this.pythonExecutionApplication?.handleMessage(message);
		if (pythonExecutionApplicationMessage) {
			await pythonExecutionApplicationMessage;
			return;
		}
		const importedCsvSaveApplicationMessage = this.importedCsvSaveApplication?.handleMessage(message);
		if (importedCsvSaveApplicationMessage) {
			await importedCsvSaveApplicationMessage;
			return;
		}
		const querySharingApplicationMessage = this.querySharingApplication?.handleMessage(message);
		if (querySharingApplicationMessage) {
			await querySharingApplicationMessage;
			return;
		}
		const urlContentApplicationMessage = this.urlContentApplication?.handleMessage(message);
		if (urlContentApplicationMessage) {
			await urlContentApplicationMessage;
			return;
		}
		const controlCommandSyntaxApplicationMessage = this.controlCommandSyntaxApplication?.handleMessage(message);
		if (controlCommandSyntaxApplicationMessage) {
			await controlCommandSyntaxApplicationMessage;
			return;
		}
		const resourceUriApplicationMessage = this.resourceUriApplication?.handleMessage(message);
		if (resourceUriApplicationMessage) {
			await resourceUriApplicationMessage;
			return;
		}
		const cachedValuesOpenApplicationMessage = this.cachedValuesOpenApplication?.handleMessage(message);
		if (cachedValuesOpenApplicationMessage) {
			await cachedValuesOpenApplicationMessage;
			return;
		}
		const copilotAgentOpenApplicationMessage = this.copilotAgentOpenApplication?.handleMessage(message);
		if (copilotAgentOpenApplicationMessage) {
			await copilotAgentOpenApplicationMessage;
			return;
		}
		const copilotContentOpenApplicationMessage = this.copilotContentOpenApplication?.handleMessage(message);
		if (copilotContentOpenApplicationMessage) {
			await copilotContentOpenApplicationMessage;
			return;
		}
		if (this.informationNotificationApplication?.handleMessage(message)) {
			return;
		}
		const editorCursorStatusApplicationMessage = this.editorCursorStatusApplication?.handleMessage(message);
		if (editorCursorStatusApplicationMessage) {
			if (editorCursorStatusApplicationMessage !== true) {
				await editorCursorStatusApplicationMessage;
			}
			return;
		}
		const editingPreferencesApplicationMessage = this.editingPreferencesApplication?.handleMessage(message);
		if (editingPreferencesApplicationMessage) {
			await editingPreferencesApplicationMessage;
			return;
		}
		const kustoConnectionIntakeApplicationMessage = this.kustoConnectionIntakeApplication?.handleMessage(message);
		if (kustoConnectionIntakeApplicationMessage) {
			await kustoConnectionIntakeApplicationMessage;
			return;
		}
		const kustoConnectionOnboardingApplicationMessage = this.kustoConnectionOnboardingApplication?.handleMessage(message);
		if (kustoConnectionOnboardingApplicationMessage) {
			await kustoConnectionOnboardingApplicationMessage;
			return;
		}
		const sqlConnectionOnboardingApplicationMessage = this.sqlConnectionOnboardingApplication?.handleMessage(message);
		if (sqlConnectionOnboardingApplicationMessage) {
			await sqlConnectionOnboardingApplicationMessage;
			return;
		}
		const sqlFavoritesApplicationMessage = this.sqlFavoritesApplication?.handleMessage(message);
		if (sqlFavoritesApplicationMessage) {
			await sqlFavoritesApplicationMessage;
			return;
		}
		const kustoFavoritesApplicationMessage = this.kustoFavoritesApplication?.handleMessage(message);
		if (kustoFavoritesApplicationMessage) {
			await kustoFavoritesApplicationMessage;
			return;
		}
		const sqlDatabaseDiscoveryApplicationMessage = this.sqlDatabaseDiscoveryApplication?.handleMessage(message);
		if (sqlDatabaseDiscoveryApplicationMessage) {
			await sqlDatabaseDiscoveryApplicationMessage;
			return;
		}
		const kqlLanguageRequestApplicationMessage = this.kqlLanguageRequestApplication?.handleMessage(message);
		if (kqlLanguageRequestApplicationMessage) {
			await kqlLanguageRequestApplicationMessage;
			return;
		}
		const sqlLastSelectionApplicationMessage = this.sqlLastSelectionApplication?.handleMessage(message);
		if (sqlLastSelectionApplicationMessage) {
			await sqlLastSelectionApplicationMessage;
			return;
		}
		const copilotInlineCompletionApplicationMessage = this.copilotInlineCompletionApplication?.handleMessage(message);
		if (copilotInlineCompletionApplicationMessage) {
			await copilotInlineCompletionApplicationMessage;
			return;
		}
		switch (message.type) {
			case 'kustoSectionOpen':
				this.kustoExecutionCoordinator.openSection(message.boxId, message.sectionInstanceId);
				return;
			case 'kustoSectionTarget':
				this.kustoExecutionCoordinator.adoptTarget({
					boxId: message.boxId,
					sectionInstanceId: message.sectionInstanceId,
					targetGeneration: message.targetGeneration,
					connectionId: message.connectionId,
					database: message.database,
					connectionRevision: message.connectionRevision,
					connectionIdentityKey: message.connectionIdentityKey,
				});
				return;
			case 'kustoSectionClose':
				this.copilot.cancelKustoCopilotSection(message.boxId, message.sectionInstanceId);
				this.kustoExecutionCoordinator.closeSection(message.boxId, message.sectionInstanceId);
				return;
			case 'kustoExecutionStartedAck': {
				const key = this.kustoExecutionAckKey(message);
				const pending = this.pendingKustoExecutionStartAcks.get(key);
				if (pending) {
					this.pendingKustoExecutionStartAcks.delete(key);
					clearTimeout(pending.timer);
					pending.resolve(message.accepted === true);
				}
				return;
			}
			case 'kustoPublicationAck': {
				const key = `${message.publicationId}:${message.phase}`;
				const pending = this.pendingKustoPublicationAcks.get(key);
				if (pending) {
					this.pendingKustoPublicationAcks.delete(key);
					if (pending.timer) clearTimeout(pending.timer);
					pending.resolve(message.accepted === true);
				}
				return;
			}
			case 'sqlComparisonAdmissionAck': {
				const requestId = String(message.requestId || '').trim();
				const comparisonBoxId = String(message.comparisonBoxId || '').trim();
				const pending = requestId ? this.pendingComparisonEnsureByRequestId.get(requestId) : undefined;
				const admissionAck = pending?.sqlAdmissionAck;
				if (!pending || !admissionAck
					|| comparisonBoxId !== admissionAck.comparisonBoxId
					|| message.phase !== admissionAck.phase
					|| String(message.sourceBoxId || '').trim() !== pending.sourceBoxId) return;
				admissionAck.resolve(message.accepted === true);
				return;
			}
			case 'comparisonBoxEnsured':
				try {
					const requestId = String(message.requestId || '');
					const comparisonBoxId = String(message.comparisonBoxId || '');
					const pending = requestId ? this.pendingComparisonEnsureByRequestId.get(requestId) : undefined;
					if (!pending) {
						if (message.engine === 'sql' && requestId && comparisonBoxId) {
							void this.postMessage({
								type: 'sqlComparisonAdmissionRollback', requestId,
								sourceBoxId: String(message.sourceBoxId || ''), comparisonBoxId,
							});
						}
						return;
					}
					if (pending) {
						if (pending.sqlConnectionId && comparisonBoxId) pending.comparisonBoxId = comparisonBoxId;
						if (pending.kustoRequest && (!hasKustoCopilotRequestIdentity(message)
							|| !kustoCopilotRequestIdentityEquals(pending.kustoRequest, message))) return;
						if (pending.sqlConnectionId && (
							String(message.sourceSectionInstanceId || '') !== pending.sqlSourceSectionInstanceId
							|| Number(message.sourceTargetGeneration) !== pending.sqlSourceTargetGeneration
							|| this.sqlLifecycle.getSectionInstanceId(pending.sourceBoxId) !== pending.sqlSourceSectionInstanceId
							|| this.sqlLifecycle.getGeneration(pending.sourceBoxId) !== pending.sqlSourceTargetGeneration
							|| this.sqlLifecycle.getConnectionId(pending.sourceBoxId) !== pending.sqlConnectionId
						)) {
							this.settlePendingComparisonEnsure(requestId, pending, {
								error: new Error('SQL comparison source changed before preparation completed.'),
							});
							return;
						}
						if (!comparisonBoxId) {
							this.settlePendingComparisonEnsure(requestId, pending, {
								error: new Error('Comparison source was missing, stale, or unavailable.'),
							});
							return;
						}
						if (pending.sqlConnectionId) {
							const comparisonSectionInstanceId = String(message.comparisonSectionInstanceId || '').trim();
							const comparisonTargetGeneration = Number(message.comparisonTargetGeneration);
							const comparisonConnectionId = String(message.comparisonConnectionId || '').trim();
							const comparisonDatabase = String(message.comparisonDatabase || '').trim();
							const comparisonTarget = this.sqlLifecycle.getTarget(comparisonBoxId);
							if (comparisonBoxId === pending.sourceBoxId
								|| !comparisonSectionInstanceId || !Number.isSafeInteger(comparisonTargetGeneration)
								|| comparisonConnectionId !== pending.sqlConnectionId
								|| comparisonDatabase.toLowerCase() !== String(pending.sqlSourceDatabase || '').toLowerCase()
								|| !this.sqlLifecycle.isSectionCurrent(comparisonBoxId, comparisonSectionInstanceId)
								|| this.sqlLifecycle.getGeneration(comparisonBoxId) !== comparisonTargetGeneration
								|| comparisonTarget?.connectionId !== pending.sqlConnectionId
								|| String(comparisonTarget?.database || '').toLowerCase()
									!== String(pending.sqlSourceDatabase || '').toLowerCase()) {
								this.settlePendingComparisonEnsure(requestId, pending, {
									error: new Error('SQL comparison target was missing, stale, self-referential, or mismatched.'),
								});
								return;
							}
						}
						pending.comparisonBoxId = comparisonBoxId;
						if (comparisonBoxId && !pending.sqlConnectionId) {
							this._comparisonOwnerByBoxId.set(comparisonBoxId, {
								sourceBoxId: pending.sourceBoxId,
								...(pending.copilotSequence !== undefined ? { copilotSequence: pending.copilotSequence } : {}),
								comparisonRequestId: requestId,
							});
						}
						if (pending.sqlConnectionId && comparisonBoxId) {
							const provisionalOwner = {
								sourceBoxId: pending.sourceBoxId,
								connectionId: pending.sqlConnectionId,
								...(pending.copilotSequence !== undefined ? { copilotSequence: pending.copilotSequence } : {}),
								comparisonRequestId: requestId,
							};
							pending.previousSqlComparisonOwner = this.sqlLifecycle.getComparisonOwner(comparisonBoxId);
							pending.previousSqlComparisonOwnerCaptured = true;
							pending.provisionalSqlComparisonOwner = provisionalOwner;
							try {
								await this.sqlWorkbench.assertSqlConnectionAllowed(pending.sqlConnectionId);
								const currentPending = this.pendingComparisonEnsureByRequestId.get(requestId);
								const currentOwner = this.sqlLifecycle.getComparisonOwner(comparisonBoxId);
								const currentSourceTarget = this.sqlLifecycle.getTarget(pending.sourceBoxId);
								const currentComparisonTarget = this.sqlLifecycle.getTarget(comparisonBoxId);
								const identityStillCurrent = currentSourceTarget?.connectionId === pending.sqlConnectionId
									&& String(currentSourceTarget.database || '').toLowerCase()
										=== String(pending.sqlSourceDatabase || '').toLowerCase()
									&& currentSourceTarget.generation === pending.sqlSourceTargetGeneration
									&& this.sqlLifecycle.getSectionInstanceId(pending.sourceBoxId) === pending.sqlSourceSectionInstanceId
									&& currentComparisonTarget?.connectionId === pending.sqlConnectionId
									&& String(currentComparisonTarget.database || '').toLowerCase()
										=== String(pending.sqlSourceDatabase || '').toLowerCase()
									&& currentComparisonTarget.generation === Number(message.comparisonTargetGeneration)
									&& this.sqlLifecycle.getSectionInstanceId(comparisonBoxId)
										=== String(message.comparisonSectionInstanceId || '');
								if (currentPending !== pending || currentOwner !== pending.previousSqlComparisonOwner
									|| !identityStillCurrent) {
									if (currentPending === pending) {
										this.settlePendingComparisonEnsure(requestId, pending, {
											error: new Error('SQL comparison source or target changed during policy admission.'),
										});
									}
									return;
								}
							} catch (error) {
								const currentPending = this.pendingComparisonEnsureByRequestId.get(requestId);
								if (currentPending !== pending
									|| this.sqlLifecycle.getComparisonOwner(comparisonBoxId) !== pending.previousSqlComparisonOwner) {
									if (currentPending === pending) {
										this.settlePendingComparisonEnsure(requestId, pending, { error: new Error('Canceled') });
									}
									return;
								}
								this.postMessage({ type: 'sqlCopilotPolicyChanged', boxIds: [pending.sourceBoxId, comparisonBoxId] });
								this.settlePendingComparisonEnsure(requestId, pending, {
									error: error instanceof Error ? error : new Error(String(error)),
								});
								return;
							}
						}
						if (!pending.sqlConnectionId) {
							const target = message.kustoTarget;
							if (!target || target.boxId !== comparisonBoxId
								|| !this.kustoExecutionCoordinator.openSection(target.boxId, target.sectionInstanceId)
								|| !this.kustoExecutionCoordinator.adoptTarget(target)) {
								this.settlePendingComparisonEnsure(requestId, pending, { error: new Error('Comparison target was not ready.') });
								return;
							}
						}
						if (pending.sqlConnectionId) {
							const admitted = await this.waitForSqlComparisonAdmission(requestId, pending, comparisonBoxId, 'staged');
							if (!admitted) {
								if (this.pendingComparisonEnsureByRequestId.get(requestId) === pending) {
									this.settlePendingComparisonEnsure(requestId, pending, {
										error: new Error('SQL comparison admission was not applied by the editor.'),
									});
								}
								return;
							}
							const committed = await this.waitForSqlComparisonAdmission(requestId, pending, comparisonBoxId, 'committed');
							if (!committed || this.pendingComparisonEnsureByRequestId.get(requestId) !== pending) {
								if (this.pendingComparisonEnsureByRequestId.get(requestId) === pending) {
									this.settlePendingComparisonEnsure(requestId, pending, {
										error: new Error('SQL comparison commit was not applied by the editor.'),
									});
								}
								return;
							}
							if (this.sqlLifecycle.getComparisonOwner(comparisonBoxId) !== pending.previousSqlComparisonOwner
								|| !pending.provisionalSqlComparisonOwner) {
								this.settlePendingComparisonEnsure(requestId, pending, {
									error: new Error('SQL comparison ownership changed before commit completed.'),
								});
								return;
							}
							const finalized = await this.waitForSqlComparisonAdmission(requestId, pending, comparisonBoxId, 'finalized');
							if (!finalized || this.pendingComparisonEnsureByRequestId.get(requestId) !== pending) {
								if (this.pendingComparisonEnsureByRequestId.get(requestId) === pending) {
									this.settlePendingComparisonEnsure(requestId, pending, {
										error: new Error('SQL comparison final validation was not applied by the editor.'),
									});
								}
								return;
							}
							if (this.sqlLifecycle.getComparisonOwner(comparisonBoxId) !== pending.previousSqlComparisonOwner) {
								this.settlePendingComparisonEnsure(requestId, pending, {
									error: new Error('SQL comparison ownership changed before final validation completed.'),
								});
								return;
							}
							pending.completionStarted = true;
							try { clearTimeout(pending.timer); } catch { /* ignore */ }
							try { pending.cancellationDisposable?.dispose(); } catch { /* ignore */ }
							pending.cancellationDisposable = undefined;
							let completed = false;
							while (!completed && !this._panelDisposed
								&& this.pendingComparisonEnsureByRequestId.get(requestId) === pending) {
								completed = await this.waitForSqlComparisonAdmission(
									requestId, pending, comparisonBoxId, 'completed',
								);
								if (!completed && !this._panelDisposed
									&& this.pendingComparisonEnsureByRequestId.get(requestId) === pending) {
									await new Promise<void>(resolve => setTimeout(resolve, 100));
								}
							}
							if (!completed || this.pendingComparisonEnsureByRequestId.get(requestId) !== pending) {
								return;
							}
							const currentSourceTarget = this.sqlLifecycle.getTarget(pending.sourceBoxId);
							const currentComparisonTarget = this.sqlLifecycle.getTarget(comparisonBoxId);
							const identitiesRemainCurrent = currentSourceTarget?.connectionId === pending.sqlConnectionId
								&& String(currentSourceTarget.database || '').toLowerCase()
									=== String(pending.sqlSourceDatabase || '').toLowerCase()
								&& currentSourceTarget.generation === pending.sqlSourceTargetGeneration
								&& this.sqlLifecycle.getSectionInstanceId(pending.sourceBoxId) === pending.sqlSourceSectionInstanceId
								&& currentComparisonTarget?.connectionId === pending.sqlConnectionId
								&& String(currentComparisonTarget.database || '').toLowerCase()
									=== String(pending.sqlSourceDatabase || '').toLowerCase()
								&& currentComparisonTarget.generation === Number(message.comparisonTargetGeneration)
								&& this.sqlLifecycle.getSectionInstanceId(comparisonBoxId)
									=== String(message.comparisonSectionInstanceId || '');
							if (!identitiesRemainCurrent
								|| this.sqlLifecycle.getComparisonOwner(comparisonBoxId) !== pending.previousSqlComparisonOwner) {
								this.settlePendingComparisonEnsure(requestId, pending, {
									error: new Error('SQL comparison target changed after completion.'),
								}, { rollbackConfirmed: true });
								return;
							}
							this.sqlLifecycle.setComparisonOwner(comparisonBoxId, pending.provisionalSqlComparisonOwner);
							void this.postMessage({
								type: 'sqlComparisonAdmissionRelease', outcome: 'completed', requestId,
								sourceBoxId: pending.sourceBoxId, comparisonBoxId,
							});
						}
						this.settlePendingComparisonEnsure(requestId, pending, {
							comparison: { boxId: comparisonBoxId, ...(message.kustoTarget ? { kustoTarget: message.kustoTarget } : {}) },
						});
					}
				} catch {
					// ignore
				}
				return;
			case 'comparisonSummary':
				try {
					const sourceBoxId = String(message.sourceBoxId || '');
					const comparisonBoxId = String(message.comparisonBoxId || '');
					if (!sourceBoxId || !comparisonBoxId) {
						return;
					}
					const key = `${sourceBoxId}::${comparisonBoxId}`;
					const summary = {
						dataMatches: !!message.dataMatches,
						headersMatch: message.headersMatch === null || message.headersMatch === undefined ? true : !!message.headersMatch
					};
					this.latestComparisonSummaryByKey.set(key, { ...summary, timestamp: Date.now() });
					const pending = this.pendingComparisonSummaryByKey.get(key);
					if (pending && pending.length) {
						this.pendingComparisonSummaryByKey.delete(key);
						for (const w of pending) {
							try {
								clearTimeout(w.timer);
							} catch {
								// ignore
							}
							try {
								w.resolve(summary);
							} catch {
								// ignore
							}
						}
					}
				} catch {
					// ignore
				}
				return;
			case 'getConnections':
				await this.sendConnectionsData(message.policyRequestId);
				return;
			case 'getDatabases':
				await this.connection.sendDatabases(message.connectionId, message.boxId, {
					mode: 'passive',
					requestToken: message.requestToken,
					requiredDatabase: message.requiredDatabase,
					sectionInstanceId: message.sectionInstanceId,
					targetGeneration: message.targetGeneration,
				});
				return;
			case 'refreshDatabases':
				await this.connection.sendDatabases(message.connectionId, message.boxId, {
					mode: 'interactive-refresh',
					requestToken: message.requestToken,
					requiredDatabase: message.requiredDatabase,
					sectionInstanceId: message.sectionInstanceId,
					targetGeneration: message.targetGeneration,
				});
				return;
			case 'saveLastSelection':
				{
					const cid = String(message.connectionId || '').trim();
					if (!cid) {
						return;
					}
					await this.connection.saveLastSelection(cid, message.database);
				}
				try {
					await vscode.commands.executeCommand('kusto.refreshTextEditorDiagnostics');
				} catch {
					// ignore
				}
				return;
			case 'checkCopilotAvailability':
				await this.copilot.checkCopilotAvailability(message.boxId);
				return;
			case 'prepareCopilotWriteQuery':
				await this.copilot.prepareCopilotWriteQuery(message);
				return;
			case 'startCopilotWriteQuery':
				if (message.flavor === 'sql') {
					const preflight = this.sqlExecutionBroker.reservePreflight(
						message.boxId, SQL_COPILOT_PREFLIGHT_EXECUTION_ID, message.sqlOwnerToken,
					);
					try { await this.assertSqlOwnerToken(message.boxId, message.sqlOwnerToken); }
					catch {
						if (this.sqlExecutionBroker.clearPreflight(preflight)) {
							this.postMessage({
								type: 'copilotWriteQueryDone', boxId: message.boxId, ok: false,
								message: SQL_COPILOT_OWNER_CHANGED_MESSAGE, ownerToken: String(message.sqlOwnerToken || ''),
							});
						}
						return;
					}
					if (!this.sqlExecutionBroker.clearPreflight(preflight)) return;
					await this.copilot.startCopilotWriteQuery(message, this.sqlConnectionManager, this.sqlSchemaService, this.sqlClient);
					return;
				}
				await this.copilot.startCopilotWriteQuery(message, this.sqlConnectionManager, this.sqlSchemaService, this.sqlClient);
				return;
			case 'cancelCopilotWriteQuery':
				if (message.flavor === 'kusto') {
					this.copilot.cancelCopilotWriteQuery(message.boxId, undefined, {
						boxId: message.boxId,
						copilotRequestId: message.copilotRequestId,
						sectionInstanceId: message.sectionInstanceId,
						targetGeneration: message.targetGeneration,
					});
					return;
				}
				{
					const canceledPreflight = this.sqlExecutionBroker.cancelExpected(
						message.boxId, SQL_COPILOT_PREFLIGHT_EXECUTION_ID, false,
					);
					if (canceledPreflight) {
						const ownerToken = this.sqlLifecycle.getOwnerToken(message.boxId);
						this.postMessage({ type: 'copilotWriteQueryDone', boxId: message.boxId, ok: false, message: 'Canceled.', ...(ownerToken ? { ownerToken } : {}) });
					}
				}
				this.copilot.cancelCopilotWriteQuery(message.boxId);
				return;
			case 'clearCopilotConversation':
				if (message.flavor === 'kusto') {
					if (hasKustoCopilotRequestIdentity(message)) this.copilot.clearKustoCopilotConversation(message);
				} else {
					this.copilot.clearCopilotConversation(message.boxId);
				}
				return;
			case 'clearComparisonSummary':
				this.deleteComparisonSummary(`${String(message.sourceBoxId || '')}::${String(message.comparisonBoxId || '')}`);
				return;
			case 'copilotChatFirstTimeCheck':
				await this.copilot.handleCopilotChatFirstTimeCheck(message.boxId);
				return;
			case 'removeFromCopilotHistory':
				this.copilot.removeFromCopilotHistory(message.boxId, message.entryId);
				return;
			case 'prepareOptimizeQuery':
				await this.copilot.prepareOptimizeQuery(message);
				return;
			case 'cancelOptimizeQuery':
				this.copilot.cancelOptimizeQuery(message);
				return;
			case 'optimizeQuery':
				await this.copilot.optimizeQueryWithCopilot(message);
				return;
			case 'executeQuery':
				await this.executeQueryFromWebview(message);
				return;
			case 'getSqlConnections':
				await this.sendSqlConnectionsData();
				return;
			case 'sqlSectionOpen':
				this.sqlLifecycle.openSection(message.boxId, message.sectionInstanceId);
				return;
			case 'retireSqlTarget':
				this.sqlLifecycle.retireTarget(message.boxId, message.sectionInstanceId, message.targetGeneration);
				return;
			case 'testSetSqlAuthOverride':
				if (this.context.extensionMode === vscode.ExtensionMode.Production) {
					return;
				}
				await setSqlServerAccountMapEntry(this.context, message.serverUrl, message.accountId);
				await setSqlTokenOverride(this.context, message.accountId, message.token);
				return;
			case 'testClearSqlAuthOverride':
				if (this.context.extensionMode === vscode.ExtensionMode.Production) {
					return;
				}
				await clearSqlTokenOverride(this.context, message.accountId);
				return;
			case 'executeSqlQuery':
				await this.executeSqlQueryFromWebview(message);
				return;
			case 'cancelSqlQuery':
				if (!this.sqlLifecycle.isSectionCurrent(message.boxId, message.sectionInstanceId)) return;
				this.sqlExecutionBroker.cancelExpected(message.boxId, message.executionId, true);
				return;
			case 'prefetchSqlSchema':
				if (!this.sqlLifecycle.adoptTarget(
					message.boxId, message.sectionInstanceId, message.sqlConnectionId, message.database, message.targetGeneration,
				)) return;
				await this.prefetchSqlSchema(message.sqlConnectionId, message.database, message.boxId, !!message.forceRefresh);
				return;
			case 'stsRequest':
				await this.sqlLifecycle.handleLanguageRequest(message.requestId, message.method, message.params);
				return;
			case 'stsDidOpen':
				this.sqlLifecycle.didOpen(message.boxId, message.sectionInstanceId, message.text);
				return;
			case 'stsDidChange':
				await this.sqlLifecycle.didChange(message.boxId, message.sectionInstanceId, message.text);
				return;
			case 'stsDidClose':
				this.sqlLifecycle.didClose(message.boxId, message.sectionInstanceId);
				return;
			case 'sqlComparisonRemoved': {
				const comparisonBoxId = String(message.boxId || '').trim();
				if (!comparisonBoxId) return;
				const pendingEntry = [...this.pendingComparisonEnsureByRequestId]
					.find(([, pending]) => pending.comparisonBoxId === comparisonBoxId);
				const pendingOwner = this.sqlLifecycle.getComparisonOwner(comparisonBoxId);
				const pendingProposalOwner = pendingEntry?.[1].provisionalSqlComparisonOwner;
				if (pendingEntry) {
					this.settlePendingComparisonEnsure(pendingEntry[0], pendingEntry[1], { error: new Error('Canceled') });
				}
				const sqlOwner = this.sqlLifecycle.getComparisonOwner(comparisonBoxId);
				const owner = sqlOwner ?? pendingOwner ?? pendingProposalOwner ?? this._comparisonOwnerByBoxId.get(comparisonBoxId);
				if (!owner) return;
				if (sqlOwner) {
					this.sqlExecutionBroker.supersede(comparisonBoxId, { notifyWebview: true });
					this.sqlLifecycle.removeComparisonOwner(comparisonBoxId);
				} else {
					this._comparisonOwnerByBoxId.delete(comparisonBoxId);
				}
				this.deleteComparisonSummary(`${owner.sourceBoxId}::${comparisonBoxId}`);
				if (owner.comparisonRequestId) {
					const pending = this.pendingComparisonEnsureByRequestId.get(owner.comparisonRequestId);
					if (pending) {
						this.settlePendingComparisonEnsure(owner.comparisonRequestId, pending, { error: new Error('Canceled') });
					}
				}
				if (!sqlOwner) {
					const active = this.kustoExecutionCoordinator.getActive(comparisonBoxId);
					if (active) this.kustoExecutionCoordinator.cancelExpected(active);
				}
				if (owner.copilotSequence !== undefined) {
					this.copilot.cancelCopilotQueryTarget(owner.sourceBoxId, comparisonBoxId, owner.copilotSequence);
				}
				const messageSourceBoxId = String(message.sourceBoxId || '').trim();
				if (messageSourceBoxId !== owner.sourceBoxId) return;
				if (owner.copilotSequence !== undefined) {
					this.copilot.cancelCopilotWriteQuery(owner.sourceBoxId, owner.copilotSequence);
				}
				return;
			}
			case 'stsConnect':
				await this.sqlLifecycle.connect(
					message.boxId, message.sectionInstanceId, message.sqlConnectionId, message.database,
					message.targetGeneration, message.expectedOwner,
				);
				return;
			case 'cancelQuery':
				this.kustoExecutionCoordinator.cancelExpected({
					boxId: message.boxId,
					executionId: message.executionId,
					sectionInstanceId: message.sectionInstanceId,
					targetGeneration: message.targetGeneration,
				});
				return;
			case 'prefetchSchema':
				await this.schema.prefetchSchema(message.connectionId, message.database, message.boxId, !!message.forceRefresh, message.requestToken, {
					cacheOnly: !!message.cacheOnly,
					silent: !!message.silent,
					reason: message.reason,
				}, message.sectionInstanceId !== undefined && message.targetGeneration !== undefined ? {
					sectionInstanceId: message.sectionInstanceId,
					targetGeneration: message.targetGeneration,
				} : undefined);
				return;
			case 'requestCrossClusterSchema':
				await this.schema.handleCrossClusterSchemaRequest(message.clusterName, message.database, message.boxId, message.requestToken, message.requestSource, message.traceId);
				return;
			case 'toolExecutionStarted':
				if (toolOrchestrator) toolOrchestrator.handleKustoExecutionStarted(message.requestId, message.owner);
				return;
			case 'toolResponse':
				// Handle response from webview for tool orchestrator commands
				if (this.developmentNoteMutationApplication.handleMessage(message)) return;
				if (toolOrchestrator && message.requestId) {
					toolOrchestrator.handleWebviewResponse(message.requestId, message.result, message.error);
				}
				return;
			case 'toolStateResponse':
				// Handle state response from webview
				{
					const resolver = this.toolStateResponseResolvers.get(message.requestId);
					if (resolver) {
						resolver(message.error ? undefined : message.sections);
					}
				}
				return;
			default:
				return;
		}
	}

	async ensureComparisonBoxInWebview(
		sourceBoxId: string,
		comparisonQuery: string,
		token: vscode.CancellationToken,
		copilotSequence?: number,
		kustoRequest?: KustoCopilotRequestIdentity,
	): Promise<PreparedComparisonSection> {
		if (!this.panel) {
			throw new Error('Webview panel is not available');
		}
		const requestId = crypto.randomUUID();
		const sqlConnectionId = this.sqlLifecycle.getConnectionId(sourceBoxId);
		const sqlSourceSectionInstanceId = sqlConnectionId
			? String(this.sqlLifecycle.getSectionInstanceId(sourceBoxId) || '').trim()
			: '';
		const sqlSourceTargetGeneration = sqlConnectionId
			? this.sqlLifecycle.getGeneration(sourceBoxId)
			: undefined;
		const sqlSourceDatabase = sqlConnectionId
			? String(this.sqlLifecycle.getTarget(sourceBoxId)?.database || '').trim()
			: '';
		if (sqlConnectionId && this.sqlLifecycle.getComparisonOwner(sourceBoxId)) {
			throw new Error('A derived SQL comparison cannot be used as another comparison source.');
		}
		if (sqlConnectionId && (!sqlSourceSectionInstanceId || !Number.isSafeInteger(sqlSourceTargetGeneration)
			|| !sqlSourceDatabase)) {
			throw new Error('SQL comparison source lifecycle identity is unavailable.');
		}
		if (sqlConnectionId) await this.sqlWorkbench.assertSqlConnectionAllowed(sqlConnectionId);
		return await new Promise<PreparedComparisonSection>((resolve, reject) => {
			if (token.isCancellationRequested) {
				reject(new Error('Canceled'));
				return;
			}

			let pending!: PendingComparisonEnsure;
			const timer = setTimeout(() => {
				this.settlePendingComparisonEnsure(requestId, pending, { error: new Error('Timed out while preparing comparison editor') });
			}, 20000);

			pending = {
				resolve,
				reject,
				timer,
				sourceBoxId,
				...(sqlConnectionId ? { sqlConnectionId } : {}),
				...(sqlSourceSectionInstanceId ? { sqlSourceSectionInstanceId } : {}),
				...(sqlSourceTargetGeneration !== undefined ? { sqlSourceTargetGeneration } : {}),
				...(sqlSourceDatabase ? { sqlSourceDatabase } : {}),
				...(copilotSequence !== undefined ? { copilotSequence } : {}),
				...(kustoRequest ? { kustoRequest } : {}),
			};
			this.pendingComparisonEnsureByRequestId.set(requestId, pending);

			try {
				this.postMessage({
					type: 'ensureComparisonBox',
					requestId,
					boxId: sourceBoxId,
					query: comparisonQuery,
					engine: sqlConnectionId ? 'sql' : 'kusto',
					...(sqlSourceSectionInstanceId ? {
						sourceSectionInstanceId: sqlSourceSectionInstanceId,
						sourceTargetGeneration: sqlSourceTargetGeneration,
					} : {}),
					...(kustoRequest || {}),
				});
			} catch (e) {
				try {
					clearTimeout(timer);
				} catch {
					// ignore
				}
				this.pendingComparisonEnsureByRequestId.delete(requestId);
				try { pending.cancellationDisposable?.dispose(); } catch { /* ignore */ }
				reject(e instanceof Error ? e : new Error(String(e)));
				return;
			}

			try {
				pending.cancellationDisposable = token.onCancellationRequested(() => {
					const pending = this.pendingComparisonEnsureByRequestId.get(requestId);
					if (!pending) {
						return;
					}
					this.settlePendingComparisonEnsure(requestId, pending, { error: new Error('Canceled') });
				});
			} catch {
				// ignore
			}
		});
	}

	async waitForComparisonSummary(
		sourceBoxId: string,
		comparisonBoxId: string,
		token: vscode.CancellationToken
	): Promise<{ dataMatches: boolean; headersMatch: boolean }> {
		const key = `${sourceBoxId}::${comparisonBoxId}`;
		const existing = this.latestComparisonSummaryByKey.get(key);
		if (existing) {
			return { dataMatches: existing.dataMatches, headersMatch: existing.headersMatch };
		}

		return await new Promise<{ dataMatches: boolean; headersMatch: boolean }>((resolve, reject) => {
			if (token.isCancellationRequested) {
				reject(new Error('Canceled'));
				return;
			}

			const timer = setTimeout(() => {
				try {
					const pending = this.pendingComparisonSummaryByKey.get(key) || [];
					this.pendingComparisonSummaryByKey.set(
						key,
						pending.filter((p) => p.reject !== reject)
					);
					if ((this.pendingComparisonSummaryByKey.get(key) || []).length === 0) {
						this.pendingComparisonSummaryByKey.delete(key);
					}
				} catch {
					// ignore
				}
				reject(new Error('Timed out while waiting for comparison summary'));
			}, 20000);

			const entry = { resolve, reject, timer };
			const pending = this.pendingComparisonSummaryByKey.get(key) || [];
			pending.push(entry);
			this.pendingComparisonSummaryByKey.set(key, pending);

			try {
				token.onCancellationRequested(() => {
					try {
						clearTimeout(timer);
					} catch {
						// ignore
					}
					reject(new Error('Canceled'));
				});
			} catch {
				// ignore
			}
		});
	}


	normalizeClusterUrlKey(url: string): string {
		return kustoClusterKey(url);
	}

	// ── Delegating wrappers for ConnectionService methods ──
	// These keep the public API stable for external callers and CopilotServiceHost.

	findConnection(connectionId: string): KustoConnection | undefined {
		return this.connection.findConnection(connectionId);
	}

	public async refreshConnectionsData(): Promise<void> {
		await this.sendConnectionsData();
	}

	public async refreshSqlConnectionsData(): Promise<void> {
		await this.sendSqlConnectionsData();
	}

	private async postSqlOwnerMessageAllowed(
		boxId: string,
		expectedOwner: SqlResultOwner,
		message: Record<string, unknown>,
		isCurrent: () => boolean = () => true,
	): Promise<void> {
		await this.dispatchSqlResultOwnerAllowed(boxId, expectedOwner, () => {
			if (isCurrent()) this.postMessage(message);
		});
	}

	private async postSqlOwnerMessageProtection(
		boxId: string,
		expectedOwner: SqlResultOwner,
		expectedProtected: boolean,
		message: Record<string, unknown>,
		isCurrent: () => boolean = () => true,
	): Promise<void> {
		await this.sqlLifecycle.dispatchResultOwnerProtection(boxId, expectedOwner, expectedProtected, () => {
			if (isCurrent()) this.postMessage(message);
		});
	}

	public async inferClusterDatabaseForKqlQuery(
		queryText: string
	): Promise<{ clusterUrl: string; database: string; authorityId?: string; connectionIdHint: string } | undefined> {
		return this.connection.inferClusterDatabaseForKqlQuery(queryText);
	}

	public getKustoFavorites() {
		return this.kustoFavoritesApplication.getFavorites();
	}

	private async sendConnectionsData(policyRequestId?: string): Promise<void> {
		const revision = ++this.connectionsDataRevision;
		const send = async () => {
			const { type: _type, revision: editingPreferencesRevision, ...editingPreferences } = getEditingPreferencesData(this.context);
			await this.connection.sendConnectionsData({
				...editingPreferences,
				editingPreferencesRevision,
				connectionsRevision: revision,
				copilotChatFirstTimeDismissed: !!this.context.globalState.get<boolean>(STORAGE_KEYS.copilotChatFirstTimeDismissed),
				...(policyRequestId ? { policyRequestId } : {}),
			});
		};
		this.connectionsDataTail = this.connectionsDataTail.then(send, send);
		await this.connectionsDataTail;
	}

	deleteComparisonSummary(key: string): void {
		this.latestComparisonSummaryByKey.delete(key);
	}

	revealPanel(): void {
		this.panel?.reveal(vscode.ViewColumn.One);
	}


	private cancelAllRunningQueries(): void {
		this.queryRuns.cancelAll();
	}

	postMessage(message: unknown): Thenable<boolean> {
		if (this._panelDisposed) return Promise.resolve(false);
		try {
			const panel = this.panel;
			if (!panel) return Promise.resolve(false);
			const delivery = panel.webview.postMessage(message);
			return Promise.resolve(delivery).catch(error => {
				if (!this._panelDisposed) {
					this.output.warn(`[webview] postMessage failed: ${sanitizeStsLogText(error instanceof Error ? error.message : error)}`);
				}
				return false;
			});
		} catch (error) {
			if (!this._panelDisposed) {
				this.output.warn(`[webview] postMessage failed: ${sanitizeStsLogText(error instanceof Error ? error.message : error)}`);
			}
			return Promise.resolve(false);
		}
	}

	private registerPanelDisposal(panel: vscode.WebviewPanel): void {
		panel.onDidDispose(() => {
			if (this.panel !== panel) return;
			this._panelDisposed = true;
			QueryEditorProvider.activeProviders.delete(this);
			this.rejectPendingKustoExecutionStartAcks();
			for (const [publicationId, pending] of [...this.pendingKustoPublicationAcks]) {
				this.pendingKustoPublicationAcks.delete(publicationId);
				if (pending.timer) clearTimeout(pending.timer);
				pending.resolve(false);
			}
			this.dashboardApplication.dispose();
			this.artifactCsvSaveApplication.dispose();
			this.pythonExecutionApplication.dispose();
			this.importedCsvSaveApplication.dispose();
			this.querySharingApplication.dispose();
			this.urlContentApplication.dispose();
			this.controlCommandSyntaxApplication.dispose();
			this.resourceUriApplication.dispose();
			this.copilotContentOpenApplication.dispose();
			this.informationNotificationApplication.dispose();
			this.cachedValuesOpenApplication.dispose();
			this.copilotAgentOpenApplication.dispose();
			for (const [requestId, pending] of [...this.pendingComparisonEnsureByRequestId]) {
				this.settlePendingComparisonEnsure(requestId, pending, { error: new Error('Canceled') });
			}
			this.developmentNoteMutationApplication.dispose();
			this.copilotInlineCompletionApplication.dispose();
			this.copilot.disposeKustoOwners();
			this.copilot.invalidateSqlConnections(
				[], [...this.sqlLifecycle.listComparisonBoxIds()],
			);
			this.sqlLifecycle.disposeSubscriptions();
			this.sqlPersistenceInvalidationEmitter.dispose();
			this.kustoPersistenceInvalidationEmitter.dispose();
			this.fileOpenTrace?.mark('queryEditorProvider.dispose.start');
			this.sqlLifecycle.dispose();
			this._comparisonOwnerByBoxId.clear();
			this.editorCursorStatusApplication.dispose();
			this.editingPreferencesApplication.dispose();
			this.kustoConnectionIntakeApplication.dispose();
			this.kustoConnectionOnboardingApplication.dispose();
			this.sqlConnectionOnboardingApplication.dispose();
			this.sqlFavoritesApplication.dispose();
			this.kustoFavoritesApplication.dispose();
			this.sqlDatabaseDiscoveryApplication.dispose();
			this.kqlLanguageRequestApplication.dispose();
			this.sqlLastSelectionApplication.dispose();
			this.kustoExecutionCoordinator.dispose();
			this.cancelAllRunningQueries();
			this.kustoClient.dispose();
			this.disconnectToolOrchestrator();
			this.embeddedTutorialRegistration?.dispose();
			this.embeddedTutorialRegistration = undefined;
			this.embeddedTutorialHost = undefined;
			this.configSubscription?.dispose();
			this.configSubscription = undefined;
			this.authPreferenceSubscription?.dispose();
			this.authPreferenceSubscription = undefined;
			this.kustoConnectionLifecycle.dispose();
			this.panel = undefined;
		});
	}

	// ── Alternating row color setting ──────────────────────────────────────────

	private sendWorkbenchSettings(): void {
		const configuration = vscode.workspace.getConfiguration('kustoWorkbench');
		const alternatingRowColor = configuration.get<string>('alternatingRowColor', 'theme');
		const htmlPowerBiCompatibilityCheckEnabled = configuration.get<boolean>('html.powerBiCompatibilityCheck.enabled', true);
		this.postMessage({ type: 'settingsUpdate', alternatingRowColor, htmlPowerBiCompatibilityCheckEnabled });
	}

	private watchWorkbenchSettings(): void {
		this.configSubscription?.dispose();
		this.configSubscription = vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration('kustoWorkbench.alternatingRowColor') || e.affectsConfiguration('kustoWorkbench.html.powerBiCompatibilityCheck.enabled')) {
				this.sendWorkbenchSettings();
			}
		});
	}

	// ── Schema cache wrappers for CopilotServiceHost / ConnectionServiceHost ──

	async getCachedSchemaFromDisk(cacheKey: string): Promise<CachedSchemaEntry | undefined> {
		return this.schema.getCachedSchemaFromDisk(cacheKey);
	}

	async saveCachedSchemaToDisk(cacheKey: string, entry: CachedSchemaEntry): Promise<void> {
		return this.schema.saveCachedSchemaToDisk(cacheKey, entry);
	}

	private async executeQueryFromWebview(
		message: Extract<IncomingWebviewMessage, { type: 'executeQuery' }>
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

	async executeKustoSectionQuery(options: {
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
	}): Promise<KustoSectionExecutionOutcome<import('./kustoClient').QueryResult>> {
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
		const expectedPredecessorExecutionId = this.kustoExecutionCoordinator.getActive(boxId)?.executionId;
		let reservation;
		try {
			reservation = this.kustoExecutionCoordinator.reserve(request);
		} catch {
			if ((options.preclaimedByWebview || options.producer === 'manual' || options.producer === 'tool')
				&& !this.kustoExecutionCoordinator.hasExactActiveRequest(request)) {
				await this.kustoExecutionCoordinator.rejectPreclaimedRequest(request);
			}
			return { status: 'superseded', executionId: request.executionId };
		}
		if (!options.preclaimedByWebview && (options.producer === 'copilot' || options.producer === 'comparison')
			&& !await this.claimKustoExecutionInWebview(reservation, options.query, expectedPredecessorExecutionId)) {
			this.kustoExecutionCoordinator.cancelExpected(reservation);
			return { status: 'superseded', executionId: request.executionId };
		}
		if (options.persistSelection) {
			try {
				await this.connection.saveLastSelection(target.connectionId, database);
			} catch (error) {
				const userMessage = this.getErrorMessage(error);
				this.kustoExecutionCoordinator.fail(reservation, userMessage);
				return { status: 'failed', executionId: request.executionId, error: userMessage };
			}
		}

		const connection = this.connection.findConnection(target.connectionId);
		if (!connection) {
			this.kustoExecutionCoordinator.fail(reservation, 'Connection not found.');
			if (options.notifyUserOnError) vscode.window.showErrorMessage('Connection not found');
			return { status: 'failed', executionId: request.executionId, error: 'Connection not found.' };
		}

		if (!database) {
			this.kustoExecutionCoordinator.fail(reservation, 'Please select a database.');
			if (options.notifyUserOnError) vscode.window.showErrorMessage('Please select a database');
			return { status: 'failed', executionId: request.executionId, error: 'Please select a database.' };
		}

		const queryWithMode = this.appendQueryMode(options.query, options.queryMode);
		// Control commands (starting with '.') should not have cache directives prepended
		const isControl = this.isControlCommand(options.query);
		const cacheDirective = isControl ? '' : this.buildCacheDirective(options.cacheEnabled, options.cacheValue, options.cacheUnit);
		const finalQuery = cacheDirective ? `${cacheDirective}\n${queryWithMode}` : queryWithMode;
		const executionQuery = this.normalizeControlCommandForExecution(finalQuery);

		const cancelClientKey = boxId ? `${boxId}::${connection.id}` : connection.id;
		let lease: KustoExecutionLease<CancelableQueryExecution> | undefined;
		let pendingDispatch: KustoDispatchIdentity | undefined;
		try {
			lease = this.kustoExecutionCoordinator.start(reservation, () => this.kustoClient.executeQueryCancelable(
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
						if (!lease.captureDispatch(identity)) throw new Error('Kusto execution was superseded before dispatch.');
					},
				},
			));
			if (pendingDispatch && !lease.captureDispatch(pendingDispatch)) {
				throw new Error('Kusto execution was superseded before dispatch.');
			}
			const result = await lease.execution.promise;
			if (!lease.isCurrent()) return { status: 'superseded', executionId: request.executionId };
			await this.kustoClient.waitForProviderAccountRefresh();
			if (!lease.isCurrent()) return { status: 'superseded', executionId: request.executionId };
			await this.refreshConnectionsData();
			const dispatch = lease.getDispatch();
			const producingAccountPartition = dispatch?.accountPartition;
			const currentConnection = dispatch
				? this.getCurrentKustoConnectionForDispatch(connection.id, dispatch)
				: undefined;
			if (lease.isCurrent()
				&& dispatch
				&& currentConnection
				&& producingAccountPartition
				&& this.kustoClient.getConnectionSessionGeneration(connection) === dispatch.authSessionGeneration
				&& this.kustoClient.getAccountPartition(currentConnection) === producingAccountPartition) {
				const admission = await this.connectionManager.admitLeaveNoTraceRevision(
					dispatch.clusterEndpoint,
					dispatch.leaveNoTraceRevision,
					() => {
						const admittedConnection = this.getCurrentKustoConnectionForDispatch(connection.id, dispatch);
						return lease?.isCurrent() === true
							&& !!admittedConnection
							&& this.kustoClient.getConnectionSessionGeneration(connection) === dispatch.authSessionGeneration
							&& this.kustoClient.getAccountPartition(admittedConnection) === producingAccountPartition
							&& this.kustoExecutionCoordinator.succeed(reservation, result, options.ensureResultsVisible === true);
					},
				);
				if (admission.admitted && admission.value === true) {
					return { status: 'success', executionId: request.executionId, result };
				}
			}
			this.kustoExecutionCoordinator.cancelExpected(reservation);
			return { status: 'superseded', executionId: request.executionId };
		} catch (error) {
			if ((error as any)?.name === 'QueryCancelledError' || (error as any)?.isCancelled === true) {
				this.kustoExecutionCoordinator.cancelExpected(reservation);
				return { status: 'cancelled', executionId: request.executionId };
			}
			if (this.kustoExecutionCoordinator.getActive(boxId)?.reservationSequence === reservation.reservationSequence) {
				this.logQueryExecutionError(error, connection, database, boxId, executionQuery);
				const userMessage = this.formatQueryExecutionErrorForUser(error, connection, database);
				const clientActivityId = error instanceof QueryExecutionError ? error.clientActivityId : undefined;
				if (options.notifyUserOnError) vscode.window.showErrorMessage(userMessage);
				this.kustoExecutionCoordinator.fail(reservation, userMessage, clientActivityId);
				return { status: 'failed', executionId: request.executionId, error: userMessage };
			}
			return { status: 'superseded', executionId: request.executionId };
		} finally {
			lease?.release();
		}
	}

	// ── SQL connection helpers ───────────────────────────────────────────────

	private async sendSqlConnectionsData(): Promise<boolean> {
		const publish = () => this.publishSqlConnectionsDataSnapshot();
		const result = this.sqlConnectionsSnapshotTail.then(publish, publish);
		this.sqlConnectionsSnapshotTail = result.catch(() => false);
		return result;
	}

	private async publishSqlConnectionsDataSnapshot(): Promise<boolean> {
		const revision = (this._sqlConnectionsSnapshotRevision ?? 0) + 1;
		this._sqlConnectionsSnapshotRevision = revision;
		const capturedConnections = this.sqlConnectionManager.getConnections();
		const cacheEntries = new Map<string, Awaited<ReturnType<typeof getOwnedSqlDatabaseCacheEntry>>>();
		for (const connection of capturedConnections) {
			cacheEntries.set(connection.id, await getOwnedSqlDatabaseCacheEntry(this.context, SQL_DATABASE_CACHE_STORAGE_KEY, connection));
		}
		const lastSqlConnectionId = this.context.globalState.get<string>('sql.lastConnectionId') || '';
		const lastSqlDatabase = this.context.globalState.get<string>('sql.lastDatabase') || '';
		return this.sqlWorkbench.dispatchSqlOwnerSnapshot(async snapshot => {
			const canonicalProtectedIds = snapshot.policy.globallyBlocked
				? new Set(snapshot.connections.map(connection => connection.id))
				: new Set(snapshot.policy.connectionIds);
			const principalByConnectionId = new Map<string, string>();
			const publishedConnections = snapshot.connections.map(connection => {
				const authType = String(connection.authType || '').trim().toLowerCase();
				const principal = authType === 'aad'
					? snapshot.accountsByServer[normalizeSqlServerUrl(connection.serverUrl)]
					: String(connection.username || '').trim();
				const principalFingerprint = sqlSchemaPrincipalFingerprintForPrincipal(connection, principal);
				if (principalFingerprint) principalByConnectionId.set(connection.id, principalFingerprint);
				const revocationGeneration = snapshot.policy.revocationGenerations[connection.id] ?? 0;
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
			const delivered = await this.postMessage({
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
				sqlFavorites: this.sqlFavoritesApplication.getFavorites()
					.filter(favorite => !canonicalProtectedIds.has(favorite.connectionId)),
				sqlLeaveNoTrace: [...canonicalProtectedIds],
			});
			return delivered === true;
		});
	}

	private async prefetchSqlSchema(sqlConnectionId: string, database: string, boxId: string, forceRefresh: boolean): Promise<void> {
		const connection = this.sqlConnectionManager.getConnection(sqlConnectionId);
		const sectionInstanceId = this.sqlLifecycle.getSectionInstanceId(boxId);
		if (!connection || !database || !sectionInstanceId) {
			return;
		}
		const owner = this.getSqlResultOwner(boxId);
		if (!owner || owner.connectionId !== sqlConnectionId || owner.database !== database) return;
		try {
			this.output.info(`[sql-schema] request forceRefresh=${forceRefresh}`);
			const { schema, fromCache } = await this.sqlSchemaService.getSchema(connection, database, forceRefresh);
			const tablesCount = schema.tables?.length ?? 0;
			let columnsCount = 0;
			if (schema.columnsByTable) {
				for (const tbl of Object.keys(schema.columnsByTable)) {
					columnsCount += Object.keys(schema.columnsByTable[tbl] || {}).length;
				}
			}
			await this.dispatchSqlResultOwnerAllowed(boxId, owner, () => {
				if (!this.sqlLifecycle.isSectionCurrent(boxId, sectionInstanceId)
					|| !this.sqlResultOwnersEqual(this.getSqlResultOwner(boxId), owner)) return;
				this.output.info(`[sql-schema] loaded tables=${tablesCount} columns=${columnsCount} fromCache=${fromCache}`);
				this.postMessage({
					type: 'sqlSchemaData',
					boxId,
					sectionInstanceId,
					sqlConnectionId,
					database,
					targetGeneration: owner.generation,
					serverUrl: connection.serverUrl,
					schema,
					schemaMeta: { fromCache, tablesCount, columnsCount },
				});
			});
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			try {
				await this.dispatchSqlResultOwnerAllowed(boxId, owner, () => {
					if (!this.sqlLifecycle.isSectionCurrent(boxId, sectionInstanceId)
						|| !this.sqlResultOwnersEqual(this.getSqlResultOwner(boxId), owner)) return;
					this.output.error(`[sql-schema] error: ${sanitizeStsLogText(msg)}`);
					this.postMessage({
						type: 'sqlSchemaData',
						boxId,
						sectionInstanceId,
						sqlConnectionId,
						database,
						targetGeneration: owner.generation,
						serverUrl: connection.serverUrl,
						schema: null,
						schemaMeta: { error: true, errorMessage: msg },
					});
				});
			} catch {
				this.output.warn('[sql-schema] Request failed after owner invalidation; details suppressed.');
			}
		}
	}

	public sanitizeSqlLeaveNoTraceState<T extends { sections?: unknown[] }>(state: T): T {
		state = this.stripLegacyResultPayloads(state);
		const sections = Array.isArray(state?.sections) ? state.sections : [];
		this.rebuildSqlComparisonOwners(sections);
		const sectionsById = new Map(
			sections
				.filter((section): section is Record<string, unknown> => !!section && typeof section === 'object')
				.map(section => [String(section.id || '').trim(), section] as const)
				.filter(([id]) => !!id),
		);
		let changed = false;
		const sanitized = sections.map(section => {
			if (!section || typeof section !== 'object') return section;
			const boxId = String((section as any).id || '').trim();
			const sectionType = String((section as any).type || '');
			const persistedSourceBoxId = String((section as any).comparisonSourceBoxId || '').trim();
			const persistedSource = persistedSourceBoxId ? sectionsById.get(persistedSourceBoxId) : undefined;
			if (persistedSourceBoxId && !persistedSource && 'resultJson' in section) {
				changed = true;
				const clone = { ...(section as Record<string, unknown>) };
				delete clone.resultJson;
				delete clone.resultArtifact;
				return clone;
			}
			const derivedOwner = boxId ? this.sqlLifecycle.getComparisonOwner(boxId) : undefined;
			const persistedSqlSource = String((persistedSource as any)?.type || '') === 'sql' ? persistedSource : undefined;
			if (sectionType !== 'sql' && !derivedOwner && !persistedSqlSource) return section;
			const connectionId = derivedOwner?.connectionId ?? (boxId ? this.sqlLifecycle.getConnectionId(boxId) : undefined);
			const sourceConnectionId = persistedSourceBoxId ? this.sqlLifecycle.getConnectionId(persistedSourceBoxId) : undefined;
			const persistedConnectionId = String(
				(persistedSqlSource as any)?.connectionIdHint
				|| (section as any).connectionIdHint
				|| '',
			).trim();
			const persistedTargetSignature = String((persistedSqlSource as any)?.targetSignature || (section as any).targetSignature || '');
			let restoredConnectionId: string | undefined;
			if (persistedConnectionId && persistedTargetSignature) {
				const hintedConnection = this.sqlConnectionManager.getConnection(persistedConnectionId);
				if (hintedConnection && sqlConnectionTargetSignatureMatches(hintedConnection, persistedTargetSignature)) {
					restoredConnectionId = hintedConnection.id;
				}
			}
			const hasPersistedOwner = !!persistedConnectionId || !!persistedTargetSignature;
			const requiresPersistedOwner = sectionType === 'sql' || !!persistedSqlSource;
			const effectiveConnectionId = requiresPersistedOwner || hasPersistedOwner
				? restoredConnectionId
				: connectionId ?? sourceConnectionId;
			const serverUrl = String((persistedSqlSource as any)?.serverUrl || (section as any).serverUrl || '').trim().toLowerCase();
			const protectedByRuntimeOwner = !!effectiveConnectionId && this.sqlWorkbench.isLeaveNoTraceConnection(effectiveConnectionId);
			const protectedByRestoredServer = !effectiveConnectionId && !!serverUrl && this.sqlConnectionManager.getConnections().some(connection =>
				this.sqlWorkbench.isLeaveNoTraceConnection(connection.id)
				&& String(connection.serverUrl || '').trim().toLowerCase() === serverUrl
			);
			const sqlOwnedSection = sectionType === 'sql' || !!derivedOwner || !!persistedSqlSource;
			const unresolvedPersistedOwner = sqlOwnedSection && !effectiveConnectionId;
			if ((!protectedByRuntimeOwner && !protectedByRestoredServer && !unresolvedPersistedOwner) || !('resultJson' in section)) return section;
			changed = true;
			const clone = { ...(section as Record<string, unknown>) };
			delete clone.resultJson;
			delete clone.resultArtifact;
			return clone;
		});
		return this.stripOrphanedSqlPrincipalFingerprints(changed ? { ...state, sections: sanitized } : state);
	}

	private stripLegacyResultPayloads<T extends { sections?: unknown[] }>(state: T): T {
		const sections = Array.isArray(state?.sections) ? state.sections : [];
		let changed = false;
		const sanitized = sections.map(section => {
			if (!section || typeof section !== 'object') return section;
			const record = section as Record<string, unknown>;
			const type = String(record.type || '');
			const canonicalType = canonicalSectionKind(type);
			if ((canonicalType !== 'query' && canonicalType !== 'sql')
				|| !Object.prototype.hasOwnProperty.call(record, 'result')) return section;
			changed = true;
			const clone = { ...record };
			delete clone.result;
			return clone;
		});
		return changed ? { ...state, sections: sanitized } : state;
	}

	private sanitizeKustoLeaveNoTraceStateFromSnapshot<T extends { sections?: unknown[] }>(
		state: T,
		snapshot: KustoLeaveNoTracePolicySnapshot,
	): T {
		const sections = Array.isArray(state?.sections) ? state.sections : [];
		const sectionsById = new Map(sections
			.filter((section): section is Record<string, unknown> => !!section && typeof section === 'object')
			.map(section => [String(section.id || '').trim(), section] as const));
		const protectedClusters = new Set(snapshot.clusterKeys);
		const connections = this.connectionManager.getConnections();
		let changed = false;
		const sanitized = sections.map(section => {
			if (!section || typeof section !== 'object' || !('resultJson' in section)) return section;
			const record = section as Record<string, unknown>;
			if (canonicalSectionKind(record.type) !== 'query') return section;
			const sourceBoxId = String(record.comparisonSourceBoxId || '').trim();
			const source = sourceBoxId ? sectionsById.get(sourceBoxId) : undefined;
			if (sourceBoxId && String(source?.type || '') === 'sql') return section;
			const sourceOwnsComparison = !!sourceBoxId && !!source;
			const clusterUrl = String(sourceOwnsComparison ? source.clusterUrl : record.clusterUrl || '').trim();
			const database = String(sourceOwnsComparison ? source.database : record.database || '').trim();
			const authorityId = sourceOwnsComparison ? source.authorityId : record.authorityId;
			const connectionIdHint = sourceOwnsComparison ? source.connectionIdHint : record.connectionIdHint;
			const hasExplicitComparisonOwner = !!String(record.clusterUrl || record.authorityId || record.connectionIdHint || record.database || '').trim();
			const comparisonOwnerMatches = !sourceOwnsComparison || !hasExplicitComparisonOwner || (
				kustoClusterKey(record.clusterUrl) === kustoClusterKey(source.clusterUrl)
				&& String(record.authorityId || '').trim().toLowerCase() === String(source.authorityId || '').trim().toLowerCase()
				&& String(record.connectionIdHint || '').trim() === String(source.connectionIdHint || '').trim()
				&& String(record.database || '').trim().toLowerCase() === String(source.database || '').trim().toLowerCase()
			);
			let ownerMatches = false;
			let currentAccountPartition = '';
			let currentLeaveNoTraceRevision = -1;
			try {
				const resolution = resolveKustoConnection(connections, {
					clusterUrl,
					authorityId,
					connectionIdHint,
				});
				ownerMatches = !!database
					&& resolution.kind === 'matched'
					&& (!String(connectionIdHint || '').trim()
						|| resolution.connection.id === String(connectionIdHint || '').trim());
				if (resolution.kind === 'matched') {
					currentAccountPartition = String(this.kustoClient.getAccountPartition(resolution.connection) || '').trim();
					currentLeaveNoTraceRevision = snapshot.revocationGenerations?.[kustoClusterKey(clusterUrl)] ?? 0;
				}
			} catch {
				ownerMatches = false;
			}
			const protectedResult = snapshot.globallyBlocked || protectedClusters.has(kustoClusterKey(clusterUrl));
			const persistedAccountPartition = String(record.kustoAccountPartition || '').trim();
			const persistedLeaveNoTraceRevision = Number(record.kustoLeaveNoTraceRevision);
			const resultOwnerMatches = !!persistedAccountPartition
				&& persistedAccountPartition === currentAccountPartition
				&& Number.isSafeInteger(persistedLeaveNoTraceRevision)
				&& persistedLeaveNoTraceRevision >= 0
				&& persistedLeaveNoTraceRevision === currentLeaveNoTraceRevision;
			if (comparisonOwnerMatches && ownerMatches && resultOwnerMatches && !protectedResult) return section;
			changed = true;
			const clone = { ...record };
			delete clone.resultJson;
			delete clone.resultArtifact;
			delete clone.kustoAccountPartition;
			delete clone.kustoLeaveNoTraceRevision;
			return clone;
		});
		return changed ? { ...state, sections: sanitized } : state;
	}

	private stripAllKustoOwnedResults<T extends { sections?: unknown[] }>(state: T): T {
		return this.sanitizeKustoLeaveNoTraceStateFromSnapshot(state, {
			clusterKeys: [],
			globallyBlocked: true,
			version: 0,
			revocationGenerations: {},
		});
	}

	private stripOrphanedSqlPrincipalFingerprints<T extends { sections?: unknown[] }>(state: T): T {
		const sections = Array.isArray(state?.sections) ? state.sections : [];
		let changed = false;
		const sanitized = sections.map(section => {
			if (!section || typeof section !== 'object') return section;
			const record = section as Record<string, unknown>;
			const orphanedArtifact = 'resultArtifact' in record && !String(record.resultJson || '');
			const orphanedSqlPrincipal = String(record.type || '') === 'sql'
				&& ('principalFingerprint' in record || 'revocationGeneration' in record)
				&& !String(record.resultJson || '');
			if (!orphanedArtifact && !orphanedSqlPrincipal) return section;
			changed = true;
			const clone = { ...record };
			if (orphanedArtifact) delete clone.resultArtifact;
			if (orphanedSqlPrincipal) {
				delete clone.principalFingerprint;
				delete clone.revocationGeneration;
			}
			return clone;
		});
		return changed ? { ...state, sections: sanitized } : state;
	}

	private stripAllSqlOwnedResults<T extends { sections?: unknown[] }>(state: T): T {
		const sections = Array.isArray(state?.sections) ? state.sections : [];
		const sectionTypesById = new Map(sections
			.filter((section): section is Record<string, unknown> => !!section && typeof section === 'object')
			.map(section => [String(section.id || '').trim(), String(section.type || '')]));
		let changed = false;
		const sanitized = sections.map(section => {
			if (!section || typeof section !== 'object' || !('resultJson' in section)) return section;
			const record = section as Record<string, unknown>;
			const type = String(record.type || '');
			const sourceBoxId = String(record.comparisonSourceBoxId || '').trim();
			const sqlOwned = type === 'sql'
				|| (!!sourceBoxId && (sectionTypesById.get(sourceBoxId) === 'sql' || !sectionTypesById.has(sourceBoxId)));
			if (!sqlOwned) return section;
			changed = true;
			const clone = { ...record };
			delete clone.resultJson;
			delete clone.resultArtifact;
			return clone;
		});
		return this.stripOrphanedSqlPrincipalFingerprints(changed ? { ...state, sections: sanitized } : state);
	}

	private sanitizeSqlPrincipalOwnedResultsFromSnapshot<T extends { sections?: unknown[] }>(state: T, snapshot: SqlOwnerSnapshot): T {
		const sections = Array.isArray(state?.sections) ? state.sections : [];
		const sectionsById = new Map(sections
			.filter((section): section is Record<string, unknown> => !!section && typeof section === 'object')
			.map(section => [String(section.id || '').trim(), section] as const));
		const connectionsById = new Map(snapshot.connections.map(connection => [connection.id, connection]));
		const protectedIds = snapshot.policy.globallyBlocked
			? new Set(snapshot.connections.map(connection => connection.id))
			: new Set(snapshot.policy.connectionIds);
		let changed = false;
		const sanitized = sections.map(section => {
			if (!section || typeof section !== 'object' || !('resultJson' in section)) return section;
			const record = section as Record<string, unknown>;
			const sourceBoxId = String(record.comparisonSourceBoxId || '').trim();
			const source = sourceBoxId ? sectionsById.get(sourceBoxId) : undefined;
			const owner = String(source?.type || '') === 'sql' ? source! : record;
			if (String(owner.type || '') !== 'sql') return section;
			const connectionId = String(owner.connectionIdHint || '').trim();
			const targetSignature = String(owner.targetSignature || '');
			const persistedPrincipalFingerprint = String(owner.principalFingerprint || '').trim();
			const persistedRevocationGeneration = Number(owner.revocationGeneration ?? 0);
			const connection = connectionsById.get(connectionId);
			let ownerMatches = !!connection
				&& !protectedIds.has(connectionId)
				&& !!targetSignature
				&& sqlConnectionTargetSignatureMatches(connection, targetSignature)
				&& Number.isSafeInteger(persistedRevocationGeneration)
				&& persistedRevocationGeneration === (snapshot.policy.revocationGenerations[connectionId] ?? 0);
			if (ownerMatches && connection) {
				const authType = String(connection.authType || '').trim().toLowerCase();
				const principal = authType === 'aad'
					? snapshot.accountsByServer[normalizeSqlServerUrl(connection.serverUrl)]
					: String(connection.username || '').trim();
				const currentPrincipalFingerprint = sqlSchemaPrincipalFingerprintForPrincipal(connection, principal);
				ownerMatches = authType === 'aad'
					? !!persistedPrincipalFingerprint && persistedPrincipalFingerprint === currentPrincipalFingerprint
					: !persistedPrincipalFingerprint || persistedPrincipalFingerprint === currentPrincipalFingerprint;
			}
			if (ownerMatches) return section;
			changed = true;
			const clone = { ...record };
			delete clone.resultJson;
			delete clone.resultArtifact;
			return clone;
		});
		return this.stripOrphanedSqlPrincipalFingerprints(changed ? { ...state, sections: sanitized } : state);
	}

	private hasSqlOwnedState(state: { sections?: unknown[] }): boolean {
		const sections = Array.isArray(state?.sections) ? state.sections : [];
		const sectionTypesById = new Map(sections
			.filter((section): section is Record<string, unknown> => !!section && typeof section === 'object')
			.map(section => [String(section.id || '').trim(), String(section.type || '')]));
		return sections.some(section => {
			if (!section || typeof section !== 'object') return false;
			if (String((section as Record<string, unknown>).type || '') === 'sql') return true;
			const sourceBoxId = String((section as Record<string, unknown>).comparisonSourceBoxId || '').trim();
			return !!sourceBoxId && sectionTypesById.get(sourceBoxId) === 'sql';
		});
	}

	public async sanitizeSqlLeaveNoTraceStateFresh<T extends { sections?: unknown[] }>(state: T): Promise<T> {
		state = this.stripLegacyResultPayloads(state);
		try {
			return await this.sqlWorkbench.retrySqlOwnerSnapshotAcquisition(async () => {
				return this.connectionManager.runWithLeaveNoTraceSnapshotLock(async kustoSnapshot => {
					const kustoSanitized = this.sanitizeKustoLeaveNoTraceStateFromSnapshot(state, kustoSnapshot);
					const locallySanitized = this.sanitizeSqlLeaveNoTraceState(kustoSanitized);
					if (!this.hasSqlOwnedState(locallySanitized)) return { acquired: true as const, value: locallySanitized };
					return this.sqlWorkbench.tryDispatchSqlOwnerSnapshot(snapshot =>
						this.sanitizeSqlPrincipalOwnedResultsFromSnapshot(locallySanitized, snapshot));
				});
			});
		} catch {
			return this.stripAllSqlOwnedResults(this.stripAllKustoOwnedResults(this.sanitizeSqlLeaveNoTraceState(state)));
		}
	}

	public sanitizeSqlLeaveNoTraceStateFailClosed<T extends { sections?: unknown[] }>(state: T): T {
		state = this.stripLegacyResultPayloads(state);
		const locallySanitized = this.stripAllKustoOwnedResults(this.sanitizeSqlLeaveNoTraceState(state));
		return this.hasSqlOwnedState(locallySanitized)
			? this.stripAllSqlOwnedResults(locallySanitized)
			: locallySanitized;
	}

	public async publishSqlLeaveNoTraceStateFresh<T extends { sections?: unknown[] }, R>(
		state: T,
		publish: (sanitizedState: T) => Promise<R>,
	): Promise<R> {
		state = this.stripLegacyResultPayloads(state);
		return this.sqlWorkbench.retrySqlOwnerSnapshotAcquisition(async () => {
			return this.connectionManager.runWithLeaveNoTraceSnapshotLock(async kustoSnapshot => {
				const kustoSanitized = this.sanitizeKustoLeaveNoTraceStateFromSnapshot(state, kustoSnapshot);
				const locallySanitized = this.sanitizeSqlLeaveNoTraceState(kustoSanitized);
				if (!this.hasSqlOwnedState(locallySanitized)) return { acquired: true as const, value: await publish(locallySanitized) };
				return this.sqlWorkbench.tryRunWithSqlOwnerSnapshotLock(async sqlSnapshot => {
					return publish(this.sanitizeSqlPrincipalOwnedResultsFromSnapshot(locallySanitized, sqlSnapshot));
				});
			});
		});
	}

	private async executeSqlQueryFromWebview(
		message: Extract<IncomingWebviewMessage, { type: 'executeSqlQuery' }>
	): Promise<void> {
		const boxId = String(message.boxId || '').trim();
		const executionId = String(message.executionId || '').trim();
		if (!boxId || !executionId || !this.sqlLifecycle.isSectionCurrent(boxId, message.sectionInstanceId)) return;
		const comparisonSourceIdentity = message.comparisonSourceBoxId && message.comparisonSourceExecutionId
			? {
				comparisonSourceBoxId: String(message.comparisonSourceBoxId),
				comparisonSourceExecutionId: String(message.comparisonSourceExecutionId),
			}
			: {};

		const preflight = this.sqlExecutionBroker.reservePreflight(boxId, executionId, message.ownerToken);
		const protectedExecution = this.sqlWorkbench.isLeaveNoTraceConnection(message.sqlConnectionId);
		let admission: SqlExecutionAdmission | undefined;
		let lease: SqlExecutionLease<ReturnType<SqlQueryClient['executeQueryCancelable']>> | undefined;
		const isStillActiveRun = () => {
			if (lease) return lease.isCurrent();
			if (admission) return this.sqlExecutionBroker.isAdmissionCurrent(admission);
			return this.sqlExecutionBroker.isPreflightCurrent(preflight);
		};
		const postCurrentError = (error: string, ownerToken?: string) => {
			const isCurrent = isStillActiveRun();
			this.sqlExecutionBroker.clearPreflight(preflight);
			if (!isCurrent) return;
			this.postMessage({
				type: 'queryError', error, boxId,
				...(ownerToken ? { ownerToken } : {}),
				executionId, ...comparisonSourceIdentity,
			});
		};
		let issuedOwner: { token: string; owner: SqlResultOwner } | undefined;
		try {
			issuedOwner = protectedExecution
				? await this.sqlLifecycle.assertOwnerTokenProtection(boxId, message.ownerToken, true)
				: await this.assertSqlOwnerToken(boxId, message.ownerToken);
			if (!isStillActiveRun()
				|| !this.sqlLifecycle.isSectionCurrent(boxId, message.sectionInstanceId)) {
				this.sqlExecutionBroker.clearPreflight(preflight);
				return;
			}
		} catch (error) {
			postCurrentError(error instanceof Error ? error.message : String(error), message.ownerToken);
			return;
		}

		const connection = this.sqlConnectionManager.getConnection(message.sqlConnectionId);
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
			if (!message.executionId || !expected || !resultOwner
				|| expected.connectionId !== resultOwner.connectionId
				|| expected.database !== resultOwner.database
				|| expected.targetSignature !== resultOwner.targetSignature
				|| expected.principalFingerprint !== resultOwner.principalFingerprint
				|| expected.revocationGeneration !== resultOwner.revocationGeneration) {
				postCurrentError('SQL tool execution owner changed before query dispatch.', issuedOwner.token);
				return;
			}
		}
		const queryWithMode = appendSqlQueryModeFn(message.query, message.queryMode);
		try {
			if (!isStillActiveRun()
				|| !this.sqlLifecycle.isSectionCurrent(boxId, message.sectionInstanceId)) return;
			admission = this.sqlExecutionBroker.promotePreflight(preflight);
			if (!admission) return;
			lease = this.sqlExecutionBroker.start(admission, () =>
				this.sqlClient.executeQueryCancelable(connection, message.database, queryWithMode));
			const result = await lease.execution.promise;
			if (isStillActiveRun()) {
				await this.sendSqlConnectionsData();
				if (protectedExecution) await this.assertSqlResultOwnerProtection(boxId, resultOwner, true);
				else await this.assertSqlResultOwnerAllowed(boxId, resultOwner);
				if (!isStillActiveRun()) return;
				const resultMessage = {
					type: 'queryResult', result, boxId, ownerToken: issuedOwner.token, executionId,
					query: message.query, connectionId: resultOwner.connectionId, database: resultOwner.database,
					...comparisonSourceIdentity,
				};
				if (protectedExecution) {
					await this.postSqlOwnerMessageProtection(boxId, resultOwner, true, resultMessage, isStillActiveRun);
				} else {
					await this.postSqlOwnerMessageAllowed(boxId, resultOwner, resultMessage, isStillActiveRun);
				}
			}
		} catch (error) {
			if ((error as any)?.isCancelled === true || error instanceof SqlQueryCancelledError) {
				if (isStillActiveRun()) {
					try {
						const cancelledMessage = {
							type: 'queryCancelled', boxId, ownerToken: issuedOwner.token, executionId,
							...comparisonSourceIdentity,
						};
						if (protectedExecution) {
							await this.postSqlOwnerMessageProtection(boxId, resultOwner, true, cancelledMessage, isStillActiveRun);
						} else {
							await this.postSqlOwnerMessageAllowed(boxId, resultOwner, cancelledMessage, isStillActiveRun);
						}
					} catch { /* owner invalidation provides the terminal UI state */ }
				}
				return;
			}
			if (isStillActiveRun()) {
				const errorMessage = error instanceof Error ? error.message : String(error);
				// Error is displayed inline in the SQL section — no notification popup
				// (avoids stealing keyboard focus from the Monaco editor).
				try {
					const postError = () => {
						if (!isStillActiveRun()) return;
						if (protectedExecution) {
							this.output.warn('[sql-lnt] Isolated SQL query failed; details were not logged.');
						} else {
							this.output.error([
								`[${new Date().toISOString()}] SQL query execution failed`,
								`  boxId: ${boxId}`,
								`  error: ${sanitizeStsLogText(errorMessage)}`,
							].join('\n'));
						}
						this.postMessage({
							type: 'queryError', error: errorMessage, boxId, ownerToken: issuedOwner.token, executionId,
							...comparisonSourceIdentity,
						});
					};
					if (protectedExecution) {
						await this.sqlLifecycle.dispatchResultOwnerProtection(boxId, resultOwner, true, postError);
					} else {
						await this.dispatchSqlResultOwnerAllowed(boxId, resultOwner, postError);
					}
				} catch {
					this.output.warn('[sql] Query failed after owner invalidation; error details suppressed.');
				}
			}
		} finally {
			this.sqlExecutionBroker.clearPreflight(preflight);
			if (admission) this.sqlExecutionBroker.clearPending(admission);
			lease?.release();
		}
	}

	buildCacheDirective(
		cacheEnabled?: boolean,
		cacheValue?: number,
		cacheUnit?: CacheUnit | string
	): string | undefined {
		return buildCacheDirectiveFn(cacheEnabled, cacheValue, cacheUnit);
	}

	isControlCommand(query: string): boolean {
		return isControlCommandFn(query);
	}

	appendQueryMode(query: string, queryMode?: string): string {
		return appendQueryModeFn(query, queryMode);
	}

	normalizeControlCommandForExecution(query: string): string {
		return normalizeControlCommandForExecutionFn(query);
	}

	// HTML rendering moved to src/queryEditorHtml.ts
}
