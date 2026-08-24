let kustoAuthIdentityInvalidated = false;
let latestConnectionsRevision = 0;
let applyingConnectionsData = false;
// Message handler — extracted from main.ts
// Dispatches incoming postMessage from the extension host to the right module.
import { pState } from '../shared/persistence-state';
import { postMessageToHost } from '../shared/webview-messages';
import {
	hasDocumentViewEnvelopeFields,
	isDocumentViewHostMessageType,
	parseDocumentViewHostMessage,
} from '../../shared/documentViewProtocol.js';
import {
	COMPATIBILITY_PERSISTENCE_CHANNEL,
	isCompatibilityPersistenceHostMessageType,
	parseCompatibilityPersistenceHostMessage,
} from '../../shared/compatibilityPersistenceProtocol.js';
import {
	isKustoSchemaHostMessageType,
	parseKustoSchemaHostMessage,
	type KustoSchemaHostMessage,
} from '../../shared/kustoSchemaProtocol.js';
import {
	isKustoDatabaseDiscoveryHostMessageType,
	parseKustoDatabaseDiscoveryHostMessage,
} from '../../shared/kustoDatabaseDiscoveryProtocol.js';
import {
	isSqlDatabaseDiscoveryHostMessageType,
	parseSqlDatabaseDiscoveryHostMessage,
} from '../../shared/sqlDatabaseDiscoveryProtocol.js';
import {
	isSqlSchemaHostMessageType,
	parseSqlSchemaHostMessage,
} from '../../shared/sqlSchemaProtocol.js';
import {
	isKqlLanguageHostMessageType,
	isKqlLanguageResponseForMethod,
	parseKqlLanguageHostMessage,
	type KqlLanguageHostMessage,
	type KqlLanguageMethod,
} from '../../shared/kqlLanguageProtocol.js';
import {
	isControlCommandSyntaxHostMessageType,
	parseControlCommandSyntaxHostMessage,
	type ControlCommandSyntaxHostMessage,
} from '../../shared/controlCommandSyntaxProtocol.js';
import {
	isResourceUriHostMessageType,
	parseResourceUriHostMessage,
	type ResourceUriHostMessage,
} from '../../shared/resourceUriProtocol.js';
import {
	admitUrlContentHostMessage,
} from '../../shared/urlContentProtocol.js';
import {
	admitPythonExecutionHostMessage,
} from '../../shared/pythonExecutionProtocol.js';
import {
	admitArtifactCsvSaveHostMessage,
} from '../../shared/artifactCsvSaveProtocol.js';
import {
	admitSqlStsEditorLanguageHostMessage,
} from '../../shared/sqlStsEditorLanguageProtocol.js';
import {
	admitSqlConnectionsProjectionHostMessage,
	captureSqlConnectionsProjectionHostMessage,
} from '../../shared/sqlConnectionsProjectionProtocol.js';
import {
	admitKustoConnectionsProjectionHostMessage,
	captureKustoConnectionsProjectionHostMessage,
} from '../../shared/kustoConnectionsProjectionProtocol.js';
import { admitQuerySharingHostMessage } from '../../shared/querySharingProtocol.js';
import { admitEditingPreferencesHostMessage } from '../../shared/editingPreferences.js';
import { admitCopilotInlineCompletionHostMessage } from '../../shared/copilotInlineCompletionProtocol.js';
import {
	admitKustoPublicationHostMessage,
	admitKustoPublicationHostMessageFromEnvelope,
	parseKustoPublicationWebviewMessage,
} from '../../shared/kustoPublicationProtocol.js';
import { captureRuntimeMessageEnvelope } from '../../shared/runtimeMessageEnvelope.js';
import {
	admitDevelopmentNoteMutationHostMessageFromEnvelope,
	createDevelopmentNoteMutationWebviewMessage,
} from '../../shared/developmentNoteMutationProtocol.js';
import {
	admitToolStateSnapshotHostMessageFromEnvelope,
	createToolStateResponseMessage,
} from '../../shared/toolStateSnapshotProtocol.js';
import {
	admitKustoExecutionStartHostMessageFromEnvelope,
	createKustoExecutionStartedAckMessage,
} from '../../shared/kustoExecutionStartProtocol.js';
import { cancelArtifactCsvSave, provideArtifactCsvSaveData } from '../shared/artifact-csv-export.js';
import { awaitKustoSchemaPreparation, KustoSchemaPreparationTimeoutError } from '../shared/kusto-schema-preparation-deadline.js';
import { perfMark } from './perf.js';
import { traceFileOpen } from './file-open-trace.js';
import { applyDocumentCapabilityProjection, getAddSectionAdmission } from './document-capabilities.js';
import { canonicalSectionKind } from '../../shared/documentSectionCapabilities.js';
import { buildSchemaInfo } from '../shared/schema-utils';
import { safeRun } from '../shared/safe-run';
import {
	bindIndexedResultArtifactConsumer,
	bindResultArtifactConsumer,
	clearResultsState,
	getBoundResultArtifact,
	getCurrentResultArtifact,
	getResultArtifact,
	getResultArtifactByProducerExecution,
	displayResultBatchForBox,
	displayResultForBox,
	displayResult,
	displayCancelled,
	getResultsStateRevision,
	retireResultsStateForRerun,
	unbindResultArtifactConsumer,
	type ResultArtifactPublication,
} from './results-state';
import { __kustoRenderErrorUx, __kustoDisplayBoxError } from './error-renderer';
import {
	removeQueryBox, __kustoGetQuerySectionElement, __kustoSetSectionName,
	__kustoGetConnectionId, __kustoGetClusterUrl, __kustoGetDatabase,
	updateConnectionSelects, updateDatabaseSelect, onDatabasesError,
	parseKustoExplorerConnectionsXml,
	__kustoUpdateFavoritesUiForAllBoxes, __kustoTryAutoEnterFavoritesModeForAllBoxes,
	__kustoMaybeDefaultFirstBoxToFavoritesMode, __kustoOnConnectionsUpdated,
	removePythonBox, reconcileHostOwnedPythonProjection,
	removeUrlBox, commitUrlDocumentState, reconcileHostOwnedUrlProjection,
	onPythonResult, onPythonError,
	removeHtmlBox, commitHtmlDocumentState, reconcileHostOwnedHtmlProjection,
	removeSqlBox, isPinnedFirstSection,
	detachSqlComparisonForAdmissionRollback,
	updateSqlConnectionSelects, updateSqlDatabaseSelect, onSqlDatabasesError,
	__kustoGetSqlSectionElement, sqlBoxes,
	updateSqlFavoritesUiForAllBoxes,
	__kustoGetChartValidationStatus,
} from './section-factory';
import { schemaRequestTokenByBoxId } from './kusto-schema-request-state';
import {
	removeMarkdownBox,
	__kustoMaximizeMarkdownBox,
	commitMarkdownDocumentState,
	reconcileHostOwnedMarkdownProjection,
} from '../sections/kw-markdown-section';
import { reconcileHostOwnedChartProjection, removeChartBox } from '../sections/kw-chart-section';
import {
	commitTransformationDocumentState,
	reconcileHostOwnedTransformationProjection,
	removeTransformationBox,
} from '../sections/kw-transformation-section';

import { getRunMode, setRunMode } from '../sections/kw-query-toolbar';
import {
	applyEditingPreferencesData,
	captureEditingPreferencesRuntime,
	restoreEditingPreferencesRuntime,
} from './editing-preferences.js';
import {
	acquireKustoToolExecutionFence, canAdmitKustoHostExecutionStart,
	executeQuery, releaseKustoToolExecutionFence,
	setQueryExecuting, __kustoSetResultsVisible,
	__kustoSetLinkedOptimizationMode, displayComparisonSummary,
	optimizeQueryWithCopilot,
} from '../sections/query-execution.controller';
import {
	schedulePersist, persistDocumentAndWaitForAck, reconcileDocumentWithHost, acknowledgeDocumentReconciliation,
	handleDocumentDataMessage, getKqlxState, flushCompatibilityPersist, acknowledgePersistDocument,
	__kustoSetCompatibilityMode, __kustoApplyDocumentCapabilities,
	__kustoRequestAddSection, createSectionWithCapabilities, __kustoOnQueryResult, __kustoScheduleLocalSchemaPrewarm,
	__kustoSetHtmlPowerBiCompatibilityCheckEnabled,
	__kustoClearStoredQueryResult,
	resolvePendingSqlResultRestores,
	resolvePendingKustoResultRestores,
	discardPendingSqlResultRestores,
	applyKustoLeaveNoTracePolicy,
	lockDocumentAfterPersistenceFailure,
	beginKustoLeaveNoTracePolicyApplication,
	captureKustoLeaveNoTracePolicyRuntime,
	restoreKustoLeaveNoTracePolicyRuntime,
	isDocumentMutationAllowed,
	finalizeDocumentDefaultsAfterAcknowledgement,
	DOCUMENT_RUNTIME_INVALIDATED_EVENT,
} from './persistence';
import {
	getOptimisticHostOwnedDevelopmentNoteSections,
	getOptimisticHostOwnedDocumentSectionOrder,
	handleHostOwnedMarkdownCommandResult,
	isHostOwnedDevelopmentNoteDocument,
	isHostOwnedMarkdownDocument,
	requestHostOwnedDevelopmentNoteAdd,
	requestHostOwnedDevelopmentNotePatch,
	waitForHostOwnedMarkdownCommands,
} from './markdown-document-client.js';
import { parseDevelopmentNoteSection } from '../../shared/developmentNoteSectionDefinition.js';
import { retireAllPythonExecutions } from './python-execution-admission.js';
import { registerSqlComparisonAdmissionRetirementHandler } from './sql-comparison-admission-runtime.js';
import { reconcileProjectedSectionOrder } from './section-projection-order.js';
import {
	__kustoControlCommandDocCache, __kustoControlCommandDocPending,
	__kustoHandleCrossClusterSchemaData, __kustoHandleCrossClusterSchemaError,
	__kustoIsCurrentCrossClusterRequest, __kustoMarkCrossClusterSchemaError,
	__kustoReleaseStaleCrossClusterResponse, __kustoRetryPrimarySchemaEnhancement, __kustoTraceCrossCluster,
	invalidateKustoSchemaIdentityState, resyncKustoSupplementalReferencesForConnections,
} from '../monaco/monaco';
import { __kustoFindSuggestWidgetForEditor, __kustoIsElementVisibleForSuggest } from '../monaco/suggest';
import {
	handleStsResponse, handleStsDiagnostics,
} from '../monaco/sql-sts-providers.js';
import {
	commitSqlDerivedComparisonExecution,
	rollbackSqlDerivedComparisonExecution,
	routeSqlSectionMessage,
} from './sql-section-message-router.js';
import {
	activeQueryEditorBoxId,
	connections, setConnections, setLastConnectionId, setLastDatabase,
	lastConnectionId, lastDatabase,
	kustoFavorites, setKustoFavorites, leaveNoTraceClusters, setLeaveNoTraceClusters,
	caretDocsEnabled, autoTriggerAutocompleteEnabled, copilotInlineCompletionsEnabled,
	queryEditors, waitForQueryEditorReady, cachedDatabases, optimizationMetadataByBoxId,
	queryBoxes,
	schemaByConnDb,
	sqlSchemaByBoxId,
	schemaDiagnosticsTrustedByBoxId,
	schemaMetaByConnDb,
	schemaFetchInFlightByBoxId, lastSchemaRequestAtByBoxId,
	databaseRequestTokenByBoxId,
	markSchemaWorkerApplyFailed, markSchemaWorkerApplyPending, markSchemaWorkerReady,
	clearAllKustoEditorSchemas, clearKustoEditorSchema, getKustoEditorSchema, setKustoEditorSchema,
	clearAllKustoSchemaMetadata, clearKustoSchemaMetadata, getKustoSchemaMetadata, setKustoSchemaMetadata,
	clearPendingSchemaWorkerUpdate, getPendingSchemaWorkerUpdate, setPendingSchemaWorkerUpdate,
	getSchemaWorkerReadyState,
	beginKustoPreparation,
	failKustoPreparation,
	getKustoPreparationState,
	getKustoPreparationToken,
	isKustoPreparationCurrent,
	isSchemaWorkerReady,
	isSchemaWorkerApplyRequired,
	isSchemaEnhancementPending,
	isSchemaEnhancementReady,
	invalidateSchemaWorkerReadinessForBox,
	requireSchemaWorkerApply,
	requestKustoSchemaApplyForBox,
	reviseKustoPreparation,
	setKustoPreparationIdle,
	updateKustoPreparation,
	type KustoPreparationToken,
	type PendingSchemaWorkerUpdate,
	favoritesModeByBoxId,
	sqlConnections, sqlCachedDatabases, setSqlConnections, setSqlLeaveNoTraceConnectionIds,
	sqlFavorites, setSqlFavorites, sqlFavoritesModeByBoxId,
} from './state';
import { getKustoConnectionIdentityKey, getKustoSchemaIdentityKey, resolveStrictKustoConnection } from '../../shared/kustoAuth.js';
import { classifyKustoConnectionKeyspaceChange } from '../shared/schema-utils.js';
import {
	createKustoCopilotClarificationRequiredResult,
	parseKustoCopilotClarifyingQuestionMessage,
	parseKustoCopilotClarifyingQuestionMessageFromEnvelope,
	type KustoCopilotClarifyingQuestionMessage,
} from '../../shared/kustoCopilotClarificationProtocol.js';
import { hasKustoCopilotRequestIdentity, hasKustoExecutionRequestIdentity, hasKustoExecutionTerminalStamp, kustoCopilotRequestIdentityEquals, kustoExecutionIdentityEquals, kustoExecutionRequestIdentityEquals, type KustoCopilotRequestIdentity, type KustoExecutionRequestIdentity } from '../../shared/kustoExecution.js';
import { comparisonSourceArtifactConsumerId, createDerivedResultArtifactPublication, modelResultArtifactConsumerId, publicationFromPersistedResultArtifact, type ResultArtifact, type ResultArtifactSourcePolicy } from '../../shared/resultArtifact.js';
import { getKustoResultSets, parseKustoResultBatch } from '../../shared/kustoResultBatch.js';
import {
	parseKustoResultAttachmentHostMessage,
	parseKustoResultAttachmentHostMessageFromEnvelope,
} from '../../shared/kustoResultAttachmentProtocol.js';
import { sqlConnectionTargetSignature } from '../../shared/sqlConnectionIdentity.js';
import {
	SQL_COPILOT_PERSIST_ACK_TIMEOUT_MS,
	SQL_COPILOT_START_RETIREMENT_TTL_MS,
} from '../../shared/copilotExecutionStart.js';
import { kustoEditorSchemaCoordinator } from './kusto-editor-schema-runtime.js';
import {
	ADMITTED_KUSTO_COPILOT_EVENT,
	APPLIED_KUSTO_COPILOT_DONE_EVENT,
	emitAdmittedKustoCopilotOutput,
	emitAppliedKustoCopilotDone,
} from './kusto-copilot-output-runtime.js';
import { synchronizeKustoSectionTarget } from './query-section-accessors.js';
import { admitKustoDatabaseDelivery, admitKustoSchemaDelivery } from './kusto-schema-message-router.js';
import {
	isKustoSyntheticDatabaseRequest,
	isKustoSyntheticSchemaRequest,
	kustoSyntheticDatabaseRequests,
	kustoSyntheticSchemaRequests,
} from './kusto-synthetic-request-runtime.js';

const ASK_KUSTO_COPILOT_DEFAULT_MAX_RESULT_ROWS = 100;
const ASK_KUSTO_COPILOT_MIN_MAX_RESULT_ROWS = 1;
const ASK_KUSTO_COPILOT_MAX_MAX_RESULT_ROWS = 1000;
const kustoToolExecutionOwnerByRequestId = new Map<string, import('../../shared/kustoExecution.js').KustoExecutionRequestIdentity>();
const kustoToolExecutionSettlementByRequestId = new Map<string, () => void>();
const cancelledKustoToolRequestIds = new Set<string>();
const retiredSqlCopilotStarts = new Map<string, ReturnType<typeof setTimeout>>();
const kustoCopilotToolOwnerByRequestId = new Map<string, KustoCopilotRequestIdentity>();
const kustoToolConfigureTailBySectionId = new Map<string, Promise<void>>();
const sqlToolConfigureTailBySectionId = new Map<string, Promise<void>>();
let kustoToolConfigureRuntimeEpoch = 0;

function reserveKustoToolConfigureLease(sectionId: string): Readonly<{
	waitForTurn(): Promise<void> | undefined;
	settle(): void;
}> {
	const prior = kustoToolConfigureTailBySectionId.get(sectionId);
	let release!: () => void;
	const done = new Promise<void>(resolve => { release = resolve; });
	const tail = prior ? prior.catch(() => undefined).then(() => done) : done;
	kustoToolConfigureTailBySectionId.set(sectionId, tail);
	let settled = false;
	return Object.freeze({
		waitForTurn: () => prior?.catch(() => undefined),
		settle: () => {
			if (settled) return;
			settled = true;
			release();
			if (kustoToolConfigureTailBySectionId.get(sectionId) === tail) {
				kustoToolConfigureTailBySectionId.delete(sectionId);
			}
		},
	});
}

function sqlCopilotStartKey(boxId: unknown, executionId: unknown): string {
	return `${String(boxId || '').trim()}\u0000${String(executionId || '').trim()}`;
}

function retireSqlCopilotStart(boxId: unknown, executionId: unknown): void {
	const key = sqlCopilotStartKey(boxId, executionId);
	if (key === '\u0000') return;
	const previous = retiredSqlCopilotStarts.get(key);
	if (previous) clearTimeout(previous);
	const timer = setTimeout(() => retiredSqlCopilotStarts.delete(key), SQL_COPILOT_START_RETIREMENT_TTL_MS);
	retiredSqlCopilotStarts.set(key, timer);
}

function consumeRetiredSqlCopilotStart(boxId: unknown, executionId: unknown): boolean {
	const key = sqlCopilotStartKey(boxId, executionId);
	const timer = retiredSqlCopilotStarts.get(key);
	if (!timer) return false;
	clearTimeout(timer);
	retiredSqlCopilotStarts.delete(key);
	return true;
}

function reserveSqlToolConfigureLease(sectionId: string): Readonly<{
	waitForTurn(): Promise<void> | undefined;
	settle(): void;
}> {
	const prior = sqlToolConfigureTailBySectionId.get(sectionId);
	let release!: () => void;
	const done = new Promise<void>(resolve => { release = resolve; });
	const tail = prior ? prior.catch(() => undefined).then(() => done) : done;
	sqlToolConfigureTailBySectionId.set(sectionId, tail);
	let settled = false;
	return Object.freeze({
		waitForTurn: () => prior?.catch(() => undefined),
		settle: () => {
			if (settled) return;
			settled = true;
			release();
			if (sqlToolConfigureTailBySectionId.get(sectionId) === tail) {
				sqlToolConfigureTailBySectionId.delete(sectionId);
			}
		},
	});
}

function isSyntheticConnectionOwnerCurrent(
	metadata: { connectionId: string; accountPartition: string; connectionIdentity: string },
	responseAccountPartition?: unknown,
): boolean {
	const connection = connections.find(candidate => String(candidate?.id || '').trim() === metadata.connectionId);
	if (!connection) return false;
	try {
		if (getKustoConnectionIdentityKey(connection.clusterUrl, connection.authorityId) !== metadata.connectionIdentity) return false;
	} catch {
		return false;
	}
	const currentPartition = String(connection.accountPartition || '').trim();
	const responsePartition = String(responseAccountPartition || '').trim();
	if (metadata.accountPartition && currentPartition && metadata.accountPartition !== currentPartition) return false;
	if (metadata.accountPartition && responsePartition && metadata.accountPartition !== responsePartition) return false;
	if (currentPartition && responsePartition && currentPartition !== responsePartition) return false;
	return true;
}

function normalizeAskKustoCopilotMaxResultRows(value: unknown): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return ASK_KUSTO_COPILOT_DEFAULT_MAX_RESULT_ROWS;
	}
	const integerValue = Math.trunc(value);
	return Math.max(
		ASK_KUSTO_COPILOT_MIN_MAX_RESULT_ROWS,
		Math.min(ASK_KUSTO_COPILOT_MAX_MAX_RESULT_ROWS, integerValue)
	);
}

function indexedModelConsumerId(requestId: string, resultIndex: number): string {
	const primary = modelResultArtifactConsumerId(requestId);
	return resultIndex === 0 ? primary : `${primary}:set:${resultIndex}`;
}

function releaseModelResultConsumers(consumerIds: Set<string>): void {
	for (const consumerId of consumerIds) {
		try { unbindResultArtifactConsumer(consumerId); } catch { /* best effort */ }
	}
	consumerIds.clear();
}

function bindModelResultArtifacts(
	requestId: string,
	boxId: string,
	executionId: string,
	result: unknown,
	consumerIds: Set<string>,
): readonly ResultArtifact[] | undefined {
	const parsed = parseKustoResultBatch(result);
	if (!parsed.ok) return undefined;
	const artifacts: ResultArtifact[] = [];
	for (const set of getKustoResultSets(parsed.value)) {
		const artifact = getResultArtifactByProducerExecution(boxId, executionId, set.resultIndex);
		const consumerId = indexedModelConsumerId(requestId, set.resultIndex);
		const boundId = artifact && (set.resultIndex === 0
			? bindResultArtifactConsumer(consumerId, boxId, artifact.artifactId)
			: bindIndexedResultArtifactConsumer(
				consumerId, boxId, set.resultIndex, artifact.artifactId,
			));
		if (boundId) consumerIds.add(consumerId);
		const bound = boundId ? getBoundResultArtifact(consumerId, boxId) : null;
		if (!artifact || bound?.artifactId !== artifact.artifactId
			|| (bound.resultIndex ?? 0) !== set.resultIndex
			|| bound.producer?.executionId !== executionId
			|| bound.policy?.sendToModel !== true) {
			releaseModelResultConsumers(consumerIds);
			return undefined;
		}
		artifacts.push(bound);
	}
	return artifacts;
}

function projectModelResultSets(artifacts: readonly ResultArtifact[], maxRows: number) {
	const counts = Array(artifacts.length).fill(0);
	let assigned = 0;
	while (assigned < Math.max(0, maxRows)) {
		let progressed = false;
		for (let index = 0; index < artifacts.length && assigned < Math.max(0, maxRows); index++) {
			if (counts[index] >= artifacts[index].rows.length) continue;
			counts[index]++;
			assigned++;
			progressed = true;
		}
		if (!progressed) break;
	}
	return artifacts.map((artifact, index) => ({
		resultIndex: artifact.resultIndex ?? index,
		...(typeof artifact.metadata.resultName === 'string' && artifact.metadata.resultName.trim()
			? { resultName: artifact.metadata.resultName.trim() }
			: {}),
		rowCount: artifact.rows.length,
		columns: [...artifact.columns],
		results: artifact.rows.slice(0, counts[index]).map(row => Array.isArray(row) ? [...row] : row),
		returnedRowCount: counts[index],
		truncated: counts[index] < artifact.rows.length,
	}));
}

const _win = window;
const sqlPolicyBlockedBoxIds = new Set<string>();
let latestSqlConnectionsRevision = 0;
const sqlCopilotToolCancellationByRequestId = new Map<string, () => void>();

function clearSqlPolicyBox(boxId: string): void {
	const id = String(boxId || '').trim();
	if (!id) return;
	clearResultsState(id);
	delete pState.queryResultJsonByBoxId[id];
	delete pState.resultArtifactByBoxId[id];
	const section = __kustoGetSqlSectionElement(id) || __kustoGetQuerySectionElement(id);
	if (typeof section?.clearResults === 'function') section.clearResults();
}

function applySqlLeaveNoTraceConnectionIds(value: unknown): void {
	const ids = Array.isArray(value) ? value.map(id => String(id || '').trim()).filter(Boolean) : [];
	const protectedIds = new Set(ids);
	setSqlLeaveNoTraceConnectionIds(ids);
	if (ids.length > 0) discardPendingSqlResultRestores(ids);
	for (const boxId of Array.isArray(sqlBoxes) ? sqlBoxes : []) {
		const section = __kustoGetSqlSectionElement(String(boxId || ''));
		if (typeof section?.setLeaveNoTraceConnectionIds === 'function') section.setLeaveNoTraceConnectionIds(ids);
		const connectionId = typeof section?.getConnectionId === 'function' ? String(section.getConnectionId() || '').trim() : '';
		if (!protectedIds.has(connectionId)) continue;
		delete sqlSchemaByBoxId[boxId];
		if (typeof section?.clearSchemaForLeaveNoTrace === 'function') section.clearSchemaForLeaveNoTrace();
		handleStsDiagnostics(String(boxId || ''), []);
	}
	for (const [boxId, metadata] of Object.entries(optimizationMetadataByBoxId || {})) {
		if (!metadata || typeof metadata !== 'object' || !(metadata as any).isComparison) continue;
		const sourceBoxId = String((metadata as any).sourceBoxId || '').trim();
		const comparisonSection = __kustoGetQuerySectionElement(boxId) || __kustoGetSqlSectionElement(boxId);
		const sourceSection = sourceBoxId ? __kustoGetSqlSectionElement(sourceBoxId) : null;
		const kustoSourceSection = sourceBoxId ? __kustoGetQuerySectionElement(sourceBoxId) : null;
		if (!sourceSection && kustoSourceSection) continue;
		if (!comparisonSection) {
			clearSqlPolicyBox(boxId);
			delete optimizationMetadataByBoxId[boxId];
			if (sourceBoxId && optimizationMetadataByBoxId[sourceBoxId]?.comparisonBoxId === boxId) {
				delete optimizationMetadataByBoxId[sourceBoxId];
			}
			sqlPolicyBlockedBoxIds.delete(boxId);
			continue;
		}
		const sourceConnectionId = typeof sourceSection?.getConnectionId === 'function'
			? String(sourceSection.getConnectionId() || '').trim()
			: '';
		if (protectedIds.has(sourceConnectionId)) {
			sqlPolicyBlockedBoxIds.add(boxId);
			clearSqlPolicyBox(boxId);
		} else {
			sqlPolicyBlockedBoxIds.delete(boxId);
		}
	}
}

function replaceSqlCachedDatabases(value: Record<string, string[]>): void {
	for (const key of Object.keys(sqlCachedDatabases)) delete sqlCachedDatabases[key];
	for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
		if (!descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) continue;
		Object.defineProperty(sqlCachedDatabases, key, {
			value: descriptor.value, enumerable: true, configurable: true, writable: true,
		});
	}
}

function replaceKustoCachedDatabases(value: Record<string, string[]>): void {
	for (const key of Object.keys(cachedDatabases)) delete cachedDatabases[key];
	for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
		if (!descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) continue;
		Object.defineProperty(cachedDatabases, key, {
			value: descriptor.value, enumerable: true, configurable: true, writable: true,
		});
	}
}

type KustoConnectionsApplicationSnapshot = Readonly<{
	accountsHadOwnValue: boolean;
	accounts: unknown;
	connections: typeof connections;
	lastConnectionId: typeof lastConnectionId;
	lastDatabase: typeof lastDatabase;
	cachedDatabases: Record<string, unknown>;
	favorites: typeof kustoFavorites;
	leaveNoTraceClusters: typeof leaveNoTraceClusters;
	devNotesEnabledHadOwnValue: boolean;
	devNotesEnabled: unknown;
	copilotChatFirstTimeDismissed: boolean;
	preferences: ReturnType<typeof captureEditingPreferencesRuntime>;
	leaveNoTracePolicy: ReturnType<typeof captureKustoLeaveNoTracePolicyRuntime>;
}>;

function captureOwnWindowValue(key: string): Readonly<{ hadOwnValue: boolean; value: unknown }> {
	const descriptor = Object.getOwnPropertyDescriptor(window, key);
	return {
		hadOwnValue: !!descriptor,
		value: descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')
			? descriptor.value
			: undefined,
	};
}

function restoreOwnWindowValue(key: string, hadOwnValue: boolean, value: unknown): void {
	if (!hadOwnValue) {
		delete (window as unknown as Record<string, unknown>)[key];
		return;
	}
	Object.defineProperty(window, key, {
		value,
		enumerable: true,
		configurable: true,
		writable: true,
	});
}

function captureKustoConnectionsApplicationSnapshot(): KustoConnectionsApplicationSnapshot {
	const accounts = captureOwnWindowValue('__kustoAccounts');
	const devNotesEnabled = captureOwnWindowValue('__kustoDevNotesEnabled');
	const cached = Object.create(null) as Record<string, unknown>;
	Object.defineProperties(cached, Object.getOwnPropertyDescriptors(cachedDatabases));
	return {
		accountsHadOwnValue: accounts.hadOwnValue,
		accounts: accounts.value,
		connections: connections.slice(),
		lastConnectionId,
		lastDatabase,
		cachedDatabases: cached,
		favorites: kustoFavorites.slice(),
		leaveNoTraceClusters: leaveNoTraceClusters.slice(),
		devNotesEnabledHadOwnValue: devNotesEnabled.hadOwnValue,
		devNotesEnabled: devNotesEnabled.value,
		copilotChatFirstTimeDismissed: !!pState.copilotChatFirstTimeDismissed,
		preferences: captureEditingPreferencesRuntime(),
		leaveNoTracePolicy: captureKustoLeaveNoTracePolicyRuntime(),
	};
}

function restoreKustoConnectionsApplicationSnapshot(snapshot: KustoConnectionsApplicationSnapshot): void {
	restoreOwnWindowValue('__kustoAccounts', snapshot.accountsHadOwnValue, snapshot.accounts);
	setConnections(snapshot.connections);
	setLastConnectionId(snapshot.lastConnectionId);
	setLastDatabase(snapshot.lastDatabase);
	replaceKustoCachedDatabases(snapshot.cachedDatabases as Record<string, string[]>);
	setKustoFavorites(snapshot.favorites);
	setLeaveNoTraceClusters(snapshot.leaveNoTraceClusters);
	restoreOwnWindowValue(
		'__kustoDevNotesEnabled',
		snapshot.devNotesEnabledHadOwnValue,
		snapshot.devNotesEnabled,
	);
	pState.copilotChatFirstTimeDismissed = snapshot.copilotChatFirstTimeDismissed;
	restoreKustoLeaveNoTracePolicyRuntime(snapshot.leaveNoTracePolicy);
	restoreEditingPreferencesRuntime(snapshot.preferences);
	try { window.connections = connections; } catch (error) { console.error('[kusto]', error); }
}

function resolveToolKustoConnection(input: any): { connection?: any; error?: string } {
	const clusterUrl = String(input?.clusterUrl || '').trim();
	const connectionId = String(input?.connectionId || '').trim();
	if (!clusterUrl) return connectionId ? { error: 'connectionId requires clusterUrl.' } : {};
	const resolution = resolveStrictKustoConnection(connections || [], { clusterUrl, connectionId });
	if (resolution.kind === 'matched') return { connection: resolution.connection };
	if (resolution.kind === 'ambiguous') return { error: `Multiple saved connections match cluster "${clusterUrl}". Pass connectionId from listKustoConnections.` };
	if (resolution.kind === 'mismatch') return { error: 'The supplied connectionId does not match the requested cluster URL.' };
	return { error: `No saved connection matches cluster "${clusterUrl}" and connectionId.` };
}

function applyToolKustoTarget(sectionId: string, input: any): { success: boolean; error?: string } {
	const resolved = resolveToolKustoConnection(input);
	if (resolved.error) return { success: false, error: resolved.error };
	const kwEl = __kustoGetQuerySectionElement(sectionId);
	if (!kwEl) return { success: false, error: `Query section "${sectionId}" was not found.` };
	const requestedDatabase = String(input?.database || '').trim();
	const currentConnectionId = String(kwEl.getConnectionId?.() || '').trim();
	const currentDatabase = String(kwEl.getDatabase?.() || '').trim();
	if (resolved.connection || requestedDatabase) {
		kwEl.dispatchEvent(new CustomEvent('target-selection-intent', {
			detail: {
				boxId: sectionId,
				kind: resolved.connection ? 'connection' : 'database',
				...(resolved.connection ? { connectionId: resolved.connection.id } : {}),
				...(requestedDatabase ? { database: requestedDatabase } : {}),
				source: 'tool',
			},
			bubbles: true,
			composed: true,
		}));
	}
	if (resolved.connection) {
		const connectionChanged = currentConnectionId !== String(resolved.connection.id || '').trim();
		kwEl.setConnectionId?.(resolved.connection.id);
		kwEl.setDesiredConnectionIdentity?.(resolved.connection.authorityId, resolved.connection.id);
		kwEl.setDesiredClusterUrl?.(resolved.connection.clusterUrl);
		if (connectionChanged) {
			if (requestedDatabase) {
				kwEl.setDesiredDatabase?.(requestedDatabase);
				kwEl.setDatabase?.(requestedDatabase);
			}
			kwEl.dispatchEvent(new CustomEvent('connection-changed', {
				detail: {
					boxId: sectionId,
					connectionId: resolved.connection.id,
					clusterUrl: resolved.connection.clusterUrl,
					...(requestedDatabase ? { database: requestedDatabase } : {}),
					source: 'tool',
				},
				bubbles: true, composed: true,
			}));
		}
	}
	if (requestedDatabase && (resolved.connection
		&& currentConnectionId !== String(resolved.connection.id || '').trim()
		|| currentDatabase.toLowerCase() !== requestedDatabase.toLowerCase())) {
		kwEl.setDesiredDatabase?.(requestedDatabase);
		kwEl.setDatabase?.(requestedDatabase);
		kwEl.dispatchEvent(new CustomEvent('database-changed', {
			detail: { boxId: sectionId, database: requestedDatabase, source: 'tool' },
			bubbles: true, composed: true,
		}));
	}
	return { success: true };
}

// ── Agent-touched helper ─────────────────────────────────────────────────
// Tracks whether a section's current dirty state came from Copilot/tooling.

type AgentTouchedState = {
	dirtyConfirmed: boolean;
};

const agentTouchedStateBySectionId = new Map<string, AgentTouchedState>();

function getSectionShell(sectionId: string): any {
	if (!sectionId) return null;
	const el = document.getElementById(sectionId) as any;
	return el?.shadowRoot?.querySelector('kw-section-shell') || null;
}

function getSectionSerializedSignature(sectionId: string): string {
	if (!sectionId) return '';
	const el = document.getElementById(sectionId) as any;
	if (!el || typeof el.serialize !== 'function') return '';
	try {
		const serialized = el.serialize();
		if (pState.compatibilityMode && serialized && typeof serialized === 'object') {
			return JSON.stringify(getCompatibilityPersistedContent(serialized as Record<string, unknown>));
		}
		return JSON.stringify(serialized);
	} catch (e) {
		console.error('[kusto]', e);
		return '';
	}
}

type ToolOperationalState = Readonly<{
	owner: any;
	incarnation: string;
	connectionId: string;
	endpoint: string;
	database: string;
	query: string;
	runMode: string;
}>;

function captureKustoToolOperationalState(sectionId: string): ToolOperationalState | undefined {
	const owner = __kustoGetQuerySectionElement(sectionId);
	if (!owner) return undefined;
	const lifecycle = owner.getSchemaLifecycleIdentity?.();
	const editor = queryEditors?.[sectionId];
	const serialized = typeof owner.serialize === 'function' ? owner.serialize() : undefined;
	return {
		owner,
		incarnation: String(lifecycle?.sectionInstanceId || ''),
		connectionId: String(owner.getConnectionId?.() || ''),
		endpoint: String(owner.getClusterUrl?.() || ''),
		database: String(owner.getDatabase?.() || ''),
		query: String(editor?.getValue?.() ?? owner.getCopilotEditorValue?.() ?? serialized?.query ?? ''),
		runMode: String(getRunMode(sectionId)),
	};
}

function captureSqlToolOperationalState(sectionId: string): ToolOperationalState | undefined {
	const owner = __kustoGetSqlSectionElement(sectionId);
	if (!owner) return undefined;
	const serialized = typeof owner.serialize === 'function' ? owner.serialize() : undefined;
	return {
		owner,
		incarnation: String(owner.getCopilotOwnerToken?.() || ''),
		connectionId: String(owner.getSqlConnectionId?.() || owner.getConnectionId?.() || ''),
		endpoint: String(owner.getServerUrl?.() || ''),
		database: String(owner.getDatabase?.() || ''),
		query: String(owner.getQuery?.() ?? serialized?.query ?? ''),
		runMode: String(getRunMode(sectionId)),
	};
}

function sameToolOperationalConfiguration(
	left: ToolOperationalState | undefined,
	right: ToolOperationalState | undefined,
): boolean {
	return !!left && !!right
		&& left.connectionId === right.connectionId
		&& left.endpoint === right.endpoint
		&& left.database === right.database
		&& left.query === right.query
		&& left.runMode === right.runMode;
}

function sameToolOperationalState(
	left: ToolOperationalState | undefined,
	right: ToolOperationalState | undefined,
): boolean {
	return sameToolOperationalConfiguration(left, right)
		&& left?.owner === right?.owner
		&& left?.incarnation === right?.incarnation;
}

function getUnavailableResultIndexError(
	field: 'dataSourceResultIndex' | 'joinRightDataSourceResultIndex',
	sourceId: unknown,
	resultIndex: unknown,
): string | undefined {
	if (typeof resultIndex !== 'number') return undefined;
	const normalizedSourceId = String(sourceId || '').trim();
	if (!normalizedSourceId) {
		return `${field} requires a corresponding data source ID.`;
	}
	if (getCurrentResultArtifact(normalizedSourceId, resultIndex)) return undefined;
	if (resultIndex === 0 || !getCurrentResultArtifact(normalizedSourceId, 0)) return undefined;
	return `Result ${resultIndex + 1} (index ${resultIndex}) is not available for data source '${normalizedSourceId}'. Run the source query or choose an available result.`;
}

function getCompatibilityPersistedContent(section: Record<string, unknown>): Record<string, unknown> {
	const rawType = String(section.type || pState.compatibilitySingleKind || 'query');
	const sectionType = canonicalSectionKind(rawType) ?? rawType;
	const contentKey = sectionType === 'markdown' ? 'text'
		: sectionType === 'python' ? 'code'
			: sectionType === 'url' ? 'url'
				: 'query';
	return {
		type: sectionType,
		[contentKey]: typeof section[contentKey] === 'string' ? section[contentKey] : '',
	};
}

function markSectionAgentTouched(sectionId: string, beforeSignature?: string): void {
	if (!sectionId) return;
	const signature = getSectionSerializedSignature(sectionId);
	const shell = getSectionShell(sectionId);
	if (beforeSignature !== undefined && signature === beforeSignature) {
		if (!shell || !shell.hasChanges) {
			clearSectionAgentTouched(sectionId, shell);
		}
		return;
	}
	const dirtyConfirmed = !!(shell && shell.hasChanges);
	agentTouchedStateBySectionId.set(sectionId, { dirtyConfirmed });
	if (shell) {
		shell.agentTouched = dirtyConfirmed;
	}
}

function clearSectionAgentTouched(sectionId: string, shell?: any): void {
	agentTouchedStateBySectionId.delete(sectionId);
	const targetShell = shell || getSectionShell(sectionId);
	if (targetShell) {
		targetShell.agentTouched = false;
	}
}

function clearAllSectionAgentTouched(): void {
	agentTouchedStateBySectionId.clear();
	const container = document.getElementById('queries-container');
	if (!container) return;
	for (const childElement of Array.from(container.children)) {
		const shell = (childElement as any).shadowRoot?.querySelector('kw-section-shell');
		if (shell) {
			shell.agentTouched = false;
		}
	}
}

function reconcileSectionAgentTouched(sectionId: string, status: '' | 'modified' | 'new', shell: any): void {
	if (!status) {
		clearSectionAgentTouched(sectionId, shell);
		return;
	}

	const agentState = agentTouchedStateBySectionId.get(sectionId);
	if (!agentState) {
		shell.agentTouched = false;
		return;
	}

	if (agentState.dirtyConfirmed) {
		shell.agentTouched = true;
		return;
	}

	agentState.dirtyConfirmed = true;
	shell.agentTouched = true;
}

(_win as any).__kustoMarkSectionAgentTouched = markSectionAgentTouched;
(_win as any).__kustoGetSectionSerializedSignature = getSectionSerializedSignature;

function isSuggestVisibleForBoxId(boxId: string): boolean {
	try {
		const editor = queryEditors ? queryEditors[boxId] : null;
		if (!editor) return false;
		const widget = __kustoFindSuggestWidgetForEditor(editor, { requireVisible: true, maxDistancePx: 320 });
		return !!(widget && __kustoIsElementVisibleForSuggest(widget));
	} catch {
		return false;
	}
}

function getModelUriForBoxId(boxId: string): string | null {
	try {
		const editor = queryEditors ? queryEditors[boxId] : null;
		const model = editor && typeof editor.getModel === 'function' ? editor.getModel() : null;
		if (model && model.uri) {
			return model.uri.toString();
		}
	} catch (e) { console.error('[kusto]', e); }
	return null;
}

function getCurrentSchemaKeyForBoxId(boxId: string): string | null {
	try {
		let ownerId = boxId;
		try {
			if (typeof (window as any).__kustoGetSelectionOwnerBoxId === 'function') {
				ownerId = (window as any).__kustoGetSelectionOwnerBoxId(boxId) || boxId;
			}
		} catch (e) { console.error('[kusto]', e); }
		const connectionId = __kustoGetConnectionId(ownerId);
		const database = __kustoGetDatabase(ownerId);
		if (!connectionId || !database) return null;
		const selectedClusterUrl = __kustoGetClusterUrl(ownerId);
		const conn = Array.isArray(connections) ? connections.find(c => c && String(c.id || '') === connectionId) : null;
		const clusterUrl = selectedClusterUrl || (conn && conn.clusterUrl ? String(conn.clusterUrl) : '');
		const accountPartition = String(conn?.accountPartition || '').trim();
		if (!clusterUrl || !accountPartition) return null;
		return getKustoSchemaIdentityKey(connectionId, accountPartition, clusterUrl, database);
	} catch {
		return null;
	}
}

function getQueryEditorModelUri(boxId: string): string {
	try {
		const editor = queryEditors ? queryEditors[boxId] : null;
		const model = editor && typeof editor.getModel === 'function' ? editor.getModel() : null;
		return model && model.uri ? String(model.uri.toString()) : '';
	} catch {
		return '';
	}
}

function isOnlyQueryEditorBox(boxId: string): boolean {
	try {
		const queryBoxIds = Array.isArray(queryBoxes) ? queryBoxes.map(id => String(id || '')).filter(Boolean) : [];
		if (queryBoxIds.length !== 1 || queryBoxIds[0] !== boxId) {
			return false;
		}
		const editorIds = Object.keys(queryEditors || {}).filter(id => !!queryEditors[id]);
		return editorIds.length === 1 && editorIds[0] === boxId;
	} catch {
		return false;
	}
}

function getSchemaDeliveryOwnership(message: any): PendingSchemaWorkerUpdate['deliveryOwnership'] {
	const boxId = String(message?.boxId || '').trim();
	const sectionInstanceId = String(message?.sectionInstanceId || '').trim();
	const targetGeneration = Number(message?.targetGeneration);
	const requestToken = String(message?.requestToken || '').trim();
	const connectionId = String(message?.connectionId || '').trim();
	const database = String(message?.database || '').trim();
	if (!boxId || !sectionInstanceId || !Number.isSafeInteger(targetGeneration) || targetGeneration < 0 || !requestToken || !connectionId || !database) return undefined;
	return {
		request: { boxId, sectionInstanceId, targetGeneration, requestToken },
		target: { connectionId, database },
	};
}

function isSchemaDeliveryCurrent(boxId: string, ownership: PendingSchemaWorkerUpdate['deliveryOwnership']): boolean {
	return !ownership || kustoEditorSchemaCoordinator.isSchemaRequestCurrent(
		boxId,
		ownership.request,
		ownership.target,
		ownership.request.requestToken,
	);
}

function queuePendingSchemaWorkerUpdate(message: any, schemaKey: string, isForceRefresh: boolean, schemaSignature: string | undefined, reason: string, preparationToken?: KustoPreparationToken): void {
	const boxId = String(message?.boxId || '');
	if (!boxId || !message?.schema?.rawSchemaJson || !message.clusterUrl || !message.database) {
		return;
	}
	const modelUri = getQueryEditorModelUri(boxId) || undefined;
	setPendingSchemaWorkerUpdate(boxId, {
		rawSchemaJson: message.schema.rawSchemaJson,
		clusterUrl: message.clusterUrl,
		database: message.database,
		connectionId: String(message.connectionId || '').trim(),
		accountPartition: String(message.accountPartition || '').trim(),
		schemaKey,
		schemaSignature,
		forceRefresh: isForceRefresh,
		reason,
		preparationToken,
		backgroundOnly: !preparationToken && !!(message.schemaMeta?.isBackgroundRefresh || message.schemaMeta?.forceRefresh),
		deliveryOwnership: getSchemaDeliveryOwnership(message),
	});
	if (preparationToken && isKustoPreparationCurrent(preparationToken, { schemaKey, schemaSignature })) {
		const refreshPending = message.schemaMeta?.refreshState === 'scheduled';
		updateKustoPreparation(preparationToken, {
			status: 'deferred',
			stage: 'waiting-focus',
			replaceBlockers: refreshPending ? ['refresh'] : [],
			target: { schemaKey, schemaSignature, modelUri },
			usableFallback: true,
		});
	}
}

function applyKustoSchemaToWorkerFromMessage(message: any, schemaKey: string, isForceRefresh: boolean, schemaSignature?: string, preparationToken?: KustoPreparationToken): void {
	const boxId = String(message?.boxId || '');
	if (!boxId || !message?.schema?.rawSchemaJson || !message.clusterUrl || !message.database || !message.connectionId || !message.accountPartition) {
		traceFileOpen('schema.worker.skip.invalidMessage', { boxId, hasRawSchemaJson: !!message?.schema?.rawSchemaJson, hasClusterUrl: !!message?.clusterUrl, hasDatabase: !!message?.database });
		return;
	}

	const meta = message.schemaMeta || {};
	const deliveryOwnership = getSchemaDeliveryOwnership(message);
	traceFileOpen('schema.worker.consider', {
		boxId,
		schemaKey,
		forceRefresh: isForceRefresh,
		workerUpdateNeeded: meta.workerUpdateNeeded,
		isBackgroundRefresh: !!meta.isBackgroundRefresh,
		cacheState: meta.cacheState || '',
		tablesCount: meta.tablesCount,
		columnsCount: meta.columnsCount,
	});
	const isActiveBox = boxId === activeQueryEditorBoxId;
	if (schemaDiagnosticsTrustedByBoxId[boxId] === false) {
		setKustoPreparationIdle(boxId);
		traceFileOpen('schema.worker.skip.diagnosticsUntrusted', { boxId, schemaKey });
		return;
	}
	const currentModelUri = getQueryEditorModelUri(boxId);
	const explicitContextSwitch = isSchemaWorkerApplyRequired(boxId);
	const canApplyForSoleOpenEditor = !isActiveBox && !activeQueryEditorBoxId && !isForceRefresh && !!currentModelUri && isOnlyQueryEditorBox(boxId);
	if (!currentModelUri || (!isActiveBox && !canApplyForSoleOpenEditor && !explicitContextSwitch)) {
		const reason = !currentModelUri ? 'waiting-for-model' : (isForceRefresh ? 'inactive-force-refresh' : 'inactive-box');
		queuePendingSchemaWorkerUpdate(message, schemaKey, isForceRefresh, schemaSignature, reason, preparationToken);
		traceFileOpen('schema.worker.defer.inactiveBox', { boxId, activeQueryEditorBoxId, schemaKey, hasModelUri: !!currentModelUri, forceRefresh: isForceRefresh, explicitContextSwitch });
		return;
	}
	const readyState = getSchemaWorkerReadyState(boxId);
	const backgroundOnly = !preparationToken && !!(meta.isBackgroundRefresh || meta.forceRefresh);
	if (!isForceRefresh
		&& schemaSignature
		&& currentModelUri
		&& readyState?.status === 'ready'
		&& readyState.schemaKey === schemaKey
		&& readyState.schemaSignature === schemaSignature
		&& readyState.modelUri === currentModelUri) {
		traceFileOpen('schema.worker.skip.sameSignatureReady', { boxId, schemaKey, schemaSignature, modelUri: currentModelUri });
		return;
	}
	const shouldDeferForSuggest = !!meta.isBackgroundRefresh && !isForceRefresh && isActiveBox && isSuggestVisibleForBoxId(boxId);
	if (shouldDeferForSuggest) {
		setPendingSchemaWorkerUpdate(boxId, {
			rawSchemaJson: message.schema.rawSchemaJson,
			clusterUrl: message.clusterUrl,
			database: message.database,
			connectionId: String(message.connectionId || '').trim(),
			accountPartition: String(message.accountPartition || '').trim(),
			schemaKey,
			schemaSignature,
			forceRefresh: isForceRefresh,
			reason: meta.refreshReason || 'background-refresh',
			preparationToken,
			backgroundOnly,
			deliveryOwnership,
		});
		traceFileOpen('schema.worker.defer.suggestVisible', { boxId, schemaKey, reason: meta.refreshReason || 'background-refresh' });
		return;
	}

	const shouldSetAsContext = isActiveBox || canApplyForSoleOpenEditor || (explicitContextSwitch && !activeQueryEditorBoxId);
	if (!backgroundOnly) markSchemaWorkerApplyPending(boxId, schemaKey, schemaSignature, currentModelUri || undefined, preparationToken);
	traceFileOpen('schema.worker.apply.pending', { boxId, schemaKey, shouldSetAsContext, modelUri: currentModelUri, openTimeSoleEditor: canApplyForSoleOpenEditor });

	const applySchema = async () => {
		if (!isSchemaDeliveryCurrent(boxId, deliveryOwnership)) {
			traceFileOpen('schema.worker.apply.skip.staleDelivery', { boxId, schemaKey });
			return false;
		}
		if (preparationToken && !isKustoPreparationCurrent(preparationToken, { schemaKey, schemaSignature })) {
			traceFileOpen('schema.worker.apply.skip.stalePreparation', { boxId, schemaKey });
			return false;
		}
		if (typeof window.__kustoSetMonacoKustoSchema !== 'function') {
			traceFileOpen('schema.worker.apply.waitingForSetter', { boxId, schemaKey });
			return false;
		}
		const currentSchemaKey = getCurrentSchemaKeyForBoxId(boxId);
		if (!currentSchemaKey || currentSchemaKey !== schemaKey) {
			traceFileOpen('schema.worker.apply.skip.schemaKeyMismatch', { boxId, schemaKey, currentSchemaKey });
			return false;
		}
		const modelUri = getQueryEditorModelUri(boxId);
		const modelLease = kustoEditorSchemaCoordinator.getModelLease(boxId);
		const requiresModelLease = !!deliveryOwnership || !!kustoEditorSchemaCoordinator.getIdentity(boxId);
		if (!modelUri || (requiresModelLease && modelLease?.modelUri !== modelUri)) {
			traceFileOpen('schema.worker.apply.waitingForModelUri', { boxId, schemaKey });
			return false;
		}
		const isApplyCurrent = () => isSchemaDeliveryCurrent(boxId, deliveryOwnership)
			&& (!requiresModelLease || !!modelLease && kustoEditorSchemaCoordinator.isModelLeaseCurrent(modelLease))
			&& (!preparationToken || isKustoPreparationCurrent(preparationToken, { schemaKey, schemaSignature, modelUri }));
		if (!isApplyCurrent()) return false;
		const isActiveAtApply = boxId === activeQueryEditorBoxId;
		const canApplyAtOpenForSoleEditor = !isActiveAtApply && !activeQueryEditorBoxId && !isForceRefresh && isOnlyQueryEditorBox(boxId);
		const explicitContextSwitchAtApply = isSchemaWorkerApplyRequired(boxId);
		if (!isActiveAtApply && !canApplyAtOpenForSoleEditor && !explicitContextSwitchAtApply) {
			queuePendingSchemaWorkerUpdate(message, schemaKey, isForceRefresh, schemaSignature, isForceRefresh ? 'inactive-force-refresh-at-apply' : 'inactive-at-apply', preparationToken);
			traceFileOpen('schema.worker.apply.skip.inactiveAtApply', { boxId, activeQueryEditorBoxId, schemaKey, forceRefresh: isForceRefresh, explicitContextSwitchAtApply });
			return false;
		}
		const setAsContextAtApply = isActiveAtApply || canApplyAtOpenForSoleEditor || (explicitContextSwitchAtApply && !activeQueryEditorBoxId);
		traceFileOpen('schema.worker.apply.call.start', { boxId, schemaKey, modelUri, setAsContextAtApply, forceRefresh: isForceRefresh, openTimeSoleEditor: canApplyAtOpenForSoleEditor });
		const workerApply = Promise.resolve(window.__kustoSetMonacoKustoSchema(
			message.schema.rawSchemaJson,
			message.clusterUrl,
			message.database,
			setAsContextAtApply,
			modelUri,
			isForceRefresh,
			isApplyCurrent,
			preparationToken,
			undefined,
			String(message.connectionId || ''),
			String(message.accountPartition || ''),
		));
		const applied = await awaitKustoSchemaPreparation(workerApply, preparationToken).catch((error: unknown) => {
			traceFileOpen(
				error instanceof KustoSchemaPreparationTimeoutError
					? 'schema.worker.apply.call.timeout'
					: 'schema.worker.apply.call.error',
				{ boxId, schemaKey, modelUri },
			);
			throw error;
		});
		traceFileOpen('schema.worker.apply.call.done', { boxId, schemaKey, applied });
		if (!applied) {
			return false;
		}
		if (!isApplyCurrent()) return false;
		markSchemaWorkerReady(boxId, schemaKey, schemaSignature, modelUri, preparationToken);
		if (setAsContextAtApply && typeof window.__kustoTriggerRevalidation === 'function') {
			traceFileOpen('schema.worker.revalidation.start', { boxId, schemaKey });
			window.__kustoTriggerRevalidation(boxId);
			traceFileOpen('schema.worker.revalidation.done', { boxId, schemaKey });
		}
		try {
			const pending = getPendingSchemaWorkerUpdate(boxId);
			if (!pending || pending.preparationToken?.generation === preparationToken?.generation && pending.preparationToken?.revision === preparationToken?.revision) {
				if (pending) clearPendingSchemaWorkerUpdate(boxId, pending);
			}
		} catch (e) { console.error('[kusto]', e); }
		return true;
	};

	const retryDelays = [100, 300, 600, 1000, 2000];
	let retryIndex = 0;
	const retry = () => {
		traceFileOpen('schema.worker.retry.attempt', { boxId, schemaKey, attempt: retryIndex + 1 });
		applySchema().then((applied: boolean) => {
			if (applied) {
				traceFileOpen('schema.worker.retry.applied', { boxId, schemaKey, attempt: retryIndex + 1 });
				return;
			}
			if (preparationToken && !isKustoPreparationCurrent(preparationToken)) {
				traceFileOpen('schema.worker.retry.stopped.stalePreparation', { boxId, schemaKey });
				return;
			}
			if (!isSchemaDeliveryCurrent(boxId, deliveryOwnership)) {
				traceFileOpen('schema.worker.retry.stopped.staleDelivery', { boxId, schemaKey });
				return;
			}
			if (retryIndex >= retryDelays.length) {
				if (backgroundOnly) {
					queuePendingSchemaWorkerUpdate(message, schemaKey, isForceRefresh, schemaSignature, 'background-retry-exhausted', preparationToken);
					requireSchemaWorkerApply(boxId);
					invalidateSchemaWorkerReadinessForBox(boxId, false, false);
				} else {
					markSchemaWorkerApplyFailed(boxId, schemaKey, currentModelUri || undefined, preparationToken);
				}
				traceFileOpen('schema.worker.retry.failed', { boxId, schemaKey });
				return;
			}
			const delay = retryDelays[retryIndex++];
			traceFileOpen('schema.worker.retry.scheduled', { boxId, schemaKey, delay });
			setTimeout(retry, delay);
		}).catch((error: unknown) => {
			console.error('[schemaData] Worker schema apply failed:', error);
			if (backgroundOnly) {
				queuePendingSchemaWorkerUpdate(message, schemaKey, isForceRefresh, schemaSignature, 'background-retry-error', preparationToken);
				requireSchemaWorkerApply(boxId);
				invalidateSchemaWorkerReadinessForBox(boxId, false, false);
			} else {
				markSchemaWorkerApplyFailed(boxId, schemaKey, currentModelUri || undefined, preparationToken);
			}
			traceFileOpen('schema.worker.retry.error', { boxId, schemaKey, error: error instanceof Error ? error.message : String(error) });
		});
	};
	retry();
}

// --- KQL language service bridge & resource URI resolver ---
// --- KQL language service bridge (webview -> extension host) ---
// Used to share a single semantic engine between the webview Monaco editor and VS Code text editors.
// If the bridge is unavailable or times out, callers should fall back to local heuristics.
type KqlLanguageRequestResolver = {
	method: KqlLanguageMethod;
	resolve: (result: unknown) => void;
};

let __kustoKqlLanguageRequestResolversById: Record<string, KqlLanguageRequestResolver> = {};

// --- Local resource URI resolver (webview -> extension host) ---
// Used to map markdown-relative paths (e.g. ./images/a.png) to webview-safe URIs.
let __kustoResourceUriRequestResolversById: any = {};

try {
	window.__kustoResolveResourceUri = async function (args: any) {
		const p = (args && typeof args.path === 'string') ? String(args.path) : '';
		const baseUri = (args && typeof args.baseUri === 'string') ? String(args.baseUri) : '';
		if (!p || !window.vscode) {
			return null;
		}
		const requestId = 'resuri_' + Date.now() + '_' + Math.random().toString(16).slice(2);
		return await new Promise((resolve: any) => {
			let timer: any = null;
			try {
				timer = setTimeout(() => {
					try { delete __kustoResourceUriRequestResolversById[requestId]; } catch (e) { console.error('[kusto]', e); }
					resolve(null);
				}, 2000);
			} catch (e) { console.error('[kusto]', e); }

			__kustoResourceUriRequestResolversById[requestId] = {
				resolve: (result: any) => {
					try { if (timer) clearTimeout(timer); } catch (e) { console.error('[kusto]', e); }
					resolve(result);
				}
			};

			try {
				postMessageToHost({
					type: 'resolveResourceUri',
					requestId,
					path: p,
					baseUri
				});
			} catch {
				try { delete __kustoResourceUriRequestResolversById[requestId]; } catch (e) { console.error('[kusto]', e); }
				try { if (timer) clearTimeout(timer); } catch (e) { console.error('[kusto]', e); }
				resolve(null);
			}
		});
	};
} catch (e) { console.error('[kusto]', e); }

try {
	window.__kustoRequestKqlTableReferences = async function (args: any) {
		const text = (args && typeof args.text === 'string') ? args.text : '';
		const connectionId = (args && typeof args.connectionId === 'string') ? args.connectionId : '';
		const database = (args && typeof args.database === 'string') ? args.database : '';
		const boxId = (args && typeof args.boxId === 'string') ? args.boxId : '';
		if (!window.vscode) {
			return null;
		}
		const requestId = 'kqlreq_' + Date.now() + '_' + Math.random().toString(16).slice(2);
		return await new Promise((resolve: any) => {
			let timer: any = null;
			try {
				timer = setTimeout(() => {
					try { delete __kustoKqlLanguageRequestResolversById[requestId]; } catch (e) { console.error('[kusto]', e); }
					resolve(null);
				}, 1500);
			} catch (e) { console.error('[kusto]', e); }

			__kustoKqlLanguageRequestResolversById[requestId] = {
				method: 'kusto/findTableReferences',
				resolve: (result: any) => {
					try { if (timer) clearTimeout(timer); } catch (e) { console.error('[kusto]', e); }
					resolve(result);
				}
			};

			try {
				postMessageToHost({
					type: 'kqlLanguageRequest',
					requestId,
					method: 'kusto/findTableReferences',
					params: { text, connectionId, database, boxId }
				});
			} catch {
				try { delete __kustoKqlLanguageRequestResolversById[requestId]; } catch (e) { console.error('[kusto]', e); }
				try { if (timer) clearTimeout(timer); } catch (e) { console.error('[kusto]', e); }
				resolve(null);
			}
		});
	};
} catch (e) { console.error('[kusto]', e); }

// --- Extension host message dispatcher ---
const kustoTerminalMessageTypes = new Set(['queryResult', 'queryError', 'queryCancelled']);
const kustoCopilotOutputMessageTypes = new Set([
	'copilotWriteQueryStatus',
	'copilotWriteQuerySetQuery',
	'copilotWriteQueryToolResult',
	'copilotExecutedQuery',
	'copilotGeneralQueryRulesLoaded',
	'copilotUserQuerySnapshot',
	'copilotDevNotesContextLoaded',
	'copilotDevNoteToolCall',
	'copilotClarifyingQuestion',
	'copilotWriteQueryDone',
	'updateDevNotes',
	'revealSection',
]);
const ADMITTED_KUSTO_TERMINAL_EVENT = 'kusto-workbench-query-terminal';
const ADMITTED_KUSTO_EXECUTION_STARTED_EVENT = 'kusto-workbench-query-started';
const stagedKustoPublications = new Map<string, { payload: unknown; deadline: number; timer: ReturnType<typeof setTimeout> }>();
const completedKustoPublications = new Map<string, { accepted: boolean; timer: ReturnType<typeof setTimeout> }>();
const pendingKustoResultAttachmentCommits = new Map<string, Readonly<{
	boxId: string;
	executionId: string;
	sectionInstanceId: string;
	targetGeneration: number;
	primaryArtifactId: string;
}>>();

function attachKustoPublicationId(
	payload: Record<string, unknown>,
	publicationId: string,
): Record<string, unknown> {
	const message = Object.create(null) as Record<string, unknown>;
	Object.defineProperties(message, Object.getOwnPropertyDescriptors(payload));
	Object.defineProperty(message, 'publicationId', {
		value: publicationId,
		enumerable: true,
		configurable: true,
		writable: true,
	});
	return message;
}

function matchesPendingKustoToolExecution(identity: KustoExecutionRequestIdentity): boolean {
	for (const owner of kustoToolExecutionOwnerByRequestId.values()) {
		if (kustoExecutionRequestIdentityEquals(owner, identity)) return true;
	}
	return false;
}

function admitKustoTerminal(message: any): 'active' | 'retired' | 'rejected' | 'not-kusto' {
	const boxId = String(message?.boxId || '').trim();
	if (!boxId || !kustoTerminalMessageTypes.has(String(message?.type || ''))) return 'not-kusto';
	const stamped = hasKustoExecutionTerminalStamp(message, message.type === 'queryResult');
	if (!stamped) {
		const metadata = optimizationMetadataByBoxId[boxId];
		const sourceBoxId = metadata?.isComparison ? String(metadata.sourceBoxId || '').trim() : '';
		if (sourceBoxId && __kustoGetSqlSectionElement(sourceBoxId)) return 'not-kusto';
		const registered = !!__kustoGetQuerySectionElement(boxId)
			|| queryBoxes.some(id => String(id || '') === boxId);
		return message?.engine === 'kusto' || registered ? 'rejected' : 'not-kusto';
	}
	const section = __kustoGetQuerySectionElement(boxId);
	if (!section || typeof section.admitQueryTerminal !== 'function') {
		return matchesPendingKustoToolExecution(message) ? 'retired' : 'rejected';
	}
	const admission = section.admitQueryTerminal(message as KustoExecutionRequestIdentity);
	return admission === 'rejected' && matchesPendingKustoToolExecution(message) ? 'retired' : admission;
}

function completeKustoTerminal(message: any): void {
	const boxId = String(message?.boxId || '').trim();
	const executionId = String(message?.executionId || '').trim();
	if (!boxId || !executionId) return;
	const section = __kustoGetQuerySectionElement(boxId);
	if (typeof section?.completeQueryExecution === 'function') section.completeQueryExecution(executionId);
}

function settleSqlTerminalExecution(message: any): void {
	const boxId = String(message?.boxId || '').trim();
	const executionId = String(message?.executionId || '').trim();
	if (!boxId || !executionId) return;
	const section = __kustoGetSqlSectionElement(boxId);
	if (typeof section?.setExternalQueryExecuting === 'function') {
		section.setExternalQueryExecuting(false, executionId);
	}
}

type ComparisonSourceBinding = Readonly<{
	consumerId: string;
	artifactId: string;
	retentionConsumerId?: string;
	previous?: Readonly<{ sourceBoxId: string; artifactId: string }>;
}>;

function bindComparisonSourceArtifact(comparisonRun: any): boolean {
	const sourceBoxId = String(comparisonRun?.sourceBoxId || '').trim();
	const sourceExecutionId = String(comparisonRun?.sourceExecutionId || '').trim();
	const comparisonBoxId = String(comparisonRun?.comparisonBoxId || '').trim();
	if (!sourceBoxId || !sourceExecutionId || !comparisonBoxId) return false;
	const artifact = getResultArtifactByProducerExecution(sourceBoxId, sourceExecutionId);
	if (!artifact) return false;
	return bindResultArtifactConsumer(
		comparisonSourceArtifactConsumerId(comparisonBoxId), sourceBoxId, artifact.artifactId,
	) === artifact.artifactId;
}

function beginComparisonSourceBinding(message: any): ComparisonSourceBinding | undefined {
	const comparisonRun = message?.comparisonRun;
	const sourceBoxId = String(comparisonRun?.sourceBoxId || '').trim();
	const sourceExecutionId = String(comparisonRun?.sourceExecutionId || '').trim();
	const comparisonBoxId = String(comparisonRun?.comparisonBoxId || '').trim();
	if (!sourceBoxId || !sourceExecutionId || !comparisonBoxId) return undefined;
	const artifact = getResultArtifactByProducerExecution(sourceBoxId, sourceExecutionId);
	if (!artifact) return undefined;
	const consumerId = comparisonSourceArtifactConsumerId(comparisonBoxId);
	const previous = getBoundResultArtifact(consumerId);
	const retentionConsumerId = previous && previous.artifactId !== artifact.artifactId
		? `${consumerId}:pending:${message.sectionInstanceId}:${message.targetGeneration}:${message.executionId}`
		: undefined;
	if (retentionConsumerId && previous
		&& bindResultArtifactConsumer(
			retentionConsumerId,
			previous.sourceBoxId,
			previous.artifactId,
		) !== previous.artifactId) {
		return undefined;
	}
	if (bindResultArtifactConsumer(consumerId, sourceBoxId, artifact.artifactId) !== artifact.artifactId) {
		if (retentionConsumerId) unbindResultArtifactConsumer(retentionConsumerId);
		return undefined;
	}
	return {
		consumerId,
		artifactId: artifact.artifactId,
		...(retentionConsumerId ? { retentionConsumerId } : {}),
		...(previous ? {
			previous: { sourceBoxId: previous.sourceBoxId, artifactId: previous.artifactId },
		} : {}),
	};
}

function commitComparisonSourceBinding(binding: ComparisonSourceBinding): void {
	if (binding.retentionConsumerId) unbindResultArtifactConsumer(binding.retentionConsumerId);
}

function rollbackComparisonSourceBinding(binding: ComparisonSourceBinding): void {
	const current = getBoundResultArtifact(binding.consumerId);
	if (current?.artifactId === binding.artifactId) {
		if (binding.previous) {
			bindResultArtifactConsumer(
				binding.consumerId,
				binding.previous.sourceBoxId,
				binding.previous.artifactId,
			);
		} else {
			unbindResultArtifactConsumer(binding.consumerId);
		}
	}
	if (binding.retentionConsumerId) unbindResultArtifactConsumer(binding.retentionConsumerId);
}

function beginSqlComparisonSourceBinding(
	comparisonBoxId: string,
	message: any,
): ComparisonSourceBinding | undefined {
	const consumerId = comparisonSourceArtifactConsumerId(comparisonBoxId);
	const metadata = optimizationMetadataByBoxId[comparisonBoxId];
	const sourceBoxId = metadata?.isComparison ? String(metadata.sourceBoxId || '').trim() : '';
	const messageSourceBoxId = String(message?.sourceBoxId || '').trim();
	const sourceExecutionId = String(message?.sourceExecutionId || '').trim();
	if (!sourceBoxId || sourceBoxId !== messageSourceBoxId || !sourceExecutionId
		|| !__kustoGetSqlSectionElement(sourceBoxId)) return undefined;
	const sourceArtifact = getResultArtifactByProducerExecution(sourceBoxId, sourceExecutionId);
	if (!sourceArtifact || sourceArtifact.sourceBoxId !== sourceBoxId
		|| sourceArtifact.producer?.engine !== 'sql'
		|| sourceArtifact.producer.boxId !== sourceBoxId
		|| sourceArtifact.producer.executionId !== sourceExecutionId) return undefined;
	const previous = getBoundResultArtifact(consumerId);
	const retentionConsumerId = previous && previous.artifactId !== sourceArtifact.artifactId
		? `${consumerId}:pending-sql:${String(message.executionId || '').trim()}`
		: undefined;
	if (retentionConsumerId && previous
		&& bindResultArtifactConsumer(
			retentionConsumerId, previous.sourceBoxId, previous.artifactId,
		) !== previous.artifactId) return undefined;
	if (bindResultArtifactConsumer(consumerId, sourceBoxId, sourceArtifact.artifactId) !== sourceArtifact.artifactId) {
		if (retentionConsumerId) unbindResultArtifactConsumer(retentionConsumerId);
		return undefined;
	}
	return {
		consumerId,
		artifactId: sourceArtifact.artifactId,
		...(retentionConsumerId ? { retentionConsumerId } : {}),
		...(previous ? {
			previous: { sourceBoxId: previous.sourceBoxId, artifactId: previous.artifactId },
		} : {}),
	};
}

function releaseComparisonSourceArtifact(message: any): void {
	const boxId = String(message?.boxId || '').trim();
	const metadata = optimizationMetadataByBoxId[boxId];
	const sqlComparisonBoxId = metadata?.isComparison
		&& __kustoGetSqlSectionElement(String(metadata.sourceBoxId || '').trim())
		? boxId
		: '';
	const comparisonBoxId = String(message?.comparisonRun?.comparisonBoxId || sqlComparisonBoxId).trim();
	if (comparisonBoxId && String(message?.boxId || '') === comparisonBoxId) {
		unbindResultArtifactConsumer(comparisonSourceArtifactConsumerId(comparisonBoxId));
	}
}

function comparisonSourcePolicyMatchesDispatch(sourceArtifact: any, dispatch: any): boolean {
	const policy = sourceArtifact?.policy;
	if (!policy || !dispatch) return false;
	for (const key of [
		'accountPartition',
		'authSessionGeneration',
		'leaveNoTraceRevision',
		'connectionRevision',
		'connectionIdentityKey',
	] as const) {
		if (policy[key] !== undefined && policy[key] !== dispatch[key]) return false;
	}
	return !!String(policy.accountPartition || '').trim()
		&& Number.isSafeInteger(policy.authSessionGeneration)
		&& Number(policy.authSessionGeneration) >= 0
		&& Number.isSafeInteger(policy.leaveNoTraceRevision)
		&& Number(policy.leaveNoTraceRevision) >= 0
		&& Number.isSafeInteger(policy.connectionRevision)
		&& Number(policy.connectionRevision) >= 0
		&& !!String(policy.connectionIdentityKey || '').trim();
}

function comparisonSourcePolicies(sourceArtifact: any): readonly ResultArtifactSourcePolicy[] | undefined {
	if (!sourceArtifact?.policy) return undefined;
	if (Array.isArray(sourceArtifact.policy.sourcePolicies) && sourceArtifact.policy.sourcePolicies.length) {
		return sourceArtifact.policy.sourcePolicies as readonly ResultArtifactSourcePolicy[];
	}
	const policy: Record<string, unknown> = { sourceArtifactId: sourceArtifact.artifactId };
	for (const key of [
		'accountPartition',
		'authSessionGeneration',
		'leaveNoTraceRevision',
		'connectionRevision',
		'connectionIdentityKey',
		'exposeToActiveContent',
		'sendToModel',
		'shareToClipboard',
		'exportToCsv',
	] as const) {
		if (sourceArtifact.policy[key] !== undefined) policy[key] = sourceArtifact.policy[key];
	}
	return [policy as ResultArtifactSourcePolicy];
}

function getKustoResultArtifactPublication(message: unknown): ResultArtifactPublication | undefined {
	if (!message || typeof message !== 'object' || (message as Record<string, unknown>).type !== 'queryResult') return undefined;
	if (!hasKustoExecutionTerminalStamp(message, true) || !message.dispatch) return undefined;
	const dispatch = message.dispatch;
	const comparisonRun = message.comparisonRun;
	const comparisonBoxId = String(comparisonRun?.comparisonBoxId || '').trim();
	const sourceBoxId = String(comparisonRun?.sourceBoxId || '').trim();
	const sourceExecutionId = String(comparisonRun?.sourceExecutionId || '').trim();
	const sourceArtifact = comparisonBoxId && message.boxId === comparisonBoxId && sourceBoxId && sourceExecutionId
		? getBoundResultArtifact(comparisonSourceArtifactConsumerId(comparisonBoxId), sourceBoxId)
		: null;
	if (comparisonBoxId && message.boxId === comparisonBoxId
		&& (!sourceArtifact || sourceArtifact.producer?.executionId !== sourceExecutionId)) return undefined;
	if (sourceArtifact && (sourceArtifact.producer?.engine !== 'kusto'
		|| sourceArtifact.producer?.boxId !== sourceBoxId
		|| sourceArtifact.producer?.connectionId !== message.connectionId
		|| String(sourceArtifact.producer?.database || '').toLowerCase() !== String(message.database || '').toLowerCase())) return undefined;
	if (sourceArtifact && !comparisonSourcePolicyMatchesDispatch(sourceArtifact, dispatch)) return undefined;
	const sourcePolicies = comparisonSourcePolicies(sourceArtifact);
	const expectedPolicy = {
		accountPartition: dispatch.accountPartition,
		leaveNoTraceRevision: dispatch.leaveNoTraceRevision,
		exposeToActiveContent: sourceArtifact
			? sourceArtifact.policy?.exposeToActiveContent === true
			: true,
		sendToModel: sourceArtifact ? sourceArtifact.policy?.sendToModel === true : true,
		shareToClipboard: sourceArtifact ? sourceArtifact.policy?.shareToClipboard === true : true,
		exportToCsv: sourceArtifact ? sourceArtifact.policy?.exportToCsv === true : true,
		expectedProducer: {
			engine: 'kusto',
			query: typeof message.query === 'string' ? message.query : undefined,
			connectionId: message.connectionId,
			database: message.database,
		},
		...(sourceArtifact ? {
			derivedLineage: [{ sourceArtifactId: sourceArtifact.artifactId, role: 'comparison-source' }],
			derivedSourcePolicies: sourcePolicies ?? [],
		} : {}),
	};
	const admitted = publicationFromPersistedResultArtifact(
		(message as any).resultArtifactAssignment,
		message.boxId,
		expectedPolicy,
	);
	if (!admitted?.persistedIdentity || admitted.producer?.executionId !== message.executionId
		|| admitted.producer?.sectionInstanceId !== message.sectionInstanceId
		|| admitted.producer?.targetGeneration !== message.targetGeneration
		|| admitted.producer?.reservationSequence !== message.reservationSequence
		|| admitted.producer?.producer !== message.producer
		|| JSON.stringify(admitted.producer?.dispatch ?? {}) !== JSON.stringify(dispatch)) return undefined;
	const { persistedIdentity, ...publication } = admitted;
	return { ...publication, assignedIdentity: persistedIdentity };
}

function admitKustoResultPayload(payload: Record<string, unknown>): Record<string, unknown> | null | undefined {
	if (payload.type !== 'queryResult' || payload.engine !== 'kusto') return undefined;
	const parsed = parseKustoResultBatch(payload.result);
	if (!parsed.ok) return null;
	const normalized = Object.freeze({ ...payload, result: parsed.value });
	return getKustoResultArtifactPublication(normalized) ? normalized : null;
}

function getSqlResultArtifactPublication(message: any): ResultArtifactPublication | undefined {
	if (!message || message.type !== 'queryResult' || hasKustoExecutionTerminalStamp(message, true)) return undefined;
	const boxId = String(message.boxId || '').trim();
	if (!boxId) return undefined;
	const metadata = optimizationMetadataByBoxId[boxId];
	const sourceBoxId = metadata?.isComparison ? String(metadata.sourceBoxId || '').trim() : '';
	const sqlOwned = !!__kustoGetSqlSectionElement(boxId)
		|| (!!sourceBoxId && !!__kustoGetSqlSectionElement(sourceBoxId));
	if (!sqlOwned) return undefined;
	const producer = {
		engine: 'sql',
		boxId,
		...(message.executionId ? { executionId: String(message.executionId) } : {}),
		...(message.connectionId ? { connectionId: String(message.connectionId) } : {}),
		...(message.database ? { database: String(message.database) } : {}),
		...(typeof message.query === 'string' ? { query: message.query } : {}),
		producer: metadata?.isComparison ? 'comparison' : 'manual',
	};
	if (sourceBoxId) {
		const sourceArtifact = getBoundResultArtifact(
			comparisonSourceArtifactConsumerId(boxId), sourceBoxId,
		);
		const claimedSourceBoxId = String(message.comparisonSourceBoxId || '').trim();
		const claimedSourceExecutionId = String(message.comparisonSourceExecutionId || '').trim();
		if (!sourceArtifact || sourceArtifact.producer?.engine !== 'sql'
			|| sourceArtifact.producer.boxId !== sourceBoxId
			|| (claimedSourceBoxId && claimedSourceBoxId !== sourceBoxId)
			|| (claimedSourceExecutionId && sourceArtifact.producer.executionId !== claimedSourceExecutionId)
			|| sourceArtifact.producer.connectionId !== message.connectionId
			|| String(sourceArtifact.producer.database || '').toLowerCase()
				!== String(message.database || '').toLowerCase()) return undefined;
		return createDerivedResultArtifactPublication(producer, [
			{ artifact: sourceArtifact, role: 'comparison-source' },
		]);
	}
	return {
		producer,
		policy: {
			exposeToActiveContent: true, sendToModel: true,
			shareToClipboard: true, exportToCsv: true,
		},
	};
}

function emitAdmittedKustoTerminal(message: any): void {
	window.dispatchEvent(new CustomEvent(ADMITTED_KUSTO_TERMINAL_EVENT, { detail: message }));
}

function acknowledgeKustoPublication(message: any, accepted: boolean, phase: 'staged' | 'applied' = 'applied'): void {
	const parsed = parseKustoPublicationWebviewMessage({
		type: 'kustoPublicationAck', publicationId: message?.publicationId, phase, accepted,
	});
	if (!parsed.ok) return;
	const acknowledgement = parsed.value;
	if (phase === 'applied') {
		const previous = completedKustoPublications.get(acknowledgement.publicationId);
		if (previous) clearTimeout(previous.timer);
		const timer = setTimeout(() => completedKustoPublications.delete(acknowledgement.publicationId), 10_000);
		completedKustoPublications.set(acknowledgement.publicationId, { accepted: acknowledgement.accepted, timer });
	}
	postMessageToHost(acknowledgement);
}

export function replayCompletedKustoPublicationAcknowledgements(): void {
	for (const [publicationId, completed] of completedKustoPublications) {
		postMessageToHost({
			type: 'kustoPublicationAck', publicationId,
			phase: 'applied', accepted: completed.accepted,
		});
	}
}

window.addEventListener('beforeunload', replayCompletedKustoPublicationAcknowledgements);

const SQL_COMPARISON_ADMISSION_ATTRIBUTE = 'data-sql-comparison-admission-request-id';
type SqlComparisonMutationSnapshot = {
	descriptorSignature: string;
	query: string;
	queryRevision: number;
	resultRevision: number;
	hadResultJson: boolean;
	resultJson?: string;
	hadResultArtifact: boolean;
	resultArtifact?: (typeof pState.resultArtifactByBoxId)[string];
	resultArtifactSignature: string;
	executionId: string;
	executing: boolean;
};
type PendingSqlComparisonAdmission = {
	requestId: string;
	sourceBoxId: string;
	comparisonBoxId: string;
	query: string;
	mode: 'created' | 'reused';
	phase: 'proposed' | 'committed' | 'finalized' | 'completed';
	initialState: SqlComparisonMutationSnapshot;
	committedState?: SqlComparisonMutationSnapshot;
	completedState?: SqlComparisonMutationSnapshot;
	timer: ReturnType<typeof setTimeout>;
};
const pendingSqlComparisonAdmissionByRequestId = new Map<string, PendingSqlComparisonAdmission>();
const pendingSqlComparisonAdmissionRequestByBoxId = new Map<string, string>();
const completedSqlComparisonRollbackByRequestId = new Map<string, {
	sourceBoxId: string;
	comparisonBoxId: string;
}>();
const completedSqlComparisonAdmissionByRequestId = new Map<string, {
	pending: PendingSqlComparisonAdmission;
}>();

function sqlComparisonArtifactSignature(value: unknown): string {
	try { return JSON.stringify(value); } catch { return ''; }
}

function captureSqlComparisonMutationSnapshot(comparison: any, comparisonBoxId: string): SqlComparisonMutationSnapshot {
	const resultJsonByBoxId = pState.queryResultJsonByBoxId || {};
	const resultArtifactByBoxId = pState.resultArtifactByBoxId || {};
	const hadResultJson = Object.prototype.hasOwnProperty.call(resultJsonByBoxId, comparisonBoxId);
	const hadResultArtifact = Object.prototype.hasOwnProperty.call(resultArtifactByBoxId, comparisonBoxId);
	const resultArtifact = resultArtifactByBoxId[comparisonBoxId];
	const descriptor = comparison?.serializeForComparisonAdmission?.() ?? comparison?.serialize?.() ?? {};
	return {
		descriptorSignature: sqlComparisonArtifactSignature(descriptor),
		query: String(comparison?.getQuery?.() ?? comparison?.serialize?.()?.query ?? ''),
		queryRevision: Number(comparison?.getQueryRevision?.() || 0),
		resultRevision: Number(getResultsStateRevision(comparisonBoxId) || 0),
		hadResultJson,
		...(hadResultJson ? { resultJson: resultJsonByBoxId[comparisonBoxId] } : {}),
		hadResultArtifact,
		...(hadResultArtifact ? { resultArtifact } : {}),
		resultArtifactSignature: hadResultArtifact ? sqlComparisonArtifactSignature(resultArtifact) : '',
		executionId: String(comparison?.getActiveQueryExecutionId?.() || ''),
		executing: comparison?.isQueryExecuting?.() === true,
	};
}

function sqlComparisonMutationSnapshotMatches(
	comparison: any,
	comparisonBoxId: string,
	expected: SqlComparisonMutationSnapshot | undefined,
): boolean {
	if (!expected) return false;
	const current = captureSqlComparisonMutationSnapshot(comparison, comparisonBoxId);
	return current.descriptorSignature === expected.descriptorSignature
		&& current.query === expected.query
		&& current.queryRevision === expected.queryRevision
		&& current.resultRevision === expected.resultRevision
		&& current.hadResultJson === expected.hadResultJson
		&& current.resultJson === expected.resultJson
		&& current.hadResultArtifact === expected.hadResultArtifact
		&& current.resultArtifactSignature === expected.resultArtifactSignature
		&& current.executionId === expected.executionId
		&& current.executing === expected.executing;
}

function acknowledgeSqlComparisonAdmission(
	phase: 'staged' | 'committed' | 'finalized' | 'completed' | 'rolledBack',
	requestId: string,
	sourceBoxId: string,
	comparisonBoxId: string,
	accepted: boolean,
): void {
	postMessageToHost({
		type: 'sqlComparisonAdmissionAck', phase, requestId, sourceBoxId, comparisonBoxId, accepted,
	});
}

function clearPendingSqlComparisonAdmission(pending: PendingSqlComparisonAdmission): void {
	if (pendingSqlComparisonAdmissionByRequestId.get(pending.requestId) === pending) {
		pendingSqlComparisonAdmissionByRequestId.delete(pending.requestId);
	}
	if (pendingSqlComparisonAdmissionRequestByBoxId.get(pending.comparisonBoxId) === pending.requestId) {
		pendingSqlComparisonAdmissionRequestByBoxId.delete(pending.comparisonBoxId);
	}
	try { clearTimeout(pending.timer); } catch { /* ignore */ }
}

registerSqlComparisonAdmissionRetirementHandler((comparisonBoxId, sourceBoxId) => {
	const requestId = pendingSqlComparisonAdmissionRequestByBoxId.get(comparisonBoxId);
	const pending = requestId ? pendingSqlComparisonAdmissionByRequestId.get(requestId) : undefined;
	if (!pending || pending.sourceBoxId !== sourceBoxId || pending.comparisonBoxId !== comparisonBoxId) {
		return false;
	}
	if (pending.phase !== 'finalized') return false;
	const comparison = __kustoGetSqlSectionElement(comparisonBoxId);
	comparison?.removeAttribute?.(SQL_COMPARISON_ADMISSION_ATTRIBUTE);
	comparison?.setComparisonPersistenceSnapshot?.(undefined);
	comparison?.setComparisonAdmissionPending?.(false);
	clearPendingSqlComparisonAdmission(pending);
	return true;
});

function applySqlComparisonAdmissionDecision(message: any): void {
	const requestId = String(message?.requestId || '').trim();
	const sourceBoxId = String(message?.sourceBoxId || '').trim();
	const comparisonBoxId = String(message?.comparisonBoxId || '').trim();
	const pending = requestId ? pendingSqlComparisonAdmissionByRequestId.get(requestId) : undefined;
	if (!pending || pending.sourceBoxId !== sourceBoxId || pending.comparisonBoxId !== comparisonBoxId) {
		acknowledgeSqlComparisonAdmission('staged', requestId, sourceBoxId, comparisonBoxId, false);
		return;
	}
	const comparison = __kustoGetSqlSectionElement(comparisonBoxId);
	const metadata = optimizationMetadataByBoxId[comparisonBoxId];
	const exactSection = !!comparison && metadata?.isComparison === true
		&& String(metadata.sourceBoxId || '') === sourceBoxId;
	const exactProvisional = pending.mode !== 'created'
		|| comparison?.getAttribute?.(SQL_COMPARISON_ADMISSION_ATTRIBUTE) === requestId;
	if (message.accepted !== true) {
		rollbackSqlComparisonAdmission(message);
		return;
	}
	if (!exactSection || !exactProvisional
		|| !sqlComparisonMutationSnapshotMatches(comparison, comparisonBoxId, pending.initialState)) {
		acknowledgeSqlComparisonAdmission('staged', requestId, sourceBoxId, comparisonBoxId, false);
		return;
	}
	acknowledgeSqlComparisonAdmission('staged', requestId, sourceBoxId, comparisonBoxId, true);
}

function commitSqlComparisonAdmission(message: any): void {
	const requestId = String(message?.requestId || '').trim();
	const sourceBoxId = String(message?.sourceBoxId || '').trim();
	const comparisonBoxId = String(message?.comparisonBoxId || '').trim();
	const pending = requestId ? pendingSqlComparisonAdmissionByRequestId.get(requestId) : undefined;
	if (!pending || pending.sourceBoxId !== sourceBoxId || pending.comparisonBoxId !== comparisonBoxId) {
		acknowledgeSqlComparisonAdmission('committed', requestId, sourceBoxId, comparisonBoxId, false);
		return;
	}
	const comparison = __kustoGetSqlSectionElement(comparisonBoxId);
	const metadata = optimizationMetadataByBoxId[comparisonBoxId];
	const exactSection = !!comparison && metadata?.isComparison === true
		&& String(metadata.sourceBoxId || '') === sourceBoxId;
	const exactProvisional = pending.mode !== 'created'
		|| comparison?.getAttribute?.(SQL_COMPARISON_ADMISSION_ATTRIBUTE) === requestId;
	if (!exactSection || !exactProvisional || pending.phase !== 'proposed'
		|| !sqlComparisonMutationSnapshotMatches(comparison, comparisonBoxId, pending.initialState)) {
		acknowledgeSqlComparisonAdmission('committed', requestId, sourceBoxId, comparisonBoxId, false);
		return;
	}
	if (pending.mode === 'reused') {
		comparison.setQuery?.(pending.query);
		if (pState.queryResultJsonByBoxId) delete pState.queryResultJsonByBoxId[comparisonBoxId];
		if (pState.resultArtifactByBoxId) delete pState.resultArtifactByBoxId[comparisonBoxId];
	}
	pending.phase = 'committed';
	pending.committedState = captureSqlComparisonMutationSnapshot(comparison, comparisonBoxId);
	try { schedulePersist(); } catch (error) { console.error('[kusto]', error); }
	acknowledgeSqlComparisonAdmission('committed', requestId, sourceBoxId, comparisonBoxId, true);
}

function rollbackSqlComparisonAdmission(message: any): void {
	const requestId = String(message?.requestId || '').trim();
	const sourceBoxId = String(message?.sourceBoxId || '').trim();
	const comparisonBoxId = String(message?.comparisonBoxId || '').trim();
	const completed = requestId ? completedSqlComparisonRollbackByRequestId.get(requestId) : undefined;
	if (completed) {
		acknowledgeSqlComparisonAdmission('rolledBack', requestId, sourceBoxId, comparisonBoxId,
			completed.sourceBoxId === sourceBoxId && completed.comparisonBoxId === comparisonBoxId);
		return;
	}
	const completedAdmission = requestId ? completedSqlComparisonAdmissionByRequestId.get(requestId) : undefined;
	if (completedAdmission) {
		acknowledgeSqlComparisonAdmission('rolledBack', requestId, sourceBoxId, comparisonBoxId, false);
		return;
	}
	const pending = requestId
		? pendingSqlComparisonAdmissionByRequestId.get(requestId)
		: undefined;
	if (!pending || pending.sourceBoxId !== sourceBoxId || pending.comparisonBoxId !== comparisonBoxId) {
		acknowledgeSqlComparisonAdmission('rolledBack', requestId, sourceBoxId, comparisonBoxId, false);
		return;
	}
	const comparison = __kustoGetSqlSectionElement(comparisonBoxId);
	const expectedState = pending.phase === 'proposed' ? pending.initialState
		: pending.phase === 'completed' ? pending.completedState
			: pending.committedState;
	const stateUnchanged = !!comparison
		&& sqlComparisonMutationSnapshotMatches(comparison, comparisonBoxId, expectedState);
	if (pending.mode === 'created') {
		const detached = detachSqlComparisonForAdmissionRollback(comparisonBoxId, sourceBoxId);
		if (detached && stateUnchanged) removeSqlBox(comparisonBoxId);
		else comparison?.removeAttribute?.(SQL_COMPARISON_ADMISSION_ATTRIBUTE);
	} else if (pending.phase !== 'proposed' && comparison && stateUnchanged) {
		comparison.setQuery?.(pending.initialState.query);
		if (pending.initialState.hadResultJson) {
			pState.queryResultJsonByBoxId[comparisonBoxId] = pending.initialState.resultJson!;
		} else {
			delete pState.queryResultJsonByBoxId[comparisonBoxId];
		}
		if (pending.initialState.hadResultArtifact) {
			pState.resultArtifactByBoxId[comparisonBoxId] = pending.initialState.resultArtifact!;
		} else {
			delete pState.resultArtifactByBoxId[comparisonBoxId];
		}
	}
	comparison?.setComparisonPersistenceSnapshot?.(undefined);
	comparison?.setComparisonAdmissionPending?.(false);
	clearPendingSqlComparisonAdmission(pending);
	try { schedulePersist('sql-comparison-rollback', true); } catch (error) { console.error('[kusto]', error); }
	completedSqlComparisonRollbackByRequestId.set(requestId, { sourceBoxId, comparisonBoxId });
	acknowledgeSqlComparisonAdmission('rolledBack', requestId, sourceBoxId, comparisonBoxId, true);
}

function finalizeSqlComparisonAdmission(message: any): void {
	const requestId = String(message?.requestId || '').trim();
	const sourceBoxId = String(message?.sourceBoxId || '').trim();
	const comparisonBoxId = String(message?.comparisonBoxId || '').trim();
	const pending = requestId ? pendingSqlComparisonAdmissionByRequestId.get(requestId) : undefined;
	if (!pending || pending.sourceBoxId !== sourceBoxId || pending.comparisonBoxId !== comparisonBoxId) {
		acknowledgeSqlComparisonAdmission('finalized', requestId, sourceBoxId, comparisonBoxId, false);
		return;
	}
	const comparison = __kustoGetSqlSectionElement(comparisonBoxId);
	const stateUnchanged = !!comparison && sqlComparisonMutationSnapshotMatches(
		comparison, comparisonBoxId, pending.committedState,
	);
	if (pending.phase === 'finalized') {
		acknowledgeSqlComparisonAdmission('finalized', requestId, sourceBoxId, comparisonBoxId, stateUnchanged);
		return;
	}
	if (pending.phase !== 'committed' || !stateUnchanged) {
		acknowledgeSqlComparisonAdmission('finalized', requestId, sourceBoxId, comparisonBoxId, false);
		return;
	}
	pending.phase = 'finalized';
	try { clearTimeout(pending.timer); } catch { /* ignore */ }
	acknowledgeSqlComparisonAdmission('finalized', requestId, sourceBoxId, comparisonBoxId, true);
}

function completeSqlComparisonAdmission(message: any): void {
	const requestId = String(message?.requestId || '').trim();
	const sourceBoxId = String(message?.sourceBoxId || '').trim();
	const comparisonBoxId = String(message?.comparisonBoxId || '').trim();
	const completed = requestId ? completedSqlComparisonAdmissionByRequestId.get(requestId) : undefined;
	if (completed) {
		acknowledgeSqlComparisonAdmission('completed', requestId, sourceBoxId, comparisonBoxId,
			completed.pending.sourceBoxId === sourceBoxId && completed.pending.comparisonBoxId === comparisonBoxId);
		return;
	}
	const pending = requestId ? pendingSqlComparisonAdmissionByRequestId.get(requestId) : undefined;
	if (!pending || pending.phase !== 'finalized'
		|| pending.sourceBoxId !== sourceBoxId || pending.comparisonBoxId !== comparisonBoxId) {
		acknowledgeSqlComparisonAdmission('completed', requestId, sourceBoxId, comparisonBoxId, false);
		return;
	}
	const comparison = __kustoGetSqlSectionElement(comparisonBoxId);
	if (!comparison || !sqlComparisonMutationSnapshotMatches(comparison, comparisonBoxId, pending.committedState)) {
		acknowledgeSqlComparisonAdmission('completed', requestId, sourceBoxId, comparisonBoxId, false);
		return;
	}
	pending.phase = 'completed';
	clearPendingSqlComparisonAdmission(pending);
	if (pending.mode === 'created') comparison?.removeAttribute?.(SQL_COMPARISON_ADMISSION_ATTRIBUTE);
	comparison?.setComparisonPersistenceSnapshot?.(undefined);
	comparison?.setComparisonAdmissionPending?.(false);
	if (pending.mode === 'reused') {
		retireResultsStateForRerun(comparisonBoxId);
		comparison?.clearResults?.();
		unbindResultArtifactConsumer(comparisonSourceArtifactConsumerId(comparisonBoxId));
	}
	pending.completedState = captureSqlComparisonMutationSnapshot(comparison, comparisonBoxId);
	try { schedulePersist(); } catch (error) { console.error('[kusto]', error); }
	completedSqlComparisonAdmissionByRequestId.set(requestId, { pending });
	acknowledgeSqlComparisonAdmission('completed', requestId, sourceBoxId, comparisonBoxId, true);
}

function releaseSqlComparisonAdmissionProof(message: any): void {
	const requestId = String(message?.requestId || '').trim();
	const sourceBoxId = String(message?.sourceBoxId || '').trim();
	const comparisonBoxId = String(message?.comparisonBoxId || '').trim();
	if (!requestId || !sourceBoxId || !comparisonBoxId) return;
	if (message.outcome === 'completed') {
		const completed = completedSqlComparisonAdmissionByRequestId.get(requestId);
		if (completed?.pending.sourceBoxId === sourceBoxId
			&& completed.pending.comparisonBoxId === comparisonBoxId) {
			completedSqlComparisonAdmissionByRequestId.delete(requestId);
		}
		return;
	}
	if (message.outcome === 'rolledBack') {
		const rolledBack = completedSqlComparisonRollbackByRequestId.get(requestId);
		if (rolledBack?.sourceBoxId === sourceBoxId && rolledBack.comparisonBoxId === comparisonBoxId) {
			completedSqlComparisonRollbackByRequestId.delete(requestId);
		}
	}
}

function stageSqlComparisonAdmission(
	requestId: string,
	sourceBoxId: string,
	comparisonBoxId: string,
	query: string,
	mode: 'created' | 'reused',
): boolean {
	if (pendingSqlComparisonAdmissionByRequestId.has(requestId)
		|| pendingSqlComparisonAdmissionRequestByBoxId.has(comparisonBoxId)) return false;
	const comparison = __kustoGetSqlSectionElement(comparisonBoxId);
	if (!comparison) return true;
	if (mode === 'created') comparison.setAttribute(SQL_COMPARISON_ADMISSION_ATTRIBUTE, requestId);
	comparison.setComparisonAdmissionPending?.(true);
	const persistenceSnapshot = mode === 'reused' ? comparison.serialize?.() : undefined;
	const initialState = captureSqlComparisonMutationSnapshot(comparison, comparisonBoxId);
	if (mode === 'reused') comparison.setComparisonPersistenceSnapshot?.(persistenceSnapshot);
	let pending!: PendingSqlComparisonAdmission;
	const timer = setTimeout(() => {
		if (pendingSqlComparisonAdmissionByRequestId.get(requestId) !== pending) return;
		rollbackSqlComparisonAdmission({ requestId, sourceBoxId, comparisonBoxId });
	}, 25_000);
	pending = {
		requestId, sourceBoxId, comparisonBoxId, query, mode, phase: 'proposed',
		initialState, timer,
	};
	pendingSqlComparisonAdmissionByRequestId.set(requestId, pending);
	pendingSqlComparisonAdmissionRequestByBoxId.set(comparisonBoxId, requestId);
	return true;
}

window.addEventListener(DOCUMENT_RUNTIME_INVALIDATED_EVENT, () => {
	kustoToolConfigureRuntimeEpoch++;
	retireAllPythonExecutions();
	for (const pending of [...pendingSqlComparisonAdmissionByRequestId.values()]) {
		const message = {
			requestId: pending.requestId,
			sourceBoxId: pending.sourceBoxId,
			comparisonBoxId: pending.comparisonBoxId,
		};
		if (pending.phase === 'finalized') completeSqlComparisonAdmission(message);
		else rollbackSqlComparisonAdmission(message);
	}
	for (const [publicationId, staged] of [...stagedKustoPublications]) {
		try { clearTimeout(staged.timer); } catch { /* ignore */ }
		stagedKustoPublications.delete(publicationId);
		acknowledgeKustoPublication({ publicationId }, false, 'applied');
	}
});

const __kustoDispatchHostMessage = async (message: any) => {
	const envelope = captureRuntimeMessageEnvelope(message);
	if (!envelope.ok) return;
	message = envelope.value;
	if (message.type === 'kustoResultAttachmentCommitted'
		|| message.type === 'kustoResultSelectionResult') {
		const parsed = parseKustoResultAttachmentHostMessageFromEnvelope(envelope.descriptorSnapshot);
		if (!parsed.ok) return;
		message = parsed.value;
	}
	const rawKustoPublicationAdmission = admitKustoPublicationHostMessageFromEnvelope(
		envelope.descriptorSnapshot,
	);
	if (rawKustoPublicationAdmission.recognized) {
		if (!rawKustoPublicationAdmission.parsed.ok) return;
		message = rawKustoPublicationAdmission.parsed.value;
	}
	const developmentNoteMutationAdmission = rawKustoPublicationAdmission.recognized
		? { recognized: false as const }
		: admitDevelopmentNoteMutationHostMessageFromEnvelope(envelope.descriptorSnapshot);
	if (developmentNoteMutationAdmission.recognized) {
		if (!developmentNoteMutationAdmission.parsed.ok) return;
		message = developmentNoteMutationAdmission.parsed.value;
	}
	const toolStateAdmission = developmentNoteMutationAdmission.recognized
		? { recognized: false as const }
		: admitToolStateSnapshotHostMessageFromEnvelope(envelope.descriptorSnapshot);
	if (toolStateAdmission.recognized) {
		if (!toolStateAdmission.parsed.ok) return;
		message = toolStateAdmission.parsed.value;
	}
	const executionStartAdmission = developmentNoteMutationAdmission.recognized
		|| toolStateAdmission.recognized
		? { recognized: false as const }
		: admitKustoExecutionStartHostMessageFromEnvelope(envelope.descriptorSnapshot);
	if (executionStartAdmission.recognized) {
		if (!executionStartAdmission.parsed.ok) return;
		message = executionStartAdmission.parsed.value;
	}
	const kustoPublicationAdmission = admitKustoPublicationHostMessage(message);
	if (kustoPublicationAdmission.recognized) {
		if (!kustoPublicationAdmission.parsed.ok) return;
		message = kustoPublicationAdmission.parsed.value;
	}
	const editingPreferencesAdmission = kustoPublicationAdmission.recognized
		? { recognized: false as const }
		: admitEditingPreferencesHostMessage(message);
	if (editingPreferencesAdmission.recognized) {
		if (!editingPreferencesAdmission.parsed.ok) return;
		message = editingPreferencesAdmission.parsed.value;
	}
	const kustoConnectionsProjectionAdmission = editingPreferencesAdmission.recognized
		? { recognized: false as const }
		: admitKustoConnectionsProjectionHostMessage(message);
	if (kustoConnectionsProjectionAdmission.recognized) {
		if (!kustoConnectionsProjectionAdmission.parsed.ok) return;
		const captured = captureKustoConnectionsProjectionHostMessage(kustoConnectionsProjectionAdmission.parsed.value);
		if (!captured.ok) return;
		message = captured.value;
	}
	const sqlConnectionsProjectionAdmission = kustoConnectionsProjectionAdmission.recognized
		? { recognized: false as const }
		: admitSqlConnectionsProjectionHostMessage(message);
	if (sqlConnectionsProjectionAdmission.recognized) {
		if (!sqlConnectionsProjectionAdmission.parsed.ok) return;
		const captured = captureSqlConnectionsProjectionHostMessage(sqlConnectionsProjectionAdmission.parsed.value);
		if (!captured.ok) return;
		message = captured.value;
	}
	const stsEditorLanguageAdmission = sqlConnectionsProjectionAdmission.recognized
		? { recognized: false as const }
		: admitSqlStsEditorLanguageHostMessage(message);
	if (stsEditorLanguageAdmission.recognized) {
		if (!stsEditorLanguageAdmission.parsed.ok) return;
		message = stsEditorLanguageAdmission.parsed.value;
	}
	const artifactCsvSaveAdmission = stsEditorLanguageAdmission.recognized
		? { recognized: false as const }
		: admitArtifactCsvSaveHostMessage(message);
	if (artifactCsvSaveAdmission.recognized) {
		if (!artifactCsvSaveAdmission.parsed.ok) return;
		message = artifactCsvSaveAdmission.parsed.value;
	}
	const pythonExecutionAdmission = artifactCsvSaveAdmission.recognized
		? { recognized: false as const }
		: admitPythonExecutionHostMessage(message);
	if (pythonExecutionAdmission.recognized) {
		if (!pythonExecutionAdmission.parsed.ok) return;
		message = pythonExecutionAdmission.parsed.value;
	}
	const querySharingAdmission = pythonExecutionAdmission.recognized
		? { recognized: false as const }
		: admitQuerySharingHostMessage(message);
	if (querySharingAdmission.recognized) {
		if (!querySharingAdmission.parsed.ok) return;
		message = querySharingAdmission.parsed.value;
	}
	const copilotInlineCompletionAdmission = querySharingAdmission.recognized
		? { recognized: false as const }
		: admitCopilotInlineCompletionHostMessage(message);
	if (copilotInlineCompletionAdmission.recognized) {
		if (!copilotInlineCompletionAdmission.parsed.ok) return;
		message = copilotInlineCompletionAdmission.parsed.value;
	}
	message = (message && typeof message === 'object') ? message : {};
	const urlContentAdmission = admitUrlContentHostMessage(message);
	if (urlContentAdmission.recognized) {
		if (!urlContentAdmission.parsed.ok) return;
		message = urlContentAdmission.parsed.value;
	}
	if (isKustoDatabaseDiscoveryHostMessageType(message)) {
		const parsed = parseKustoDatabaseDiscoveryHostMessage(message);
		if (!parsed.ok) return;
		message = parsed.value;
	}
	if (isSqlDatabaseDiscoveryHostMessageType(message)) {
		const parsed = parseSqlDatabaseDiscoveryHostMessage(message);
		if (!parsed.ok) return;
		message = parsed.value;
	}
	if (isSqlSchemaHostMessageType(message)) {
		const parsed = parseSqlSchemaHostMessage(message);
		if (!parsed.ok) return;
		message = parsed.value;
	}
	let resourceUriHostMessage: ResourceUriHostMessage | undefined;
	if (isResourceUriHostMessageType(message)) {
		const parsed = parseResourceUriHostMessage(message);
		if (!parsed.ok) return;
		resourceUriHostMessage = parsed.value;
		message = parsed.value;
	}
	let controlCommandSyntaxHostMessage: ControlCommandSyntaxHostMessage | undefined;
	if (isControlCommandSyntaxHostMessageType(message)) {
		const parsed = parseControlCommandSyntaxHostMessage(message);
		if (!parsed.ok) return;
		controlCommandSyntaxHostMessage = parsed.value;
		message = parsed.value;
	}
	let kqlLanguageHostMessage: KqlLanguageHostMessage | undefined;
	if (isKqlLanguageHostMessageType(message)) {
		const parsed = parseKqlLanguageHostMessage(message);
		if (!parsed.ok) return;
		kqlLanguageHostMessage = parsed.value;
		message = parsed.value;
	}
	let kustoSchemaHostMessage: KustoSchemaHostMessage | undefined;
	if (isKustoSchemaHostMessageType(message)) {
		const parsed = parseKustoSchemaHostMessage(message);
		if (!parsed.ok) return;
		kustoSchemaHostMessage = parsed.value;
		message = parsed.value;
	}
	let compatibilityProjectionFingerprint: string | undefined;
	const compatibilityPersistenceMessage = isCompatibilityPersistenceHostMessageType(message)
		&& (message.channel === COMPATIBILITY_PERSISTENCE_CHANNEL
			|| !!pState.compatibilityPersistenceViewSessionId);
	if (compatibilityPersistenceMessage) {
		const parsed = parseCompatibilityPersistenceHostMessage(message);
		if (!parsed.ok
			|| parsed.value.viewSessionId !== pState.compatibilityPersistenceViewSessionId) return;
		if (parsed.value.type === 'documentData') {
			const currentGeneration = Number(pState.sourceGeneration);
			if (Number.isSafeInteger(currentGeneration)
				&& parsed.value.sourceGeneration < currentGeneration) {
				postMessageToHost({
					type: 'documentReloadResult', requestId: parsed.value.reloadRequestId,
					applied: false, editRevision: pState.documentEditRevision,
					markdownCommandBarrierSupported: true,
				});
				return;
			}
		}
		if (parsed.value.type === 'documentData' && parsed.value.requestSource === 'webview') {
			compatibilityProjectionFingerprint = getCompatibilityProjectionFingerprint(parsed.value);
			const requestId = parsed.value.requestId;
			const pending = pState.compatibilityPersistenceDocumentRequestIds.has(requestId);
			const appliedFingerprint = pState.compatibilityPersistenceAppliedDocumentRequests.get(requestId);
			if (!pending && appliedFingerprint === undefined) return;
			if (!pending && appliedFingerprint === compatibilityProjectionFingerprint) {
				const currentGeneration = Number(pState.sourceGeneration);
				const retryGeneration = parsed.value.sourceGeneration;
				const applied = !Number.isSafeInteger(currentGeneration) || retryGeneration >= currentGeneration;
				if (applied) pState.sourceGeneration = retryGeneration;
				postMessageToHost({
					type: 'documentReloadResult', requestId: parsed.value.reloadRequestId,
					applied, editRevision: pState.documentEditRevision,
					markdownCommandBarrierSupported: true,
				});
				if (applied && parsed.value.ok
					&& pState.documentEditRevision > parsed.value.editRevision) {
					schedulePersist('compatibility-projection-retry', true);
				}
				return;
			}
		}
		message = parsed.value;
	} else {
	const documentViewMessage = isDocumentViewHostMessageType(message)
		&& (hasDocumentViewEnvelopeFields(message) || !!pState.documentViewSessionId);
	if (documentViewMessage) {
		const parsed = parseDocumentViewHostMessage(message);
		if (!parsed.ok) return;
		const currentViewSessionId = pState.documentViewSessionId;
		if (!currentViewSessionId) {
			if (parsed.value.type !== 'documentData') return;
			pState.documentViewSessionId = parsed.value.viewSessionId;
		} else if (parsed.value.viewSessionId !== currentViewSessionId) {
			return;
		}
		if (parsed.value.type === 'documentData') {
			if (parsed.value.reloadRequestId === pState.documentViewInitialProjectionRequestId) return;
			if (!pState.documentViewInitialProjectionRequestId) {
				pState.documentViewInitialProjectionRequestId = parsed.value.reloadRequestId;
			}
			const requestIds = pState.documentViewProjectionRequestIds;
			if (requestIds.has(parsed.value.reloadRequestId)) return;
			requestIds.add(parsed.value.reloadRequestId);
			while (requestIds.size > 64) requestIds.delete(requestIds.values().next().value!);
		}
		message = parsed.value;
	}
	}
	const rawIncomingType = String(message.type || '');
	if (rawIncomingType === 'kustoResultAttachmentCommitted'
		|| rawIncomingType === 'kustoResultSelectionResult') {
		const parsed = parseKustoResultAttachmentHostMessage(message);
		if (!parsed.ok) return;
		message = parsed.value;
	}
	const incomingType = String(message.type || '');
	if (pState.documentRuntimeActive === false) {
		if (incomingType === 'kustoPublicationStage') {
			acknowledgeKustoPublication(message, false, 'staged');
			return;
		}
		if (incomingType === 'kustoPublicationCommit' || incomingType === 'kustoPublicationRevoke') {
			acknowledgeKustoPublication(message, false, 'applied');
			return;
		}
		const recoveryMessages = new Set([
			'documentData', 'persistenceMode', 'requestFinalPersist', 'persistDocumentAck',
			'pythonResult', 'pythonError',
			'settingsUpdate', 'sqlComparisonAdmissionRollback', 'sqlComparisonAdmissionComplete',
			'sqlComparisonAdmissionRelease',
		]);
		if (!recoveryMessages.has(incomingType)) {
			const requestId = incomingType === 'requestToolState'
				? message.requestId
				: String(message.requestId || '');
			const invalidRuntime = pState.documentMutationAllowed === false;
			if (incomingType === 'requestToolState' && requestId) {
				const response = createToolStateResponseMessage(
					requestId,
					[],
					invalidRuntime
						? 'This document is invalid and its retained sections are non-executable.'
						: 'This document is still loading and has no executable sections yet.',
				);
				if (response.ok) postMessageToHost(response.value);
			} else if ((incomingType.startsWith('tool') || incomingType === 'updateDevNotes') && requestId) {
				const error = invalidRuntime
					? 'This document is invalid and its retained sections are read-only.'
					: 'This document is still loading and cannot accept mutations yet.';
				postMessageToHost(incomingType === 'updateDevNotes'
					? createDevelopmentNoteMutationWebviewMessage(requestId, false, error)
					: { type: 'toolResponse', requestId, result: { success: false }, error });
			}
			return;
		}
	}
	if (message.type === 'kustoPublicationStage') {
		const publicationId = message.publicationId;
		const deadline = message.publicationDeadline;
		if (deadline < Date.now()) {
			acknowledgeKustoPublication(message, false, 'staged');
			return;
		}
		let payload: Record<string, unknown> = message.payload;
		const connectionsAdmission = admitKustoConnectionsProjectionHostMessage(payload);
		if (connectionsAdmission.recognized) {
			if (!connectionsAdmission.parsed.ok) {
				acknowledgeKustoPublication(message, false, 'staged');
				return;
			}
			const captured = captureKustoConnectionsProjectionHostMessage(connectionsAdmission.parsed.value);
			if (!captured.ok) {
				acknowledgeKustoPublication(message, false, 'staged');
				return;
			}
			payload = captured.value;
		}
		const kustoResultPayload = admitKustoResultPayload(payload);
		if (kustoResultPayload === null) {
			acknowledgeKustoPublication(message, false, 'staged');
			return;
		}
		if (kustoResultPayload) payload = kustoResultPayload;
		const previous = stagedKustoPublications.get(publicationId);
		if (previous) clearTimeout(previous.timer);
		const timer = setTimeout(() => {
			if (!stagedKustoPublications.delete(publicationId)) return;
			postMessageToHost({ type: 'kustoPublicationAck', publicationId, phase: 'applied', accepted: false });
		}, Math.max(0, deadline - Date.now()));
		stagedKustoPublications.set(publicationId, { payload, deadline, timer });
		acknowledgeKustoPublication(message, true, 'staged');
		return;
	}
	if (message.type === 'kustoPublicationCommit') {
		const publicationId = message.publicationId;
		const staged = stagedKustoPublications.get(publicationId);
		stagedKustoPublications.delete(publicationId);
		if (staged) clearTimeout(staged.timer);
		if (!staged || staged.deadline < Date.now()) {
			acknowledgeKustoPublication(message, false, 'applied');
			return;
		}
		let payload = staged.payload as Record<string, unknown>;
		const connectionsAdmission = admitKustoConnectionsProjectionHostMessage(payload);
		if (connectionsAdmission.recognized) {
			if (!connectionsAdmission.parsed.ok) {
				acknowledgeKustoPublication(message, false, 'applied');
				return;
			}
			const captured = captureKustoConnectionsProjectionHostMessage(connectionsAdmission.parsed.value);
			if (!captured.ok) {
				acknowledgeKustoPublication(message, false, 'applied');
				return;
			}
			payload = captured.value;
		}
		const kustoResultPayload = admitKustoResultPayload(payload);
		if (kustoResultPayload === null) {
			acknowledgeKustoPublication(message, false, 'applied');
			return;
		}
		if (kustoResultPayload) payload = kustoResultPayload;
		message = attachKustoPublicationId(payload, publicationId);
	}
	if (message.type === 'kustoPublicationRevoke') {
		const publicationId = message.publicationId;
		const staged = stagedKustoPublications.get(publicationId);
		if (staged) {
			clearTimeout(staged.timer);
			stagedKustoPublications.delete(publicationId);
		}
		acknowledgeKustoPublication(message, completedKustoPublications.get(publicationId)?.accepted === true, 'applied');
		return;
	}
	const messageType = String(message.type || '');
	if (messageType === 'copilotWriteQueryExecuting' && message.executing === false) {
		retireSqlCopilotStart(message.boxId, message.executionId);
	}
	const kustoTerminalAdmission = admitKustoTerminal(message);
	if (kustoTerminalAdmission === 'rejected') {
		acknowledgeKustoPublication(message, false);
		return;
	}
	if (kustoTerminalAdmission === 'retired') {
		emitAdmittedKustoTerminal({
			type: 'queryCancelled',
			engine: 'kusto',
			boxId: message.boxId,
			executionId: message.executionId,
			sectionInstanceId: message.sectionInstanceId,
			targetGeneration: message.targetGeneration,
			connectionId: message.connectionId,
			database: message.database,
			producer: message.producer,
			...(message.copilotRequestId ? { copilotRequestId: message.copilotRequestId } : {}),
			reservationSequence: message.reservationSequence,
			reason: 'retired',
		});
		acknowledgeKustoPublication(message, message.type === 'queryCancelled');
		return;
	}
	const sqlRoute = kustoTerminalAdmission === 'not-kusto' ? routeSqlSectionMessage(message, {
		getSection: __kustoGetSqlSectionElement,
		getDerivedSourceBoxId: boxId => {
			const metadata = optimizationMetadataByBoxId[boxId];
			const sourceBoxId = metadata?.isComparison ? String(metadata.sourceBoxId || '').trim() : '';
			return sourceBoxId && __kustoGetSqlSectionElement(sourceBoxId) ? sourceBoxId : undefined;
		},
		clearSchema: boxId => {
			delete sqlSchemaByBoxId[boxId];
		},
		setSchema: (boxId, schema) => { sqlSchemaByBoxId[boxId] = schema; },
		updateDatabases: (boxId: string, databases: string[], connectionId?: string) => {
			updateSqlDatabaseSelect(boxId, databases, connectionId);
			resolvePendingSqlResultRestores();
		},
		reportDatabasesError: onSqlDatabasesError,
		handleStsResponse,
		handleStsDiagnostics,
		clearPolicyBox: clearSqlPolicyBox,
	}) : 'not-sql';
	if (sqlRoute !== 'not-sql') {
		if (messageType === 'copilotWriteQueryExecuting' && message.executing === true) {
			postMessageToHost({
				type: 'copilotWriteQueryExecutionAck',
				boxId: String(message.boxId || ''), executionId: String(message.executionId || ''),
				accepted: false,
			});
		}
		return;
	}
	if (messageType === 'copilotClarifyingQuestion'
		&& __kustoGetQuerySectionElement(String(message.boxId || ''))) {
		const clarification = parseKustoCopilotClarifyingQuestionMessageFromEnvelope(
			envelope.descriptorSnapshot,
		);
		if (!clarification.ok) return;
		message = clarification.value;
	}
	if (kustoCopilotOutputMessageTypes.has(messageType)) {
		const section = __kustoGetQuerySectionElement(String(message.boxId || ''));
		const admitted = messageType === 'revealSection'
			? section?.admitKustoCopilotConversationOwner?.(message)
			: section?.admitKustoCopilotMessage?.(message, messageType);
		if (section && admitted !== true) {
			acknowledgeKustoPublication(message, false);
			return;
		}
		if (!section && hasKustoCopilotRequestIdentity(message)) {
			acknowledgeKustoPublication(message, false);
			return;
		}
		emitAdmittedKustoCopilotOutput(message);
	}
	switch (messageType) {
		case 'requestArtifactCsvSaveData':
			provideArtifactCsvSaveData(message);
			break;
		case 'cancelArtifactCsvSave':
			cancelArtifactCsvSave(message);
			break;
		case 'settingsUpdate':
			try {
				const altColor = typeof message.alternatingRowColor === 'string' ? message.alternatingRowColor : '';
				if (altColor === 'off') {
					document.documentElement.style.removeProperty('--kw-alt-row-bg');
				} else if (altColor === 'theme' || !altColor) {
					document.documentElement.style.setProperty('--kw-alt-row-bg', 'color-mix(in srgb, var(--vscode-editor-background) 97%, var(--vscode-foreground) 3%)');
				} else {
					document.documentElement.style.setProperty('--kw-alt-row-bg', altColor);
				}
				if (typeof message.htmlPowerBiCompatibilityCheckEnabled === 'boolean') {
					__kustoSetHtmlPowerBiCompatibilityCheckEnabled(message.htmlPowerBiCompatibilityCheckEnabled);
				}
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'controlCommandSyntaxResult': {
			const result = controlCommandSyntaxHostMessage;
			if (!result
				|| __kustoControlCommandDocPending[result.commandLower] !== result.requestId) break;
			__kustoControlCommandDocCache[result.commandLower] = {
				syntax: result.syntax,
				withArgs: result.withArgs,
				fetchedAt: Date.now(),
			};
			delete __kustoControlCommandDocPending[result.commandLower];
			try {
				if (typeof window.__kustoRefreshActiveCaretDocs === 'function') {
					window.__kustoRefreshActiveCaretDocs();
				}
			} catch (e) { console.error('[kusto]', e); }
			break;
		}
		case 'sqlComparisonAdmission':
			try { applySqlComparisonAdmissionDecision(message); } catch (e) { console.error('[kusto]', e); }
			break;
		case 'sqlComparisonAdmissionCommit':
			try { commitSqlComparisonAdmission(message); } catch (e) { console.error('[kusto]', e); }
			break;
		case 'sqlComparisonAdmissionRollback':
			try { rollbackSqlComparisonAdmission(message); } catch (e) { console.error('[kusto]', e); }
			break;
		case 'sqlComparisonAdmissionFinalize':
			try { finalizeSqlComparisonAdmission(message); } catch (e) { console.error('[kusto]', e); }
			break;
		case 'sqlComparisonAdmissionComplete':
			try { completeSqlComparisonAdmission(message); } catch (e) { console.error('[kusto]', e); }
			break;
		case 'sqlComparisonAdmissionRelease':
			try { releaseSqlComparisonAdmissionProof(message); } catch (e) { console.error('[kusto]', e); }
			break;
		case 'ensureComparisonBox':
			try {
				const boxId = String(message.boxId || '');
				const requestId = String(message.requestId || '');
				const query = (typeof message.query === 'string') ? message.query : '';
				if (!boxId || !requestId) {
					break;
				}
				const sourceSection = __kustoGetQuerySectionElement(boxId);
				if (sourceSection && sourceSection.admitKustoCopilotMessage?.(message) !== true) {
					postMessageToHost({
						type: 'comparisonBoxEnsured', engine: 'kusto', requestId, sourceBoxId: boxId, comparisonBoxId: '',
						...(hasKustoCopilotRequestIdentity(message) ? {
							boxId: message.boxId,
							copilotRequestId: message.copilotRequestId,
							sectionInstanceId: message.sectionInstanceId,
							targetGeneration: message.targetGeneration,
						} : {}),
					});
					break;
				}
				let comparisonBoxId = '';
				if (message.engine === 'sql') {
					let comparisonAdmissionMode: 'created' | 'reused' | undefined;
					const sourceSql = __kustoGetSqlSectionElement(boxId);
					if (optimizationMetadataByBoxId[boxId]?.isComparison === true) {
						postMessageToHost({
							type: 'comparisonBoxEnsured', engine: 'sql', requestId,
							sourceBoxId: boxId, comparisonBoxId: '',
						});
						break;
					}
					const sourceSectionInstanceId = String(message.sourceSectionInstanceId || '').trim();
					const sourceTargetGeneration = Number(message.sourceTargetGeneration);
					const sourceIdentityMatches = !!sourceSql && !!sourceSectionInstanceId
						&& sourceSql.sqlSession?.instanceId === sourceSectionInstanceId
						&& Number.isSafeInteger(sourceTargetGeneration)
						&& sourceSql.sqlSession?.targetGeneration === sourceTargetGeneration;
					if (sourceIdentityMatches) {
						const comparisonIds = new Set<string>();
						const sourceMetadata = optimizationMetadataByBoxId[boxId];
						if (sourceMetadata?.comparisonBoxId) comparisonIds.add(String(sourceMetadata.comparisonBoxId));
						for (const [candidateId, metadata] of Object.entries(optimizationMetadataByBoxId || {})) {
							if ((metadata as any)?.isComparison && String((metadata as any).sourceBoxId || '') === boxId) {
								comparisonIds.add(candidateId);
							}
						}
						let comparisonCreationAllowed = comparisonIds.size === 0;
						if (comparisonIds.size === 1) {
							const existingId = [...comparisonIds][0];
							const existingSql = __kustoGetSqlSectionElement(existingId);
							const sameTarget = existingSql
								&& String(existingSql.getConnectionId?.() || '') === String(sourceSql.getConnectionId?.() || '')
								&& String(existingSql.getDatabase?.() || '').toLowerCase()
									=== String(sourceSql.getDatabase?.() || '').toLowerCase();
							if (sameTarget && !pendingSqlComparisonAdmissionRequestByBoxId.has(existingId)) {
								comparisonBoxId = existingId;
								comparisonAdmissionMode = 'reused';
							} else if (!document.getElementById(existingId)) {
								removeSqlBox(existingId);
								comparisonCreationAllowed = true;
							}
						}
						if (!comparisonBoxId && comparisonCreationAllowed) {
							const comparisonId = `sql_cmp_${requestId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
							const creation = createSectionWithCapabilities('sql', {
								id: comparisonId,
								name: 'Optimized SQL',
								query,
								afterBoxId: boxId,
								comparisonSourceBoxId: boxId,
								comparisonAdmissionRequestId: requestId,
								serverUrl: String(sourceSql.getServerUrl?.() || '') || undefined,
								connectionIdHint: String(sourceSql.getConnectionId?.() || '') || undefined,
								database: String(sourceSql.getDatabase?.() || '') || undefined,
							});
							if (creation.ok) {
								comparisonBoxId = creation.sectionId;
								comparisonAdmissionMode = 'created';
							}
						}
						if (comparisonBoxId && comparisonAdmissionMode
							&& !stageSqlComparisonAdmission(requestId, boxId, comparisonBoxId, query, comparisonAdmissionMode)) {
							if (comparisonAdmissionMode === 'created') removeSqlBox(comparisonBoxId);
							comparisonBoxId = '';
						}
						if (comparisonBoxId) {
							markSectionAgentTouched(comparisonBoxId);
						}
					}
				} else {
					try {
						comparisonBoxId = await optimizeQueryWithCopilot(boxId, query, { skipExecute: true, agentTouched: true });
					} catch (e) { console.error('[kusto]', e); }
				}
				try {
					const comparisonSection = __kustoGetQuerySectionElement(comparisonBoxId);
					const comparisonSqlSection = __kustoGetSqlSectionElement(comparisonBoxId);
					const lifecycle = comparisonSection?.getSchemaLifecycleIdentity?.();
					const lifecycleTarget = kustoEditorSchemaCoordinator.getTarget(comparisonBoxId);
					const visibleConnectionId = String(comparisonSection?.getConnectionId?.() || '').trim();
					const visibleDatabase = String(comparisonSection?.getDatabase?.() || '').trim();
					const targetConnectionId = String(lifecycleTarget?.connectionId || '').trim();
					const targetDatabase = String(lifecycleTarget?.database || '').trim();
					const kustoTargetIsCoherent = !!comparisonBoxId && !!lifecycle
						&& !!targetConnectionId && !!targetDatabase
						&& visibleConnectionId === targetConnectionId
						&& visibleDatabase.toLowerCase() === targetDatabase.toLowerCase();
					postMessageToHost({
						type: 'comparisonBoxEnsured',
						engine: message.engine === 'sql' ? 'sql' : 'kusto',
						requestId,
						sourceBoxId: boxId,
						comparisonBoxId: String(comparisonBoxId || ''),
						...(message.engine === 'sql' ? {
							sourceSectionInstanceId: String(message.sourceSectionInstanceId || ''),
							sourceTargetGeneration: Number(message.sourceTargetGeneration),
							comparisonSectionInstanceId: String(comparisonSqlSection?.sqlSession?.instanceId || ''),
							comparisonTargetGeneration: Number(comparisonSqlSection?.sqlSession?.targetGeneration),
							comparisonConnectionId: String(comparisonSqlSection?.getConnectionId?.() || ''),
							comparisonDatabase: String(comparisonSqlSection?.getDatabase?.() || ''),
						} : {}),
						...(hasKustoCopilotRequestIdentity(message) ? {
							boxId: message.boxId,
							copilotRequestId: message.copilotRequestId,
							sectionInstanceId: message.sectionInstanceId,
							targetGeneration: message.targetGeneration,
						} : {}),
						...(kustoTargetIsCoherent ? {
							kustoTarget: {
								engine: 'kusto' as const,
								boxId: comparisonBoxId,
								sectionInstanceId: lifecycle.sectionInstanceId,
								targetGeneration: lifecycle.targetGeneration,
								connectionId: targetConnectionId,
								database: targetDatabase,
								...(Number.isSafeInteger(lifecycleTarget?.connectionRevision)
									? { connectionRevision: lifecycleTarget?.connectionRevision }
									: {}),
								...(String(lifecycleTarget?.connectionIdentityKey || '').trim()
									? { connectionIdentityKey: lifecycleTarget?.connectionIdentityKey }
									: {}),
							},
						} : {}),
					});
				} catch (e) { console.error('[kusto]', e); }
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'persistenceMode':
				try {
					pState.isSessionFile = !!message.isSessionFile;
					try {
						if (typeof message.documentUri === 'string') {
							pState.documentUri = String(message.documentUri);
						}
					} catch (e) { console.error('[kusto]', e); }
						try {
							applyDocumentCapabilityProjection(message);
							try {
								if (document && document.body && document.body.dataset) {
									document.body.dataset.kustoDocumentKind = pState.documentKind;
								}
							} catch (e) { console.error('[kusto]', e); }
							if (typeof message.compatibilitySingleKind === 'string') {
								pState.compatibilitySingleKind = String(message.compatibilitySingleKind);
							}
							if (typeof message.compatibilityTooltip === 'string') {
								pState.compatibilityTooltip = String(message.compatibilityTooltip);
							}
							if (typeof message.firstSectionPinned === 'boolean') {
								pState.firstSectionPinned = message.firstSectionPinned;
							}
							if (typeof message.documentMutationAllowed === 'boolean') {
								pState.documentMutationAllowed = message.documentMutationAllowed;
							}
							if (typeof message.htmlPowerBiCompatibilityCheckEnabled === 'boolean') {
								__kustoSetHtmlPowerBiCompatibilityCheckEnabled(message.htmlPowerBiCompatibilityCheckEnabled);
							}
						} catch (e) { console.error('[kusto]', e); }
						__kustoSetCompatibilityMode(!!message.compatibilityMode);
						try {
							__kustoApplyDocumentCapabilities();
						} catch (e) { console.error('[kusto]', e); }
				} catch (e) { console.error('[kusto]', e); }
				break;
		case 'upgradedToKqlx':
			// The extension host has upgraded the file format from .kql/.csl to .kqlx.
			// Exit compatibility mode and perform the originally-requested add.
			try {
				__kustoSetCompatibilityMode(false);
			} catch (e) { console.error('[kusto]', e); }
			try {
				const k = message && message.addKind ? String(message.addKind) : '';
				if (k) {
					__kustoRequestAddSection(k);
				}
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'requestFinalPersist':
			flushCompatibilityPersist(String(message.requestId || ''), String(message.reason || 'host-flush'));
			break;
		case 'persistDocumentAck':
			acknowledgePersistDocument(message.snapshotId, message.editRevision, message.orderedSectionIds);
			break;
		case 'markdownDocumentCommandResult': {
			const result = handleHostOwnedMarkdownCommandResult(message);
			if (result.handled && !result.accepted && result.projection) {
				reconcileHostOwnedChartProjection(
					result.projection.chartSections ?? [],
					result.projection.orderedSectionIds,
				);
				reconcileHostOwnedMarkdownProjection(
					result.projection.markdownSections,
					result.projection.orderedSectionIds,
				);
				reconcileHostOwnedHtmlProjection(
					result.projection.htmlSections ?? [],
					result.projection.orderedSectionIds,
				);
				reconcileHostOwnedPythonProjection(
					result.projection.pythonSections ?? [],
					result.projection.orderedSectionIds,
				);
				reconcileHostOwnedTransformationProjection(
					result.projection.transformationSections ?? [],
					result.projection.orderedSectionIds,
				);
				reconcileHostOwnedUrlProjection(
					result.projection.urlSections ?? [],
					result.projection.orderedSectionIds,
				);
				reconcileProjectedSectionOrder(result.projection.orderedSectionIds);
			}
			break;
		}
		case 'requestMarkdownCommandBarrier': {
			const requestId = String(message.requestId || '').trim();
			if (!requestId) break;
			const sourceGeneration = Number(message.sourceGeneration);
			const accepted = sourceGeneration === pState.markdownSourceGeneration
				&& await waitForHostOwnedMarkdownCommands();
			postMessageToHost({
				type: 'markdownDocumentCommandBarrierResult',
				requestId,
				sourceGeneration: pState.markdownSourceGeneration,
				documentRevision: pState.markdownDocumentRevision,
				accepted: !isHostOwnedMarkdownDocument() || accepted,
			});
			break;
		}
		case 'enabledKqlxSidecar':
			// The extension host has enabled a companion .kqlx metadata file for a .kql/.csl document.
			// Exit compatibility mode and perform the originally-requested add.
			try {
				__kustoSetCompatibilityMode(false);
			} catch (e) { console.error('[kusto]', e); }
			try {
				const k = message && message.addKind ? String(message.addKind) : '';
				if (k) {
					__kustoRequestAddSection(k);
				}
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'enabledSqlSidecar':
			// The extension host has enabled a companion .sql.json metadata file for a .sql document.
			// Exit compatibility mode and perform the originally-requested add.
			try {
				__kustoSetCompatibilityMode(false);
			} catch (e) { console.error('[kusto]', e); }
			try {
				const k = message && message.addKind ? String(message.addKind) : '';
				if (k) {
					__kustoRequestAddSection(k);
				}
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'connectionsData':
			if (applyingConnectionsData) {
				acknowledgeKustoPublication(message, false);
				break;
			}
			applyingConnectionsData = true;
			try {
				const revision = message.connectionsRevision;
				if (revision !== undefined && revision < latestConnectionsRevision) {
					acknowledgeKustoPublication(message, false);
					break;
				}
				const applicationSnapshot = captureKustoConnectionsApplicationSnapshot();
				const isolated = !!(window as any).__e2eIsolatedKustoConnections;
				const previousAccountPartitionByConnectionId = new Map(
					connections.map(connection => [
						String(connection?.id || ''),
						String(connection?.accountPartition || ''),
					]),
				);
				const incomingConnections = isolated ? [] : message.connections;
				const supplementalKeyspaceChange = classifyKustoConnectionKeyspaceChange(connections, incomingConnections);
				const accountPartitionChangedConnectionIds = new Set<string>();
				for (const connection of incomingConnections) {
					const connectionId = String(connection?.id || '').trim();
					if (!connectionId || !previousAccountPartitionByConnectionId.has(connectionId)) continue;
					if (previousAccountPartitionByConnectionId.get(connectionId)
						!== String(connection?.accountPartition || '')) {
						accountPartitionChangedConnectionIds.add(connectionId);
					}
				}
				const policyApplication = beginKustoLeaveNoTracePolicyApplication();
				try {
					(window as any).__kustoAccounts = Array.isArray(message.accounts) ? message.accounts : [];
					setConnections(incomingConnections);
					window.connections = connections;
					setLastConnectionId(isolated ? null : message.lastConnectionId ?? null);
					setLastDatabase(isolated ? null : message.lastDatabase ?? null);
					replaceKustoCachedDatabases(isolated ? {} : message.cachedDatabases || {});
					setKustoFavorites(isolated ? [] : message.favorites || []);
					setLeaveNoTraceClusters(isolated ? [] : message.leaveNoTraceClusters || []);
					if (!isolated) {
						window.__kustoDevNotesEnabled = !!message.devNotesEnabled;
						pState.copilotChatFirstTimeDismissed = !!message.copilotChatFirstTimeDismissed;
					}
					applyEditingPreferencesData({
						type: 'editingPreferencesData',
						revision: typeof message.editingPreferencesRevision === 'number'
							? message.editingPreferencesRevision
							: 0,
						caretDocsEnabled: typeof message.caretDocsEnabled === 'boolean'
							? message.caretDocsEnabled
							: true,
						caretDocsEnabledUserSet: !!message.caretDocsEnabledUserSet,
						autoTriggerAutocompleteEnabled:
							typeof message.autoTriggerAutocompleteEnabled === 'boolean'
								? message.autoTriggerAutocompleteEnabled
								: true,
						autoTriggerAutocompleteEnabledUserSet:
							!!message.autoTriggerAutocompleteEnabledUserSet,
						copilotInlineCompletionsEnabled:
							typeof message.copilotInlineCompletionsEnabled === 'boolean'
								? message.copilotInlineCompletionsEnabled
								: true,
						copilotInlineCompletionsEnabledUserSet:
							!!message.copilotInlineCompletionsEnabledUserSet,
					});
					applyKustoLeaveNoTracePolicy(
						isolated ? [] : message.leaveNoTraceClusters || [],
						isolated ? false : message.leaveNoTraceGloballyBlocked === true,
						isolated ? undefined : message.policyRequestId,
						isolated ? {} : message.leaveNoTraceRevisions || {},
					);
					policyApplication.commit();
				} catch (error) {
					policyApplication.rollback();
					try {
						restoreKustoConnectionsApplicationSnapshot(applicationSnapshot);
					} catch (restoreError) {
						console.error('[kusto]', restoreError);
					}
					console.error('[kusto]', error);
					acknowledgeKustoPublication(message, false);
					break;
				}
				try { updateConnectionSelects(); } catch (error) { console.error('[kusto]', error); }
				if (!isolated) {
					try { resolvePendingKustoResultRestores(); } catch (error) { console.error('[kusto]', error); }
				}

				if (!isolated) {
					if (accountPartitionChangedConnectionIds.size > 0) {
						try {
							const sectionIds = new Set([
								...kustoEditorSchemaCoordinator.getSectionIds(),
								...Object.keys(queryEditors || {}),
							]);
							for (const boxId of sectionIds) {
								const connectionId = String(__kustoGetConnectionId(boxId) || '').trim();
								if (!accountPartitionChangedConnectionIds.has(connectionId)) continue;
								delete schemaRequestTokenByBoxId[boxId];
								delete databaseRequestTokenByBoxId[boxId];
								clearKustoEditorSchema(boxId);
								clearKustoSchemaMetadata(boxId);
								schemaFetchInFlightByBoxId[boxId] = false;
								lastSchemaRequestAtByBoxId[boxId] = 0;
								requireSchemaWorkerApply(boxId);
								requestKustoSchemaApplyForBox(boxId, false);
							}
						} catch (error) { console.error('[kusto]', error); }
					}
					if (kustoAuthIdentityInvalidated) {
						try {
							const sectionIds = new Set([
								...kustoEditorSchemaCoordinator.getSectionIds(),
								...Object.keys(queryEditors || {}),
							]);
							for (const boxId of sectionIds) {
								requireSchemaWorkerApply(boxId);
								requestKustoSchemaApplyForBox(boxId, false);
							}
							kustoAuthIdentityInvalidated = false;
						} catch (error) { console.error('[kusto]', error); }
					}
					if (supplementalKeyspaceChange.changed) {
						try {
							resyncKustoSupplementalReferencesForConnections({
								invalidateWorker: supplementalKeyspaceChange.invalidated,
							});
						} catch (error) { console.error('[kusto]', error); }
					}
					try { __kustoUpdateFavoritesUiForAllBoxes(); } catch (error) { console.error('[kusto]', error); }
					try { __kustoTryAutoEnterFavoritesModeForAllBoxes(); } catch (error) { console.error('[kusto]', error); }
					try { __kustoMaybeDefaultFirstBoxToFavoritesMode(); } catch (error) { console.error('[kusto]', error); }
					try { __kustoOnConnectionsUpdated(); } catch (error) { console.error('[kusto]', error); }
					try { __kustoScheduleLocalSchemaPrewarm('connections-data'); } catch (error) { console.error('[kusto]', error); }
				}
				acknowledgeKustoPublication(message, true);
				if (revision !== undefined) latestConnectionsRevision = revision;
			} finally {
				applyingConnectionsData = false;
			}
			break;
		case 'kustoAuthIdentityChanged':
			try {
				kustoAuthIdentityInvalidated = true;
				const changedConnectionIds = new Set<string>(
					(Array.isArray(message.connectionIds) ? message.connectionIds : [])
						.map((connectionId: unknown) => String(connectionId || '').trim())
						.filter(Boolean),
				);
				const affectsAllConnections = changedConnectionIds.size === 0;
				const syntheticOwnerChanged = (metadata: { connectionId: string }) => affectsAllConnections || changedConnectionIds.has(metadata.connectionId);
				kustoSyntheticSchemaRequests.cancelWhere(syntheticOwnerChanged, new Error('Kusto schema request invalidated by authentication change.'));
				kustoSyntheticDatabaseRequests.cancelWhere(syntheticOwnerChanged, new Error('Kusto database request invalidated by authentication change.'));
				const sectionIds = new Set([
					...kustoEditorSchemaCoordinator.getSectionIds(),
					...Object.keys(queryEditors || {}),
				]);
				for (const boxId of sectionIds) {
					const connectionId = String(__kustoGetConnectionId(boxId) || '').trim();
					if (!affectsAllConnections && !changedConnectionIds.has(connectionId)) continue;
					const section = __kustoGetQuerySectionElement(boxId);
					delete schemaRequestTokenByBoxId[boxId];
					delete databaseRequestTokenByBoxId[boxId];
					if (typeof section?.invalidateSchemaLifecycleTarget === 'function') section.invalidateSchemaLifecycleTarget();
					else kustoEditorSchemaCoordinator.invalidateCurrentTarget(boxId);
					clearKustoEditorSchema(boxId);
					clearKustoSchemaMetadata(boxId);
					setKustoPreparationIdle(boxId);
					schemaFetchInFlightByBoxId[boxId] = false;
					lastSchemaRequestAtByBoxId[boxId] = 0;
					requireSchemaWorkerApply(boxId);
					clearResultsState(boxId);
					delete pState.queryResultJsonByBoxId[boxId];
					delete pState.resultArtifactByBoxId[boxId];
					if (typeof section?.setDatabasesLoading === 'function') section.setDatabasesLoading(false);
					if (typeof section?.setRefreshLoading === 'function') section.setRefreshLoading(false);
					if (typeof section?.clearResults === 'function') section.clearResults();
					const chat = typeof section?.getCopilotChatEl === 'function' ? section.getCopilotChatEl() : null;
					if (typeof chat?.clearConversation === 'function') chat.clearConversation();
				}
				for (const connectionId of affectsAllConnections ? Object.keys(cachedDatabases) : changedConnectionIds) {
					delete cachedDatabases[connectionId];
				}
				if (affectsAllConnections) {
					for (const key of Object.keys(schemaByConnDb)) delete schemaByConnDb[key];
					for (const key of Object.keys(schemaMetaByConnDb)) delete schemaMetaByConnDb[key];
					clearAllKustoEditorSchemas();
					clearAllKustoSchemaMetadata();
				} else {
					for (const key of Object.keys(schemaByConnDb)) {
						const metadataConnectionId = String(schemaMetaByConnDb[key]?.connectionId || '').trim();
						const encodedKeyMatch = [...changedConnectionIds].some(connectionId => key.startsWith(`v1|${encodeURIComponent(connectionId)}|`));
						if (!changedConnectionIds.has(metadataConnectionId) && !encodedKeyMatch) continue;
						delete schemaByConnDb[key];
						delete schemaMetaByConnDb[key];
					}
				}
				invalidateKustoSchemaIdentityState();
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'kustoExecutionStarted': {
			const boxId = message.boxId;
			const section = __kustoGetQuerySectionElement(boxId);
			const lifecycle = section?.getSchemaLifecycleIdentity?.();
			const liveQuery = String(
				queryEditors?.[boxId]?.getValue?.()
				?? section?.getCopilotEditorValue?.()
				?? section?.serialize?.()?.query
				?? '',
			);
			const targetMatches = canAdmitKustoHostExecutionStart(String(boxId || ''))
				&& !!section
				&& liveQuery === String(message.query || '')
				&& lifecycle?.sectionInstanceId === message.sectionInstanceId
				&& lifecycle?.targetGeneration === message.targetGeneration
				&& String(section.getConnectionId?.() || '') === message.connectionId
				&& String(section.getDatabase?.() || '').toLowerCase() === message.database.toLowerCase();
			const activeExecution = section?.getActiveExecution?.();
			const predecessorMatches = !activeExecution
				|| activeExecution.executionId === message.expectedPredecessorExecutionId;
			const requiresComparisonBinding = message.producer === 'comparison'
				&& message.boxId === message.comparisonRun.comparisonBoxId;
			const comparisonBinding = targetMatches && predecessorMatches && requiresComparisonBinding
				? beginComparisonSourceBinding(message)
				: undefined;
			const comparisonBindingAccepted = !requiresComparisonBinding || !!comparisonBinding;
			let accepted = false;
			try {
				accepted = targetMatches && predecessorMatches && comparisonBindingAccepted
					&& section.beginQueryExecution?.(
						message.executionId, message.producer, message.copilotRequestId,
						message.expectedPredecessorExecutionId ?? '',
						message.comparisonRun,
					) === true;
			} catch (error) {
				console.error('[kusto]', error);
			}
			if (comparisonBinding) {
				if (accepted) commitComparisonSourceBinding(comparisonBinding);
				else rollbackComparisonSourceBinding(comparisonBinding);
			}
			const acknowledgement = createKustoExecutionStartedAckMessage(
				message.boxId,
				message.executionId,
				message.sectionInstanceId,
				message.targetGeneration,
				accepted,
			);
			if (acknowledgement.ok) postMessageToHost(acknowledgement.value);
			if (accepted) {
				try { __kustoClearStoredQueryResult(boxId); } catch (error) { console.error('[kusto]', error); }
				try { schedulePersist('kusto-execution-started', true); } catch (error) { console.error('[kusto]', error); }
				window.dispatchEvent(new CustomEvent(ADMITTED_KUSTO_EXECUTION_STARTED_EVENT, { detail: message }));
			}
			break;
		}
		case 'kustoCopilotIdentityChanged':
			try {
				const boxId = String(message.boxId || '');
				const section = __kustoGetQuerySectionElement(boxId);
				section?.retireKustoCopilotConversationOwner?.(message);
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'editingPreferencesData':
			applyEditingPreferencesData(message);
			break;
		case 'updateDevNotes': {
			const mutationAllowed = isDocumentMutationAllowed();
			const hostOwned = isHostOwnedDevelopmentNoteDocument();
			const metadataFreeCompanion = !pState.compatibilityMode
				&& !hostOwned
				&& (pState.documentKind === 'kql' || pState.documentKind === 'sql');
			if (!mutationAllowed || pState.compatibilityMode || (!hostOwned && !metadataFreeCompanion)) {
				postMessageToHost(createDevelopmentNoteMutationWebviewMessage(
					message.requestId,
					false,
					!mutationAllowed
						? 'This document is read-only and cannot accept development notes.'
						: pState.compatibilityMode
							? 'Development notes require a companion metadata file. Upgrade this compatibility document first.'
							: 'Development notes are unavailable in the current document host.',
				));
				break;
			}
			let mutationError = '';
			let mutated = false;
			let commandSettlement: Promise<boolean> | undefined;
			try {
				if (metadataFreeCompanion) {
					const sections = pState.metadataFreeDevelopmentNoteSections;
					const action = message.action;
					const parseEntry = () => parseDevelopmentNoteSection({
						id: 'devnotes_input', type: 'devnotes', entries: [message.entry],
					});
					if (action === 'add') {
						if (!message.entry || typeof message.entry !== 'object') {
							mutationError = 'A development note entry is required.';
						} else {
							const parsed = parseEntry();
							if (!parsed.ok) mutationError = parsed.error;
							else {
								const entry = parsed.value.entries![0];
								const duplicate = sections.some((section: any) =>
									Array.isArray(section?.entries)
									&& section.entries.some((candidate: any) => String(candidate?.id || '') === entry.id));
								if (duplicate) mutationError = `Development note "${entry.id}" already exists.`;
								else {
									let owner = sections.find((section: any) => section?.type === 'devnotes');
									if (!owner) {
										const baseId = `devnotes_${Date.now()}`;
										let sectionId = baseId;
										for (let suffix = 2; document.getElementById(sectionId)
											|| sections.some((section: any) => String(section?.id || '') === sectionId); suffix++) {
											sectionId = `${baseId}_${suffix}`;
										}
										owner = { id: sectionId, type: 'devnotes', entries: [] };
										sections.push(owner);
									}
									if (!Array.isArray(owner.entries)) owner.entries = [];
									owner.entries.push(entry);
									mutated = true;
								}
							}
						}
					} else if (action === 'supersede') {
						const supersededId = message.supersededId.trim();
						if (!supersededId || !message.entry || typeof message.entry !== 'object') {
							mutationError = 'A superseded note ID and replacement entry are required.';
						} else {
							const parsed = parseEntry();
							if (!parsed.ok) mutationError = parsed.error;
							else {
								const replacement = parsed.value.entries![0];
								const matches: Array<{ section: any; index: number }> = [];
								for (const section of sections) {
									if (!Array.isArray(section?.entries)) continue;
									section.entries.forEach((entry: any, index: number) => {
										if (String(entry?.id || '') === supersededId) matches.push({ section, index });
									});
								}
								const duplicateReplacement = sections.some((section: any) =>
									Array.isArray(section?.entries) && section.entries.some((entry: any) =>
										String(entry?.id || '') === replacement.id
										&& String(entry?.id || '') !== supersededId));
								if (matches.length !== 1) {
									mutationError = `Development note "${supersededId}" was not found uniquely.`;
								} else if (duplicateReplacement) {
									mutationError = `Development note "${replacement.id}" already exists.`;
								} else {
									matches[0].section.entries.splice(matches[0].index, 1, replacement);
									mutated = true;
								}
							}
						}
					} else if (action === 'remove') {
						const noteId = message.noteId;
						const matches: Array<{ section: any; index: number }> = [];
						if (noteId) {
							for (const section of sections) {
								if (!Array.isArray(section?.entries)) continue;
								section.entries.forEach((entry: any, index: number) => {
									if (String(entry?.id || '') === noteId) matches.push({ section, index });
								});
							}
						}
						if (matches.length === 1) {
							matches[0].section.entries.splice(matches[0].index, 1);
							mutated = true;
						} else mutationError = `Development note "${noteId}" was not found uniquely.`;
					} else {
						mutationError = `Unknown development note action "${action}".`;
					}
					if (mutated) schedulePersist('devnotes-update');
				} else {
				const sections = [...getOptimisticHostOwnedDevelopmentNoteSections()];
				const action = message.action;
				if (action === 'add') {
					if (!message.entry || typeof message.entry !== 'object') {
						mutationError = 'A development note entry is required.';
					} else {
						const parsed = parseDevelopmentNoteSection({
							id: 'devnotes_input', type: 'devnotes', entries: [message.entry],
						});
						if (!parsed.ok) mutationError = parsed.error;
						else {
							const entry = parsed.value.entries![0];
							const entryId = entry.id.trim();
							const duplicate = entryId && sections.some(section =>
								(section.entries ?? []).some(candidate => candidate.id === entryId));
							if (duplicate) mutationError = `Development note "${entryId}" already exists.`;
							else if (sections.length > 0) {
								const owner = sections[0];
								commandSettlement = requestHostOwnedDevelopmentNotePatch({
									...owner, entries: [...(owner.entries ?? []), entry],
								});
							} else {
								const existingIds = new Set(getOptimisticHostOwnedDocumentSectionOrder());
								const baseId = `devnotes_${Date.now()}`;
								let sectionId = baseId;
								for (let suffix = 2; existingIds.has(sectionId); suffix++) {
									sectionId = `${baseId}_${suffix}`;
								}
								commandSettlement = requestHostOwnedDevelopmentNoteAdd({
									id: sectionId, type: 'devnotes', entries: [entry],
								});
							}
						}
					}
				} else if (action === 'supersede') {
					const supersededId = message.supersededId.trim();
					if (!supersededId || !message.entry || typeof message.entry !== 'object') {
						mutationError = 'A superseded note ID and replacement entry are required.';
					} else {
						const parsed = parseDevelopmentNoteSection({
							id: 'devnotes_input', type: 'devnotes', entries: [message.entry],
						});
						if (!parsed.ok) mutationError = parsed.error;
						else {
							const replacement = parsed.value.entries![0];
							const matches: Array<{ sectionIndex: number; entryIndex: number }> = [];
							sections.forEach((section, sectionIndex) => {
								(section.entries ?? []).forEach((entry, entryIndex) => {
									if (entry.id === supersededId) matches.push({ sectionIndex, entryIndex });
								});
							});
							const replacementId = replacement.id.trim();
							const duplicateReplacement = replacementId && sections.some(section =>
								(section.entries ?? []).some(entry =>
									entry.id === replacementId && entry.id !== supersededId));
							if (matches.length !== 1) {
								mutationError = `Development note "${supersededId}" was not found uniquely.`;
							} else if (duplicateReplacement) {
								mutationError = `Development note "${replacementId}" already exists.`;
							} else {
								const match = matches[0];
								const owner = sections[match.sectionIndex];
								const entries = [...(owner.entries ?? [])];
								entries.splice(match.entryIndex, 1, replacement);
								commandSettlement = requestHostOwnedDevelopmentNotePatch({ ...owner, entries });
							}
						}
					}
				} else if (action === 'remove') {
					const noteId = message.noteId;
					const matches: Array<{ sectionIndex: number; entryIndex: number }> = [];
					if (noteId) {
						sections.forEach((section, sectionIndex) => {
							(section.entries ?? []).forEach((entry, entryIndex) => {
								if (entry.id === noteId) matches.push({ sectionIndex, entryIndex });
							});
						});
					}
					if (matches.length === 1) {
						const match = matches[0];
						const owner = sections[match.sectionIndex];
						const entries = [...(owner.entries ?? [])];
						entries.splice(match.entryIndex, 1);
						commandSettlement = requestHostOwnedDevelopmentNotePatch({ ...owner, entries });
					} else mutationError = `Development note "${noteId}" was not found uniquely.`;
				} else {
					mutationError = `Unknown development note action "${action}".`;
				}
				if (commandSettlement) {
					mutated = await commandSettlement;
					if (!mutated) mutationError = 'The development note update was not acknowledged by the document host.';
				} else if (!mutationError) {
					mutationError = 'The development note update could not enter the document command queue.';
				}
				}
			} catch (e) {
				console.error('[kusto]', e);
				mutationError = e instanceof Error ? e.message : String(e);
			}
			// Respond to extension host if a requestId was provided
			try {
				postMessageToHost(createDevelopmentNoteMutationWebviewMessage(
					message.requestId,
					mutated,
					mutated ? undefined : mutationError || 'Development note update was rejected.',
				));
			} catch (e) { console.error('[kusto]', e); }
			break;
		}
		case 'favoritesData':
			setKustoFavorites(Array.isArray(message.favorites) ? message.favorites : []);
			try {
				__kustoUpdateFavoritesUiForAllBoxes();
			} catch (e) { console.error('[kusto]', e); }
			// If this update came from an "Add favorite" action in a specific box, automatically
			// switch that box into Favorites mode.
			try {
				const boxId = message && typeof message.boxId === 'string' ? message.boxId : '';
				if (boxId && Array.isArray(kustoFavorites) && kustoFavorites.length > 0) {
					try {
						__kustoTryAutoEnterFavoritesModeForAllBoxes();
					} catch (e) { console.error('[kusto]', e); }
					try {
						__kustoMaybeDefaultFirstBoxToFavoritesMode();
					} catch (e) { console.error('[kusto]', e); }
					if (typeof window.__kustoEnterFavoritesModeForBox === 'function') {
						window.__kustoEnterFavoritesModeForBox(boxId);
					}
				}
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'confirmRemoveFavoriteResult':
			try {
				if (typeof window.__kustoOnConfirmRemoveFavoriteResult === 'function') {
					window.__kustoOnConfirmRemoveFavoriteResult(message);
				}
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'documentData':
			if (message.expectedEditRevision !== undefined
				&& Number(message.expectedEditRevision) !== pState.documentEditRevision) {
				acknowledgeDocumentReconciliation(message.requestId, false);
				if (message.reloadRequestId) {
					postMessageToHost({
						type: 'documentReloadResult', requestId: String(message.reloadRequestId),
						applied: false, editRevision: pState.documentEditRevision,
						markdownCommandBarrierSupported: true,
					});
				}
				break;
			}
			sqlPolicyBlockedBoxIds.clear();
			perfMark('webview.message.documentData.received', {
				ok: !!message.ok,
				forceReload: !!message.forceReload,
				sections: Array.isArray((message as any).state?.sections) ? (message as any).state.sections.length : 0,
				documentKind: (message as any).documentKind || '',
			});
			traceFileOpen('message.documentData.received', {
				ok: !!message.ok,
				forceReload: !!message.forceReload,
				sections: Array.isArray((message as any).state?.sections) ? (message as any).state.sections.length : 0,
				documentKind: (message as any).documentKind || '',
			});
			let applied = false;
			try {
				{
					clearAllSectionAgentTouched();
					applied = handleDocumentDataMessage(message);
				}
				traceFileOpen('message.documentData.handled');
			} catch (e) { console.error('[kusto]', e); }
			if (message.reloadRequestId) {
				postMessageToHost({
					type: 'documentReloadResult', requestId: String(message.reloadRequestId),
					applied, editRevision: pState.documentEditRevision,
					markdownCommandBarrierSupported: true,
				});
			}
			acknowledgeDocumentReconciliation(message.requestId, applied);
			if (applied
				&& message.channel === COMPATIBILITY_PERSISTENCE_CHANNEL
				&& message.requestSource === 'webview') {
				const requestId = String(message.requestId);
				pState.compatibilityPersistenceDocumentRequestIds.delete(requestId);
				pState.compatibilityPersistenceAppliedDocumentRequests.set(
					requestId,
					compatibilityProjectionFingerprint ?? getCompatibilityProjectionFingerprint(message),
				);
				while (pState.compatibilityPersistenceAppliedDocumentRequests.size > 64) {
					pState.compatibilityPersistenceAppliedDocumentRequests.delete(
						pState.compatibilityPersistenceAppliedDocumentRequests.keys().next().value!,
					);
				}
			}
			if (applied) finalizeDocumentDefaultsAfterAcknowledgement(message.state);
			break;
		case 'revealTextRange':
			try {
				if (typeof window.__kustoRevealTextRangeFromHost === 'function') {
					window.__kustoRevealTextRangeFromHost(message);
				}
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'resolveResourceUriResult':
			try {
				if (!resourceUriHostMessage) break;
				const reqId = resourceUriHostMessage.requestId;
				const r = __kustoResourceUriRequestResolversById && __kustoResourceUriRequestResolversById[reqId];
				if (r && typeof r.resolve === 'function') {
					const uri = resourceUriHostMessage.ok ? resourceUriHostMessage.uri : null;
					try { r.resolve(uri); } catch (e) { console.error('[kusto]', e); }
					try { delete __kustoResourceUriRequestResolversById[reqId]; } catch (e) { console.error('[kusto]', e); }
				}
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'kqlLanguageResponse':
			try {
				if (!kqlLanguageHostMessage) break;
				const reqId = kqlLanguageHostMessage.requestId;
				const r = __kustoKqlLanguageRequestResolversById && __kustoKqlLanguageRequestResolversById[reqId];
				if (r && typeof r.resolve === 'function'
					&& isKqlLanguageResponseForMethod(kqlLanguageHostMessage, r.method)) {
					try {
						r.resolve(kqlLanguageHostMessage.ok ? kqlLanguageHostMessage.result : null);
					} catch (e) { console.error('[kusto]', e); }
					try { delete __kustoKqlLanguageRequestResolversById[reqId]; } catch (e) { console.error('[kusto]', e); }
				}
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'databasesData':
			{
				const requestId = String(message.boxId || '');
				const synthetic = !kustoEditorSchemaCoordinator.getIdentity(requestId) && isKustoSyntheticDatabaseRequest(requestId);
				const admission = admitKustoDatabaseDelivery(message, kustoEditorSchemaCoordinator, synthetic);
				if (admission === 'rejected') break;
				if (admission === 'synthetic') {
					const metadata = kustoSyntheticDatabaseRequests.getMetadata(requestId);
					if (metadata && (
						String(message.connectionId || '').trim() !== metadata.connectionId
						|| !isSyntheticConnectionOwnerCurrent(metadata, message.accountPartition)
					)) {
						kustoSyntheticDatabaseRequests.reject(requestId, new Error('Synthetic database response target mismatch.'));
						break;
					}
					const list = (Array.isArray(message.databases) ? message.databases : [])
						.map((database: unknown) => String(database || '').trim())
						.filter(Boolean)
						.sort((left: string, right: string) => left.toLowerCase().localeCompare(right.toLowerCase()));
					const settlement = kustoSyntheticDatabaseRequests.resolve(requestId, list);
					if (settlement.kind === 'active' && settlement.metadata) {
						cachedDatabases[settlement.metadata.connectionId] = list;
					}
					break;
				}
			}
			try {
				const connectionId = String(message.connectionId || '').trim();
				const accountPartition = String(message.accountPartition || '').trim();
				const expectedToken = databaseRequestTokenByBoxId[String(message.boxId || '')];
				const responseToken = String(message.requestToken || '');
				const connection = connections.find(candidate => String(candidate?.id || '').trim() === connectionId);
				const currentPartition = String(connection?.accountPartition || '').trim();
				if (responseToken && expectedToken && responseToken !== expectedToken) break;
				if (accountPartition && currentPartition && currentPartition !== accountPartition) break;
			} catch (e) { console.error('[kusto]', e); break; }
			updateDatabaseSelect(message.boxId, message.databases, message.connectionId, message.requestToken, message.authoritative, message.fallback);
			break;
		case 'databasesError':
			{
				const requestId = String(message.boxId || '');
				const synthetic = !kustoEditorSchemaCoordinator.getIdentity(requestId) && isKustoSyntheticDatabaseRequest(requestId);
				const admission = admitKustoDatabaseDelivery(message, kustoEditorSchemaCoordinator, synthetic);
				if (admission === 'rejected') break;
				if (admission === 'synthetic') {
					kustoSyntheticDatabaseRequests.reject(
						requestId,
						new Error(message && message.error ? String(message.error) : 'Failed to load databases.'),
					);
					break;
				}
			}
			try {
				onDatabasesError(message.boxId, message && message.error ? String(message.error) : 'Failed to load databases.', message.connectionId, message.requestToken);
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'importConnectionsXmlText':
			try {
				const text = (typeof message.text === 'string') ? message.text : '';
				const imported = parseKustoExplorerConnectionsXml(text);
				if (!imported || !imported.length) {
					try { postMessageToHost({ type: 'showInfo', message: 'No connections found in the selected XML file.' }); } catch (e) { console.error('[kusto]', e); }
					break;
				}
				postMessageToHost({ type: 'importConnectionsFromXml', connections: imported, boxId: message.boxId });
			} catch (e: any) {
				try { postMessageToHost({ type: 'showInfo', message: 'Failed to import connections: ' + (e && e.message ? e.message : String(e)) }); } catch (e) { console.error('[kusto]', e); }
			}
			break;
		case 'importConnectionsXmlError':
			try { postMessageToHost({ type: 'showInfo', message: 'Failed to import connections: ' + (message && message.error ? String(message.error) : 'Unknown error') }); } catch (e) { console.error('[kusto]', e); }
			break;
		case 'kustoResultAttachmentCommitted': {
			const pending = pendingKustoResultAttachmentCommits.get(message.publicationId);
			if (!pending
				|| pending.boxId !== message.boxId
				|| pending.executionId !== message.executionId
				|| pending.sectionInstanceId !== message.sectionInstanceId
				|| pending.targetGeneration !== message.targetGeneration
				|| pending.primaryArtifactId !== message.primaryArtifactId) break;
			pendingKustoResultAttachmentCommits.delete(message.publicationId);
			try {
				__kustoGetQuerySectionElement(message.boxId)?.applyCommittedResultAttachment?.(message);
				schedulePersist('kusto-result-attachment-committed', true);
			} catch (error) { console.error('[kusto]', error); }
			break;
		}
		case 'kustoResultSelectionResult':
			try {
				__kustoGetQuerySectionElement(message.boxId)?.applyResultSelectionResponse?.(message);
			} catch (error) { console.error('[kusto]', error); }
			break;
		case 'queryResult':
			settleSqlTerminalExecution(message);
			const isKustoResult = hasKustoExecutionTerminalStamp(message, true);
			if (message.boxId && sqlPolicyBlockedBoxIds.has(String(message.boxId))) {
				const blockedId = String(message.boxId);
				const blockedMetadata = optimizationMetadataByBoxId[blockedId];
				if (!__kustoGetSqlSectionElement(blockedId) && !blockedMetadata?.isComparison) {
					sqlPolicyBlockedBoxIds.delete(blockedId);
				} else {
					try { setQueryExecuting(message.boxId, false); } catch (e) { console.error('[kusto]', e); }
					try { clearSqlPolicyBox(blockedId); } catch (e) { console.error('[kusto]', e); }
					completeKustoTerminal(message);
					acknowledgeKustoPublication(message, false);
					break;
				}
			}
			let resultAccepted = !message.boxId;
			const artifactPublication = getKustoResultArtifactPublication(message)
				|| getSqlResultArtifactPublication(message);
			if (isKustoResult && !artifactPublication) {
				acknowledgeKustoPublication(message, false);
				break;
			}
			const comparisonBoxId = String(message.comparisonRun?.comparisonBoxId || '').trim();
			const comparisonMetadata = optimizationMetadataByBoxId[String(message.boxId || '')];
			const comparisonSourceBoxId = comparisonMetadata?.isComparison
				? String(comparisonMetadata.sourceBoxId || '').trim()
				: '';
			const sqlDerivedComparison = !!comparisonSourceBoxId
				&& !!__kustoGetSqlSectionElement(comparisonSourceBoxId)
				&& message.engine !== 'kusto';
			const exactComparisonArtifactRequired = (comparisonBoxId && String(message.boxId || '') === comparisonBoxId)
				|| !!comparisonSourceBoxId;
			if (exactComparisonArtifactRequired && !artifactPublication?.lineage?.length) {
				if (!isKustoResult) {
					try { setQueryExecuting(message.boxId, false); } catch (e) { console.error('[kusto]', e); }
					releaseComparisonSourceArtifact(message);
					completeKustoTerminal(message);
				}
				acknowledgeKustoPublication(message, false);
				break;
			}
			try {
				if (message.boxId) {
					pState.lastExecutedBox = message.boxId;
				}
			} catch (e) { console.error('[kusto]', e); }
			try {
				// Always target the concrete boxId when available (prevents races when
				// multiple queries are running and keeps comparison summaries in sync).
				if (message.boxId) {
					if (!isKustoResult) {
						try { setQueryExecuting(message.boxId, false); } catch (e) { console.error('[kusto]', e); }
					}
					const displayOptions = {
						label: 'Results', showExecutionTime: true,
						...(message.executionId && (!sqlDerivedComparison || __kustoGetSqlSectionElement(String(message.boxId || '')))
							? { executionId: String(message.executionId) }
							: {}),
						...(artifactPublication ? { artifactPublication } : {}),
					};
					resultAccepted = (isKustoResult
						? displayResultBatchForBox(message.result, message.boxId, {
							...displayOptions,
							selectedResultIndex: Number(message.selectedResultIndex ?? 0),
						})
						: displayResultForBox(message.result, message.boxId, displayOptions)) !== false;
				} else {
					displayResult(message.result);
				}
			} catch (e: any) {
				console.error('Failed to render query results:', e);
			}
			if (!resultAccepted) {
				if (!isKustoResult) {
					releaseComparisonSourceArtifact(message);
					completeKustoTerminal(message);
				}
				acknowledgeKustoPublication(message, false);
				break;
			}
			if (message.comparisonRun
				&& String(message.boxId || '') === String(message.comparisonRun.sourceBoxId || '')
				&& String(message.executionId || '') === String(message.comparisonRun.sourceExecutionId || '')) {
				bindComparisonSourceArtifact(message.comparisonRun);
			}
			try {
				if (message.boxId && !isKustoResult) {
					__kustoOnQueryResult(message.boxId, message.result, message.dispatch);
				}
				if (message.boxId && message.ensureResultsVisible === true) __kustoSetResultsVisible(message.boxId, true);
			} catch (e) { console.error('[kusto]', e); }
			releaseComparisonSourceArtifact(message);
			// Check if this is a comparison box result
			try {
				if (message.boxId && optimizationMetadataByBoxId[message.boxId]) {
					const metadata = optimizationMetadataByBoxId[message.boxId];
					if (metadata.isComparison && metadata.sourceBoxId) {
						const comparisonArtifact = getCurrentResultArtifact(message.boxId);
						const sourceArtifactId = comparisonArtifact?.lineage.find(input => (
							input.role === 'comparison-source'
						))?.sourceArtifactId;
						if (sourceArtifactId && getResultArtifact(sourceArtifactId)) {
							displayComparisonSummary(metadata.sourceBoxId, message.boxId);
						}
					}
				}
			} catch (err: any) {
				console.error('Error displaying comparison summary:', err);
			}
			// Also handle the inverse: source box result arrives after comparison
			try {
				if (message.boxId && optimizationMetadataByBoxId[message.boxId] && optimizationMetadataByBoxId[message.boxId].comparisonBoxId) {
					const comparisonBoxId = optimizationMetadataByBoxId[message.boxId].comparisonBoxId;
					const comparisonArtifact = getCurrentResultArtifact(comparisonBoxId);
					const sourceArtifactId = comparisonArtifact?.lineage.find(input => (
						input.role === 'comparison-source'
					))?.sourceArtifactId;
					if (sourceArtifactId && getResultArtifact(sourceArtifactId)) {
						displayComparisonSummary(message.boxId, comparisonBoxId);
					}
				}
			} catch (e) { console.error('[kusto]', e); }
			emitAdmittedKustoTerminal(message);
			if (isKustoResult && message.publicationId && artifactPublication?.assignedIdentity) {
				pendingKustoResultAttachmentCommits.set(String(message.publicationId), Object.freeze({
					boxId: String(message.boxId),
					executionId: String(message.executionId),
					sectionInstanceId: String(message.sectionInstanceId),
					targetGeneration: Number(message.targetGeneration),
					primaryArtifactId: artifactPublication.assignedIdentity.artifactId,
				}));
				while (pendingKustoResultAttachmentCommits.size > 128) {
					pendingKustoResultAttachmentCommits.delete(
						pendingKustoResultAttachmentCommits.keys().next().value!,
					);
				}
			}
			try { if (isKustoResult) setQueryExecuting(message.boxId, false); } catch (e) { console.error('[kusto]', e); }
			completeKustoTerminal(message);
			acknowledgeKustoPublication(message, true);
			break;
		case 'queryError':
			settleSqlTerminalExecution(message);
			try {
				if (message && message.boxId) {
					pState.lastExecutedBox = message.boxId;
				}
			} catch (e) { console.error('[kusto]', e); }
			try {
				const boxId = (message && message.boxId) ? String(message.boxId) : (pState.lastExecutedBox ? String(pState.lastExecutedBox) : '');
				const err = (message && 'error' in message) ? message.error : 'Query execution failed.';
				try {
					if (boxId) {
						setQueryExecuting(boxId, false);
					}
				} catch (e) { console.error('[kusto]', e); }
				if (boxId) {
					const clientActivityId = (message && typeof message.clientActivityId === 'string') ? message.clientActivityId : undefined;
					const metadata = optimizationMetadataByBoxId[boxId];
					const sqlDerivedComparison = !!metadata?.isComparison
						&& !!__kustoGetSqlSectionElement(String(metadata.sourceBoxId || '').trim())
						&& message.engine !== 'kusto';
					__kustoRenderErrorUx(
						boxId, err, clientActivityId,
						message.executionId && (!sqlDerivedComparison || __kustoGetSqlSectionElement(boxId))
							? String(message.executionId)
							: undefined,
					);
				} else {
					console.error('Query error (no error renderer available):', err);
				}
			} catch (e: any) {
				console.error('Failed to render query error:', e);
			}
			releaseComparisonSourceArtifact(message);
			emitAdmittedKustoTerminal(message);
			completeKustoTerminal(message);
			acknowledgeKustoPublication(message, true);
			break;
		case 'queryCancelled':
			settleSqlTerminalExecution(message);
			try {
				if (message.boxId) {
					pState.lastExecutedBox = message.boxId;
				}
			} catch (e) { console.error('[kusto]', e); }
			try {
				const cancelledBoxId = (message && message.boxId) ? String(message.boxId) : (pState.lastExecutedBox ? String(pState.lastExecutedBox) : '');
				if (cancelledBoxId) {
					setQueryExecuting(cancelledBoxId, false);
					const sqlEl = __kustoGetSqlSectionElement(cancelledBoxId);
					if (typeof sqlEl?.notifyToolRunCancelled === 'function') {
						sqlEl.notifyToolRunCancelled(message.executionId ? String(message.executionId) : undefined);
					}
				}
			} catch (e) { console.error('[kusto]', e); }
			displayCancelled();
			releaseComparisonSourceArtifact(message);
			emitAdmittedKustoTerminal(message);
			completeKustoTerminal(message);
			acknowledgeKustoPublication(message, true);
			break;
		case 'ensureResultsVisible':
			try {
				const boxId = (message && message.boxId) ? String(message.boxId) : '';
				if (boxId) {
					__kustoSetResultsVisible(boxId, true);
				}
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'pythonResult':
			try { onPythonResult(message); } catch (e) { console.error('[kusto]', e); }
			break;
		case 'pythonError':
			try { onPythonError(message); } catch (e) { console.error('[kusto]', e); }
			break;
		case 'urlContent':
			// Handled by <kw-url-section> Lit component via window message listener.
			break;
		case 'urlError':
			// Handled by <kw-url-section> Lit component via window message listener.
			break;
		case 'schemaData':
			traceFileOpen('message.schemaData.received', {
				boxId: message.boxId,
				database: message.database,
				fromCache: !!message.schemaMeta?.fromCache,
				cacheState: message.schemaMeta?.cacheState || '',
				workerUpdateNeeded: message.schemaMeta?.workerUpdateNeeded,
				tablesCount: message.schemaMeta?.tablesCount,
				columnsCount: message.schemaMeta?.columnsCount,
				hasRawSchemaJson: !!message.schema?.rawSchemaJson,
			});
			{
				const requestId = String(message.boxId || '');
				const synthetic = !kustoEditorSchemaCoordinator.getIdentity(requestId) && isKustoSyntheticSchemaRequest(requestId);
				const admission = admitKustoSchemaDelivery(message, kustoEditorSchemaCoordinator, synthetic);
				if (admission === 'rejected') break;
				if (admission === 'synthetic') {
					const metadata = kustoSyntheticSchemaRequests.getMetadata(requestId);
					if (metadata && (
						String(message.connectionId || '').trim() !== metadata.connectionId
						|| String(message.database || '').trim() !== metadata.database
						|| !isSyntheticConnectionOwnerCurrent(metadata, message.accountPartition)
					)) {
						kustoSyntheticSchemaRequests.reject(requestId, new Error('Synthetic schema response target mismatch.'));
						break;
					}
					const settlement = kustoSyntheticSchemaRequests.resolve(requestId, message.schema);
					if (settlement.kind === 'active' && settlement.metadata) {
						schemaByConnDb[settlement.metadata.schemaKey] = message.schema;
						schemaMetaByConnDb[settlement.metadata.schemaKey] = message.schemaMeta || {};
					}
					break;
				}
			}
			// Drop late responses from older selections (e.g., user switched favorites quickly).
			try {
				const tok = message && typeof message.requestToken === 'string' ? message.requestToken : '';
				if (tok && schemaRequestTokenByBoxId) {
					const expected = schemaRequestTokenByBoxId[message.boxId];
					if (expected !== tok) {
						break;
					}
				}
				const connectionId = String(message.connectionId || '').trim();
				const accountPartition = String(message.accountPartition || '').trim();
				const connection = connections.find(candidate => String(candidate?.id || '').trim() === connectionId);
				const currentPartition = String(connection?.accountPartition || '').trim();
				if (accountPartition && currentPartition && currentPartition !== accountPartition) {
					break;
				}
			} catch (e) { console.error('[kusto]', e); }
			
			try {
				const cid = String(message.connectionId || '').trim();
				const db = String(message.database || '').trim();
				const accountPartition = String(message.accountPartition || '').trim();
				const identityKey = getKustoSchemaIdentityKey(cid, accountPartition, message.clusterUrl, db);
				if (identityKey) {
					schemaByConnDb[identityKey] = message.schema;
					schemaMetaByConnDb[identityKey] = {
						...(message.schemaMeta || {}),
						connectionId: cid,
						accountPartition,
						database: db,
						clusterUrl: message.clusterUrl,
					};
				}
			} catch (e) { console.error('[kusto]', e); }

			// Normal per-editor schema update (autocomplete).
			// This is the SINGLE source of truth for schema data - no duplicate caching
			setKustoEditorSchema(message.boxId, message.schema);
			setKustoSchemaMetadata(message.boxId, message.schemaMeta || {});
			schemaFetchInFlightByBoxId[message.boxId] = false;
			const schemaMessageMeta = message.schemaMeta || {};
			const schemaMessageKey = getKustoSchemaIdentityKey(message.connectionId, message.accountPartition, message.clusterUrl, message.database);
			const schemaMessageSignature = typeof schemaMessageMeta.schemaSignature === 'string' ? schemaMessageMeta.schemaSignature : undefined;
			const schemaMessageModelUri = getQueryEditorModelUri(String(message.boxId || '')) || undefined;
			const hasRawSchemaJson = !!message.schema?.rawSchemaJson;
			const refreshScheduled = schemaMessageMeta.refreshState === 'scheduled';
			let preparationToken = getKustoPreparationToken(message.boxId);
			let preparationState = getKustoPreparationState(message.boxId);
			const readyStateAtDelivery = getSchemaWorkerReadyState(message.boxId);
			const baseWorkerUsableAtDelivery = !!(schemaMessageKey && schemaMessageModelUri
				&& readyStateAtDelivery?.status === 'ready'
				&& readyStateAtDelivery.schemaKey === schemaMessageKey
				&& readyStateAtDelivery.modelUri === schemaMessageModelUri);
			const exactWorkerReadyAtDelivery = !!(schemaMessageKey && schemaMessageModelUri
				&& baseWorkerUsableAtDelivery
				&& readyStateAtDelivery.schemaSignature === schemaMessageSignature
			);
			const backgroundRefreshDuringCachedApply = !!(schemaMessageMeta.isBackgroundRefresh
				&& hasRawSchemaJson
				&& schemaMessageKey
				&& schemaMessageModelUri
				&& readyStateAtDelivery?.status === 'pending'
				&& readyStateAtDelivery.schemaKey === schemaMessageKey
				&& readyStateAtDelivery.modelUri === schemaMessageModelUri
				&& preparationState.status === 'preparing'
				&& preparationState.target.schemaKey === schemaMessageKey
				&& preparationState.target.modelUri === schemaMessageModelUri
				&& preparationState.target.schemaSignature === readyStateAtDelivery.schemaSignature
				&& preparationState.blockers.includes('worker'));
			const exactEnhancementReadyAtDelivery = !!(schemaMessageKey && schemaMessageModelUri
				&& isSchemaEnhancementReady(message.boxId, schemaMessageKey, schemaMessageSignature, schemaMessageModelUri));
			const exactEnhancementPendingAtDelivery = !!(schemaMessageKey && schemaMessageModelUri
				&& isSchemaEnhancementPending(message.boxId, schemaMessageKey, schemaMessageSignature, schemaMessageModelUri));
			const forceLocalRecovery = preparationState.status === 'error' || isSchemaWorkerApplyRequired(message.boxId);
			const refreshCanReuseWorker = hasRawSchemaJson
				&& (baseWorkerUsableAtDelivery || backgroundRefreshDuringCachedApply)
				&& (refreshScheduled || !!schemaMessageMeta.isBackgroundRefresh || !!schemaMessageMeta.forceRefresh);
			const localRecoveryRequired = forceLocalRecovery
				|| (!exactWorkerReadyAtDelivery && !refreshCanReuseWorker);
			const workerUpdateRequired = hasRawSchemaJson && (schemaMessageMeta.workerUpdateNeeded !== false || localRecoveryRequired);
			const preparationTargetMatches = preparationState.target.connectionId === message.connectionId
				&& preparationState.target.database === message.database
				&& (!message.requestToken || !preparationState.target.requestToken || preparationState.target.requestToken === message.requestToken);
			if (!preparationToken || !preparationTargetMatches || preparationState.status === 'idle' || preparationState.status === 'error') {
				preparationToken = beginKustoPreparation(message.boxId, {
					stage: refreshScheduled ? 'refreshing' : 'schema',
					blockers: [
						refreshScheduled ? 'refresh' : 'schema',
						...workerUpdateRequired ? ['worker' as const] : [],
					],
					target: {
						connectionId: message.connectionId,
						database: message.database,
						schemaKey: schemaMessageKey || undefined,
						schemaSignature: schemaMessageSignature,
						modelUri: schemaMessageModelUri,
						requestToken: message.requestToken,
					},
					usableFallback: hasRawSchemaJson,
				});
				preparationState = getKustoPreparationState(message.boxId);
			}

			if (preparationToken && backgroundRefreshDuringCachedApply && refreshScheduled) {
				preparationToken = reviseKustoPreparation(preparationToken, {
					status: 'preparing',
					stage: 'refreshing',
					replaceBlockers: ['refresh', 'worker'],
					target: {
						schemaKey: schemaMessageKey || undefined,
						schemaSignature: schemaMessageSignature,
						modelUri: schemaMessageModelUri,
					},
					usableFallback: true,
				});
				preparationState = getKustoPreparationState(message.boxId);
			} else if (preparationToken) {
				if (!hasRawSchemaJson) {
					if (refreshScheduled) {
						updateKustoPreparation(preparationToken, {
							stage: 'refreshing',
							replaceBlockers: ['refresh'],
							target: { schemaKey: schemaMessageKey || undefined, schemaSignature: schemaMessageSignature },
							usableFallback: false,
						});
					} else {
						lastSchemaRequestAtByBoxId[message.boxId] = 0;
						failKustoPreparation(preparationToken, 'Schema data is unavailable for autocomplete.');
					}
				} else if (!workerUpdateRequired) {
					updateKustoPreparation(preparationToken, {
						removeBlockers: refreshScheduled ? ['schema'] : ['schema', 'refresh'],
						addBlockers: refreshScheduled ? ['refresh'] : [],
						stage: refreshScheduled ? 'refreshing' : undefined,
						target: { schemaKey: schemaMessageKey || undefined, schemaSignature: schemaMessageSignature, modelUri: schemaMessageModelUri },
						usableFallback: true,
					});
				} else {
					preparationToken = reviseKustoPreparation(preparationToken, {
						removeBlockers: ['schema', 'refresh', 'worker'],
						addBlockers: [
							...refreshScheduled ? ['refresh' as const] : [],
							...refreshCanReuseWorker ? [] : ['worker' as const],
						],
						stage: refreshScheduled ? 'refreshing' : undefined,
						target: { schemaKey: schemaMessageKey || undefined, schemaSignature: schemaMessageSignature, modelUri: schemaMessageModelUri },
						usableFallback: true,
					});
					preparationState = getKustoPreparationState(message.boxId);
				}
			}
			
			// Update monaco-kusto with the raw schema JSON if available
			// With aggregate schema approach, we always push schemas to monaco-kusto
			// The __kustoSetMonacoKustoSchema function handles de-duplication and uses addDatabaseToSchema for subsequent loads
			try {
				const schemaKey = schemaMessageKey;
				const isForceRefresh = !!(message.schemaMeta && message.schemaMeta.forceRefresh);
				const readyState = getSchemaWorkerReadyState(message.boxId);
				const exactReadyFallback = !!(readyState?.status === 'ready'
					&& readyState.schemaKey === schemaKey
					&& readyState.schemaSignature === schemaMessageSignature
					&& readyState.modelUri === schemaMessageModelUri
					&& preparationState.usableFallback);
				const enhancementReady = !!(schemaKey && schemaMessageModelUri && isSchemaEnhancementReady(message.boxId, schemaKey, schemaMessageSignature, schemaMessageModelUri));
				const enhancementPending = !!(schemaKey && schemaMessageModelUri && isSchemaEnhancementPending(message.boxId, schemaKey, schemaMessageSignature, schemaMessageModelUri));
				const forceWorkerRefresh = isForceRefresh
					|| !!schemaMessageMeta.autocompleteChanged
					|| forceLocalRecovery
					|| !!(readyState?.status === 'ready' && readyState.schemaKey === schemaKey && readyState.schemaSignature !== schemaMessageSignature)
					|| (exactReadyFallback && !enhancementReady && !enhancementPending && !exactWorkerReadyAtDelivery);
				if (schemaKey && workerUpdateRequired) {
					if (exactReadyFallback && !forceWorkerRefresh) {
						if (preparationToken) {
							updateKustoPreparation(preparationToken, { removeBlockers: ['worker', 'enhancement'] });
						}
					} else {
						applyKustoSchemaToWorkerFromMessage(
							message,
							schemaKey,
							forceWorkerRefresh,
							schemaMessageSignature,
							refreshCanReuseWorker ? undefined : preparationToken,
						);
					}
				}
				if (schemaKey && schemaMessageModelUri && exactWorkerReadyAtDelivery
					&& !exactEnhancementReadyAtDelivery && !exactEnhancementPendingAtDelivery) {
					__kustoRetryPrimarySchemaEnhancement({
						boxId: String(message.boxId || ''),
						rawSchemaJson: message.schema.rawSchemaJson,
						clusterUrl: message.clusterUrl,
						database: message.database,
						connectionId: String(message.connectionId || ''),
						accountPartition: String(message.accountPartition || ''),
						schemaKey,
						modelUri: schemaMessageModelUri,
					});
				}
			} catch (e: any) { console.error('[schemaData] Error:', e); }
			if (schemaMessageMeta.refreshState === 'completed' || schemaMessageMeta.refreshState === 'failed') {
				try { window.__kustoTriggerRevalidation?.(String(message.boxId || '')); } catch (e) { console.error('[kusto]', e); }
			}
			
			// NOTE: Custom diagnostics are disabled - monaco-kusto handles validation
			// try {
			// 	if (typeof window.__kustoScheduleKustoDiagnostics === 'function') {
			// 		window.__kustoScheduleKustoDiagnostics(message.boxId, 0);
			// 	}
			// } catch (e) { console.error('[kusto]', e); }
			{
				const meta = message.schemaMeta || {};
				const tablesCount = meta.tablesCount ?? (message.schema?.tables?.length ?? 0);
				const columnsCount = meta.columnsCount ?? 0;
				const functionsCount = meta.functionsCount ?? (message.schema?.functions?.length ?? 0);
				const hasRawSchemaJson = !!(message.schema && message.schema.rawSchemaJson);
				const isFailoverToCache = !!meta.isFailoverToCache;
				
				// Determine display text and error state based on schema completeness
				let displayText = tablesCount + ' tables, ' + columnsCount + ' cols';
				let tooltipText = 'Schema loaded for autocomplete';
				let isError = false;
				
				if (!hasRawSchemaJson && meta.refreshState !== 'scheduled') {
					displayText = 'Schema unavailable';
					tooltipText = 'Schema data required for autocomplete is unavailable. Try refreshing the schema.';
					isError = true;
				} else if (meta.fromCache) {
					if (isFailoverToCache && !hasRawSchemaJson) {
						// Cached schema from failover but missing rawSchemaJson - autocomplete won't work
						displayText = 'Schema outdated';
						tooltipText = 'Cached schema is outdated. Autocomplete may not work. Try refreshing schema when connected.';
						isError = true;
					} else if (isFailoverToCache) {
						// Cached schema from failover with rawSchemaJson - works but stale
						displayText += ' (cached)';
						tooltipText = 'Using cached schema after connection failure. Schema may be outdated.';
						// Not an error since autocomplete still works
					} else {
						// Normal cache hit
						displayText += ' (cached)';
						tooltipText += ' (cached)';
					}
				}
				
				try {
					const kwEl = __kustoGetQuerySectionElement(message.boxId);
					if (kwEl && typeof kwEl.setSchemaInfo === 'function') {
						kwEl.setSchemaInfo(buildSchemaInfo(displayText, isError,
							{ fromCache: !!meta.fromCache, tablesCount, columnsCount, functionsCount, hasRawSchemaJson, isFailoverToCache }));
					}
				} catch (e) { console.error('[kusto]', e); }
			}
			break;
		case 'schemaError':
			{
				const requestId = String(message.boxId || '');
				const synthetic = !kustoEditorSchemaCoordinator.getIdentity(requestId) && isKustoSyntheticSchemaRequest(requestId);
				const admission = admitKustoSchemaDelivery(message, kustoEditorSchemaCoordinator, synthetic);
				if (admission === 'rejected') break;
				if (admission === 'synthetic') {
					kustoSyntheticSchemaRequests.reject(requestId, new Error(message.error || 'Schema fetch failed'));
					break;
				}
			}
			// Drop late responses from older selections (e.g., user switched favorites quickly).
			try {
				const tok = message && typeof message.requestToken === 'string' ? message.requestToken : '';
				if (tok && schemaRequestTokenByBoxId) {
					const expected = schemaRequestTokenByBoxId[message.boxId];
					if (expected !== tok) {
						break;
					}
				}
			} catch (e) { console.error('[kusto]', e); }
			// Non-fatal; keep any previously loaded schema + counts if present.
			schemaFetchInFlightByBoxId[message.boxId] = false;
			lastSchemaRequestAtByBoxId[message.boxId] = 0;
			try {
				const preparation = getKustoPreparationState(message.boxId);
				const preparationToken = getKustoPreparationToken(message.boxId);
				const responseMatchesPreparation = !message.requestToken || preparation.target.requestToken === message.requestToken;
				const currentSchemaKey = getCurrentSchemaKeyForBoxId(String(message.boxId || ''));
				const currentModelUri = getQueryEditorModelUri(String(message.boxId || ''));
				const currentSchemaMeta = getKustoSchemaMetadata(message.boxId) || {};
				const currentWorker = getSchemaWorkerReadyState(message.boxId);
				const pendingFallback = getPendingSchemaWorkerUpdate(message.boxId);
				const usableWorkerFallback = !!(currentSchemaKey && currentModelUri
					&& currentWorker?.status === 'ready'
					&& currentWorker.schemaKey === currentSchemaKey
					&& currentWorker.schemaSignature === currentSchemaMeta.schemaSignature
					&& currentWorker.modelUri === currentModelUri);
				const usableApplyingFallback = !!(currentSchemaKey && currentModelUri
					&& getKustoEditorSchema(message.boxId)?.rawSchemaJson
					&& currentWorker?.status === 'pending'
					&& currentWorker.schemaKey === currentSchemaKey
					&& currentWorker.schemaSignature === currentSchemaMeta.schemaSignature
					&& currentWorker.modelUri === currentModelUri);
				const usableQueuedFallback = !!(currentSchemaKey
					&& getKustoEditorSchema(message.boxId)?.rawSchemaJson
					&& pendingFallback?.rawSchemaJson
					&& pendingFallback.schemaKey === currentSchemaKey
					&& pendingFallback.schemaSignature === currentSchemaMeta.schemaSignature);
				if (responseMatchesPreparation && message.isBackgroundRefresh) {
					setKustoSchemaMetadata(message.boxId, { ...currentSchemaMeta, refreshState: 'failed' });
				}
				if (message.cacheOnly && message.silent) {
					if (responseMatchesPreparation) {
						setKustoPreparationIdle(message.boxId);
					}
				} else if (preparationToken && preparation.status !== 'idle' && preparation.status !== 'ready' && responseMatchesPreparation) {
					failKustoPreparation(
						preparationToken,
						message.error || 'Schema preparation failed.',
						!!(message.isBackgroundRefresh && message.hasUsableFallback && (usableWorkerFallback || usableApplyingFallback || usableQueuedFallback))
					);
				}
				if (responseMatchesPreparation && message.isBackgroundRefresh) {
					window.__kustoTriggerRevalidation?.(String(message.boxId || ''));
				}
			} catch (e) { console.error('[kusto]', e); }
			if (message.silent || message.cacheOnly) {
				break;
			}
			try {
				const hasSchema = !!getKustoEditorSchema(message.boxId);
				if (!hasSchema) {
					const kwEl = __kustoGetQuerySectionElement(message.boxId);
					if (kwEl && typeof kwEl.setSchemaInfo === 'function') {
						kwEl.setSchemaInfo(buildSchemaInfo('Schema failed', true));
					}
				}
			} catch {
				try {
					const kwEl2 = __kustoGetQuerySectionElement(message.boxId);
					if (kwEl2 && typeof kwEl2.setSchemaInfo === 'function') {
						kwEl2.setSchemaInfo(buildSchemaInfo('Schema failed', true));
					}
				} catch (e) { console.error('[kusto]', e); }
			}
			try {
				__kustoDisplayBoxError(message.boxId, message.error || 'Schema fetch failed');
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'crossClusterSchemaData':
			// Handle cross-cluster schema response
			try {
				const delivery = kustoSchemaHostMessage;
				if (!delivery || delivery.type !== 'crossClusterSchemaData') break;
				const clusterName = delivery.clusterName;
				const clusterUrl = delivery.clusterUrl;
				const database = delivery.database;
				const rawSchemaJson = delivery.rawSchemaJson;
				__kustoTraceCrossCluster('response-received', { clusterName, clusterUrl, database, boxId: delivery.boxId, requestToken: delivery.requestToken, requestSource: delivery.requestSource, deliverySource: delivery.deliverySource, cacheAgeMs: delivery.cacheAgeMs });
				if (!__kustoIsCurrentCrossClusterRequest(delivery.boxId, clusterName, database, delivery.requestToken)) {
					__kustoTraceCrossCluster('response-dropped-stale-token', { clusterName, database, boxId: delivery.boxId, requestToken: delivery.requestToken });
					__kustoReleaseStaleCrossClusterResponse(clusterName, database, 'Stale schema response ignored; request is retryable');
					break;
				}
				
				if (rawSchemaJson) {
					__kustoHandleCrossClusterSchemaData({
						clusterName,
						clusterUrl,
						connectionId: delivery.connectionId || '',
						accountPartition: delivery.accountPartition || '',
						database,
						boxId: delivery.boxId,
						requestToken: delivery.requestToken,
						requestSource: delivery.requestSource,
						deliverySource: delivery.deliverySource,
						cacheAgeMs: delivery.cacheAgeMs,
						rawSchemaJson,
					});
				}
			} catch (e: any) {
				console.error('[crossClusterSchemaData] Error:', e);
			}
			break;
		case 'crossClusterSchemaError':
			// Handle cross-cluster schema error
			try {
				const delivery = kustoSchemaHostMessage;
				if (!delivery || delivery.type !== 'crossClusterSchemaError') break;
				const clusterName = delivery.clusterName;
				const database = delivery.database;
				__kustoTraceCrossCluster('response-error', { clusterName, database, boxId: delivery.boxId, requestToken: delivery.requestToken, error: delivery.error });
				if (!__kustoIsCurrentCrossClusterRequest(delivery.boxId, clusterName, database, delivery.requestToken)) {
					__kustoTraceCrossCluster('response-error-dropped-stale-token', { clusterName, database, boxId: delivery.boxId, requestToken: delivery.requestToken });
					__kustoReleaseStaleCrossClusterResponse(clusterName, database, 'Stale schema error ignored; request is retryable');
					break;
				}
				__kustoHandleCrossClusterSchemaError({
					clusterName,
					database,
					boxId: delivery.boxId,
					requestToken: delivery.requestToken,
					requestSource: delivery.requestSource,
					failureKind: delivery.failureKind,
				});
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'openKustoAddConnectionDialog':
			try {
				const kwEl = message.boxId ? __kustoGetQuerySectionElement(message.boxId) : null;
				if (kwEl && typeof kwEl.openAddConnectionModal === 'function') {
					kwEl.openAddConnectionModal();
				}
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'kustoConnectionTestStarted':
			try {
				const kwEl = message.boxId ? __kustoGetQuerySectionElement(message.boxId) : null;
				if (kwEl && typeof kwEl.setAddConnectionTestResult === 'function') {
					kwEl.setAddConnectionTestResult('loading');
				}
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'kustoConnectionTestResult':
			try {
				const kwEl = message.boxId ? __kustoGetQuerySectionElement(message.boxId) : null;
				if (kwEl && typeof kwEl.setAddConnectionTestResult === 'function') {
					kwEl.setAddConnectionTestResult(message.success ? `✓ ${message.message}` : `✗ ${message.message}`);
				}
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'kustoConnectionMutationResult':
			try {
				const kwEl = message.boxId ? __kustoGetQuerySectionElement(message.boxId) : null;
				if (kwEl && typeof kwEl.completeAddConnection === 'function') {
					kwEl.completeAddConnection(!!message.success, message.message);
				}
			} catch (e) { console.error('[kusto]', e); }
			break;
			case 'connectionAdded':
				// The enriched connectionsData snapshot is published before this acknowledgement.
				if (message.lastConnectionId) {
					setLastConnectionId(message.lastConnectionId);
				}
				if (typeof message.lastDatabase === 'string') {
					setLastDatabase(message.lastDatabase);
				}
				updateConnectionSelects();
				try {
					__kustoOnConnectionsUpdated();
				} catch (e) { console.error('[kusto]', e); }
				try {
					const boxId = message.boxId || null;
					if (boxId && message.connectionId) {
						const kwEl = __kustoGetQuerySectionElement(boxId);
						if (kwEl && typeof kwEl.completeAddConnection === 'function') kwEl.completeAddConnection(true);
						if (kwEl && typeof kwEl.setConnectionId === 'function') {
							kwEl.setConnectionId(message.connectionId);
							kwEl.dispatchEvent(new CustomEvent('connection-changed', {
								detail: { boxId: boxId, connectionId: message.connectionId, source: 'user' },
								bubbles: true, composed: true,
							}));
						}
					}
				} catch (e) { console.error('[kusto]', e); }
				break;
		// ── SQL connection messages ────────────────────────────────────
		case 'sqlConnectionsData':
			try {
				const revision = message.revision;
				if (revision !== undefined && revision < latestSqlConnectionsRevision) break;
				setSqlConnections(message.connections);
				replaceSqlCachedDatabases(message.cachedDatabases ?? {});
				try { (window as any).__kustoSqlLastConnectionId = message.lastConnectionId || ''; } catch (e) { console.error('[kusto]', e); }
				try { (window as any).__kustoSqlLastDatabase = message.lastDatabase || ''; } catch (e) { console.error('[kusto]', e); }
				setSqlFavorites(message.sqlFavorites ?? []);
				applySqlLeaveNoTraceConnectionIds(message.sqlLeaveNoTrace);
				updateSqlConnectionSelects();
				resolvePendingSqlResultRestores();
				try { updateSqlFavoritesUiForAllBoxes(); } catch (e) { console.error('[kusto]', e); }
				if (revision !== undefined) latestSqlConnectionsRevision = revision;
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'sqlLeaveNoTraceData':
			try { applySqlLeaveNoTraceConnectionIds(message.connectionIds); } catch (e) { console.error('[kusto]', e); }
			break;
		case 'sqlCopilotPolicyChanged':
			try {
				for (const boxId of Array.isArray(message.boxIds) ? message.boxIds : []) {
					const id = String(boxId || '').trim();
					if (!id) continue;
					const sqlEl = __kustoGetSqlSectionElement(id);
					if (sqlEl) sqlPolicyBlockedBoxIds.delete(id);
					else sqlPolicyBlockedBoxIds.add(id);
					if (typeof sqlEl?.copilotWriteQueryCancel === 'function') sqlEl.copilotWriteQueryCancel();
					if (typeof sqlEl?.copilotClearConversation === 'function') sqlEl.copilotClearConversation();
					clearSqlPolicyBox(id);
				}
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'sqlFavoritesData':
			try {
				setSqlFavorites(Array.isArray(message.favorites) ? message.favorites : []);
				try { updateSqlFavoritesUiForAllBoxes(); } catch (e) { console.error('[kusto]', e); }
				try {
					const boxId = message && typeof message.boxId === 'string' ? message.boxId : '';
					if (boxId && Array.isArray(sqlFavorites) && sqlFavorites.length > 0) {
						const sqlEl = __kustoGetSqlSectionElement(boxId);
						if (sqlEl && typeof sqlEl.setFavoritesMode === 'function') {
							sqlEl.setFavoritesMode(true);
							if (typeof sqlFavoritesModeByBoxId === 'object') {
								sqlFavoritesModeByBoxId[boxId] = true;
							}
						}
					}
				} catch (e) { console.error('[kusto]', e); }
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'sqlConnectionAdded':
			try {
				if (Array.isArray(message.connections)) {
					setSqlConnections(message.connections);
				}
				updateSqlConnectionSelects();
				const boxId = message.boxId || null;
				if (boxId && message.connectionId) {
					const sqlEl = __kustoGetSqlSectionElement(boxId);
					if (sqlEl && typeof sqlEl.setSqlConnectionId === 'function') {
						sqlEl.setSqlConnectionId(message.connectionId);
						sqlEl.dispatchEvent(new CustomEvent('sql-connection-changed', {
							detail: { boxId: boxId, connectionId: message.connectionId, source: 'user' },
							bubbles: true, composed: true,
						}));
					}
				}
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'copilotChatFirstTimeResult':
			try {
				// Update local flag so the dialog is never shown again.
				pState.copilotChatFirstTimeDismissed = true;
				const action = String(message.action || '');
				if (action === 'proceed') {
					// User chose to use the embedded copilot chat; toggle it open.
					const ftBoxId = String(message.boxId || '').trim();
					const kwEl = ftBoxId ? __kustoGetQuerySectionElement(ftBoxId) : null;
					if (kwEl && typeof kwEl.setCopilotChatVisible === 'function') {
						kwEl.setCopilotChatVisible(true);
					} else {
						const sqlEl = ftBoxId ? __kustoGetSqlSectionElement(ftBoxId) : null;
						if (sqlEl && typeof sqlEl.setCopilotChatVisible === 'function') {
							sqlEl.setCopilotChatVisible(true);
						}
					}
				}
				// 'openedAgent' and 'dismissed': do nothing in webview (agent was opened or dialog dismissed).
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'copilotAvailability':
			try {
				const boxId = message.boxId || '';
				const available = !!message.available;
				// Per-editor toolbar toggle button
				try {
					const applyToButton = (btn: any) => {
						if (!btn) return;
						const inProgress = !!(btn.dataset && btn.dataset.kustoCopilotChatInProgress === '1');
						if (!available) {
							btn.disabled = true;
							try { if (btn.dataset) btn.dataset.kustoDisabledByCopilot = '1'; } catch (e) { console.error('[kusto]', e); }
							btn.title = 'Copilot chat\n\nGitHub Copilot is required for this feature. Enable Copilot in VS Code to use Copilot-assisted query writing.';
							btn.setAttribute('aria-disabled', 'true');
						} else {
							const disabledByCopilot = !!(btn.dataset && btn.dataset.kustoDisabledByCopilot === '1');
							if (disabledByCopilot) {
								try { if (btn.dataset) delete btn.dataset.kustoDisabledByCopilot; } catch (e) { console.error('[kusto]', e); }
								if (!inProgress) {
									btn.disabled = false;
									btn.setAttribute('aria-disabled', 'false');
								}
							}
							btn.title = 'Copilot chat\nGenerate and run a query with GitHub Copilot';
						}
					};

					if (boxId === '__kusto_global__') {
						const btns = document.querySelectorAll('.kusto-copilot-chat-toggle');
						for (const b of btns) {
							applyToButton(b);
						}
						// Also update all kw-query-toolbar and kw-sql-toolbar Lit elements.
						try {
							document.querySelectorAll('kw-query-toolbar').forEach((toolbar: any) => {
								if (typeof toolbar.setCopilotChatEnabled === 'function') toolbar.setCopilotChatEnabled(available);
							});
							document.querySelectorAll('kw-sql-toolbar').forEach((toolbar: any) => {
								if (typeof toolbar.setCopilotChatEnabled === 'function') toolbar.setCopilotChatEnabled(available);
							});
						} catch (e) { console.error('[kusto]', e); }
					} else {
						applyToButton(document.getElementById(boxId + '_copilot_chat_toggle'));
						// Also update the kw-query-toolbar or kw-sql-toolbar Lit element.
						try {
							const toolbar = document.querySelector('kw-query-toolbar[box-id="' + boxId + '"]') as any
								|| document.querySelector('kw-sql-toolbar[box-id="' + boxId + '"]') as any;
							if (toolbar && typeof toolbar.setCopilotChatEnabled === 'function') toolbar.setCopilotChatEnabled(available);
						} catch (e) { console.error('[kusto]', e); }
					}
				} catch (e) { console.error('[kusto]', e); }
				const optimizeButtons = boxId === '__kusto_global__'
					? document.querySelectorAll('.optimize-copilot-btn')
					: [document.getElementById(boxId + '_optimize_btn')].filter(Boolean);
				for (const optimizeBtn of optimizeButtons as any) {
					optimizeBtn.dataset.kustoCopilotAvailable = available ? '1' : '0';
					optimizeBtn.disabled = !available;
					optimizeBtn.title = available
						? 'Optimize query with GitHub Copilot'
						: 'GitHub Copilot is required to optimize this query.';
					optimizeBtn.setAttribute('aria-disabled', String(!available));
				}
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'compareQueryPerformanceWithQuery':
			try {
				const boxId = String(message.boxId || '');
				const query = String(message.query || '');
				if (boxId) {
					Promise.resolve(optimizeQueryWithCopilot(boxId, query, { agentTouched: true }));
				}
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'copilotWriteQueryOptions':
			try {
				const boxId = String(message.boxId || '');
				const kwEl = boxId ? __kustoGetQuerySectionElement(boxId) : null;
				if (kwEl && typeof kwEl.copilotApplyWriteQueryOptions === 'function') {
					kwEl.copilotApplyWriteQueryOptions(
						message.models || [],
						message.selectedModelId || '',
						message.tools || []
					);
				} else {
					// Try SQL section
					const sqlEl = boxId ? __kustoGetSqlSectionElement(boxId) : null;
					if (sqlEl && typeof sqlEl.copilotApplyWriteQueryOptions === 'function') {
						sqlEl.copilotApplyWriteQueryOptions(
							message.models || [],
							message.selectedModelId || '',
							message.tools || []
						);
					}
				}
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'copilotWriteQueryStatus':
			try {
				const boxId = String(message.boxId || '');
				const kwEl = boxId ? __kustoGetQuerySectionElement(boxId) : null;
				if (kwEl && typeof kwEl.copilotWriteQueryStatus === 'function') {
					kwEl.copilotWriteQueryStatus(message.status || '', message.detail || '', message.role || '');
				} else {
					const sqlEl = boxId ? __kustoGetSqlSectionElement(boxId) : null;
					if (sqlEl && typeof sqlEl.copilotWriteQueryStatus === 'function') {
						sqlEl.copilotWriteQueryStatus(message.status || '', message.detail || '', message.role || '');
					}
				}
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'copilotWriteQuerySetQuery':
			try {
				const boxId = String(message.boxId || '');
				const beforeSignature = getSectionSerializedSignature(boxId);
				const kwEl = boxId ? __kustoGetQuerySectionElement(boxId) : null;
				if (kwEl && canAdmitKustoHostExecutionStart(boxId)
					&& typeof kwEl.copilotWriteQuerySetQuery === 'function') {
					kwEl.copilotWriteQuerySetQuery(message.query || '');
					markSectionAgentTouched(boxId, beforeSignature);
				} else {
					const sqlEl = boxId ? __kustoGetSqlSectionElement(boxId) : null;
					if (sqlEl && sqlEl.canAcceptExternalQueryMutation?.() !== false
						&& typeof sqlEl.copilotWriteQuerySetQuery === 'function') {
						sqlEl.copilotWriteQuerySetQuery(message.query || '');
						markSectionAgentTouched(boxId, beforeSignature);
					}
				}
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'copilotWriteQueryExecuting':
			try {
				const boxId = String(message.boxId || '');
				const executing = !!message.executing;
				let accepted = false;
				if (boxId) {
					const executionId = String(message.executionId || '');
					const startDeadline = Number(message.startDeadline);
					if (executing && (consumeRetiredSqlCopilotStart(boxId, executionId)
						|| (Number.isFinite(startDeadline) && startDeadline <= Date.now()))) {
						postMessageToHost({
							type: 'copilotWriteQueryExecutionAck', boxId, executionId, accepted: false,
						});
						break;
					}
					const metadata = optimizationMetadataByBoxId[boxId];
					const sqlDerivedComparison = !!metadata?.isComparison
						&& !!__kustoGetSqlSectionElement(String(metadata.sourceBoxId || '').trim());
					const sqlEl = __kustoGetSqlSectionElement(boxId);
					const queryEl = __kustoGetQuerySectionElement(boxId);
					const expectedQuery = String(message.query || '');
					const currentQuery = () => String(
						sqlEl?.getQuery?.()
						?? queryEditors?.[boxId]?.getValue?.()
						?? queryEl?.getCopilotEditorValue?.()
						?? queryEl?.serialize?.()?.query
						?? '',
					);
					if (executing) {
						const mutationAllowed = sqlEl
							? sqlEl.canAcceptExternalQueryMutation?.() !== false
							: canAdmitKustoHostExecutionStart(boxId);
						if (!expectedQuery || !mutationAllowed || currentQuery() !== expectedQuery
							|| !await persistDocumentAndWaitForAck(
								'copilot-sql-query-start', SQL_COPILOT_PERSIST_ACK_TIMEOUT_MS,
							)) {
							postMessageToHost({
								type: 'copilotWriteQueryExecutionAck', boxId, executionId, accepted: false,
							});
							break;
						}
						const stillAllowed = sqlEl
							? sqlEl.canAcceptExternalQueryMutation?.() !== false
							: canAdmitKustoHostExecutionStart(boxId);
						if (consumeRetiredSqlCopilotStart(boxId, executionId)
							|| (Number.isFinite(startDeadline) && startDeadline <= Date.now())
							|| !stillAllowed || currentQuery() !== expectedQuery) {
							postMessageToHost({
								type: 'copilotWriteQueryExecutionAck', boxId, executionId, accepted: false,
							});
							break;
						}
					}
					if (executing && sqlDerivedComparison && !canAdmitKustoHostExecutionStart(boxId)) {
						postMessageToHost({
							type: 'copilotWriteQueryExecutionAck', boxId, executionId, accepted: false,
						});
						break;
					}
					if (sqlEl && typeof sqlEl.setExternalQueryExecuting === 'function'
						&& !sqlEl.setExternalQueryExecuting(executing, executionId)) {
						if (executing) postMessageToHost({
							type: 'copilotWriteQueryExecutionAck', boxId, executionId, accepted: false,
						});
						break;
					}
					if (sqlDerivedComparison) {
						if (executing) {
							const binding = beginSqlComparisonSourceBinding(boxId, message);
							const claimCommitted = !!binding
								&& commitSqlDerivedComparisonExecution(boxId, executionId);
							if (!binding || !claimCommitted) {
								if (binding) rollbackComparisonSourceBinding(binding);
								rollbackSqlDerivedComparisonExecution(boxId, executionId);
								if (sqlEl?.setExternalQueryExecuting) {
									sqlEl.setExternalQueryExecuting(false, executionId);
								} else {
									setQueryExecuting(boxId, false);
								}
								postMessageToHost({
									type: 'copilotWriteQueryExecutionAck', boxId, executionId, accepted: false,
								});
								break;
							}
							commitComparisonSourceBinding(binding);
							retireResultsStateForRerun(boxId);
						} else {
							releaseComparisonSourceArtifact(message);
						}
						setQueryExecuting(boxId, executing);
						accepted = true;
						if (executing) postMessageToHost({
							type: 'copilotWriteQueryExecutionAck', boxId, executionId, accepted,
						});
						break;
					}
					if (queryEl && typeof queryEl.setExternalQueryExecuting === 'function'
						&& !queryEl.setExternalQueryExecuting(executing, executionId)) {
						if (executing) postMessageToHost({
							type: 'copilotWriteQueryExecutionAck', boxId, executionId, accepted: false,
						});
						break;
					}
					if (!queryEl) setQueryExecuting(boxId, executing);
					accepted = !!sqlEl || !!queryEl;
					if (executing) postMessageToHost({
						type: 'copilotWriteQueryExecutionAck', boxId, executionId, accepted,
					});
				}
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'copilotWriteQueryToolResult':
			try {
				const boxId = String(message.boxId || '');
				const kwEl = boxId ? __kustoGetQuerySectionElement(boxId) : null;
				if (kwEl && typeof kwEl.copilotWriteQueryToolResult === 'function') {
					kwEl.copilotWriteQueryToolResult(
						message.tool || '',
						message.label || '',
						message.json || '',
						message.entryId || ''
					);
				} else {
					const sqlEl = boxId ? __kustoGetSqlSectionElement(boxId) : null;
					if (sqlEl && typeof sqlEl.copilotWriteQueryToolResult === 'function') {
						sqlEl.copilotWriteQueryToolResult(
							message.tool || '',
							message.label || '',
							message.json || '',
							message.entryId || ''
						);
					}
				}
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'copilotExecutedQuery':
			let copilotResultApplied = false;
			try {
				const boxId = String(message.boxId || '');
				const kwEl = boxId ? __kustoGetQuerySectionElement(boxId) : null;
				if (kwEl && typeof kwEl.copilotAppendExecutedQuery === 'function') {
					let storedResult = message.result || null;
					if (storedResult) {
						const parsed = parseKustoResultBatch(storedResult);
						if (!parsed.ok) {
							acknowledgeKustoPublication(message, false);
							break;
						}
						storedResult = parsed.value;
					}
					kwEl.copilotAppendExecutedQuery(
						message.query || '',
						message.resultSummary || '',
						message.errorMessage || '',
						message.entryId || '',
						storedResult
					);
					copilotResultApplied = true;
				} else {
					const sqlEl = boxId ? __kustoGetSqlSectionElement(boxId) : null;
					if (sqlEl && typeof sqlEl.copilotAppendExecutedQuery === 'function') {
						sqlEl.copilotAppendExecutedQuery(
							message.query || '',
							message.resultSummary || '',
							message.errorMessage || '',
							message.entryId || '',
							message.result || null
						);
						copilotResultApplied = true;
					}
				}
			} catch (e) { console.error('[kusto]', e); }
			acknowledgeKustoPublication(message, copilotResultApplied);
			break;
		case 'copilotGeneralQueryRulesLoaded':
			try {
				const boxId = String(message.boxId || '');
				const kwEl = boxId ? __kustoGetQuerySectionElement(boxId) : null;
				if (kwEl && typeof kwEl.copilotAppendGeneralRulesLink === 'function') {
					kwEl.copilotAppendGeneralRulesLink(
						message.filePath || '',
						message.preview || '',
						message.entryId || ''
					);
				} else {
					const sqlEl = boxId ? __kustoGetSqlSectionElement(boxId) : null;
					if (sqlEl && typeof sqlEl.copilotAppendGeneralRulesLink === 'function') {
						sqlEl.copilotAppendGeneralRulesLink(
							message.filePath || '',
							message.preview || '',
							message.entryId || ''
						);
					}
				}
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'copilotUserQuerySnapshot':
			try {
				const boxId = String(message.boxId || '');
				const kwEl = boxId ? __kustoGetQuerySectionElement(boxId) : null;
				if (kwEl && typeof kwEl.copilotAppendQuerySnapshot === 'function') {
					kwEl.copilotAppendQuerySnapshot(
						message.queryText || '',
						message.entryId || ''
					);
				} else {
					const sqlEl = boxId ? __kustoGetSqlSectionElement(boxId) : null;
					if (sqlEl && typeof sqlEl.copilotAppendQuerySnapshot === 'function') {
						sqlEl.copilotAppendQuerySnapshot(
							message.queryText || '',
							message.entryId || ''
						);
					}
				}
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'copilotDevNotesContextLoaded':
			try {
				const boxId = String(message.boxId || '');
				const kwEl = boxId ? __kustoGetQuerySectionElement(boxId) : null;
				if (kwEl && typeof kwEl.copilotAppendDevNotesContext === 'function') {
					kwEl.copilotAppendDevNotesContext(
						message.preview || '',
						message.entryId || ''
					);
				} else {
					const sqlEl = boxId ? __kustoGetSqlSectionElement(boxId) : null;
					if (sqlEl && typeof sqlEl.copilotAppendDevNotesContext === 'function') {
						sqlEl.copilotAppendDevNotesContext(
							message.preview || '',
							message.entryId || ''
						);
					}
				}
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'copilotDevNoteToolCall':
			try {
				const boxId = String(message.boxId || '');
				const detail = message.action === 'save'
					? ('[' + (message.category || 'note') + '] ' + (message.content || ''))
					: ('Removed note: ' + (message.noteId || '') + (message.reason ? ' — ' + message.reason : ''));
				const kwEl = boxId ? __kustoGetQuerySectionElement(boxId) : null;
				if (kwEl && typeof kwEl.copilotAppendDevNoteToolCall === 'function') {
					kwEl.copilotAppendDevNoteToolCall(
						message.action || 'save',
						detail,
						message.result || '',
						message.entryId || ''
					);
				} else {
					const sqlEl = boxId ? __kustoGetSqlSectionElement(boxId) : null;
					if (sqlEl && typeof sqlEl.copilotAppendDevNoteToolCall === 'function') {
						sqlEl.copilotAppendDevNoteToolCall(
							message.action || 'save',
							detail,
							message.result || '',
							message.entryId || ''
						);
					}
				}
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'revealSection':
			try {
				const boxId = String(message.boxId || '');
				if (boxId) {
					const el = document.getElementById(boxId) as any;
					if (el) {
						if (typeof el.setCopilotChatVisible === 'function') { el.setCopilotChatVisible(true); }
						if (typeof el.setExpanded === 'function') { el.setExpanded(true); }
						try { el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch { /* ignore */ }
						if (typeof el.focusCopilotChatInput === 'function') { el.focusCopilotChatInput(); }
					}
				}
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'copilotClarifyingQuestion':
			try {
				const boxId = String(message.boxId || '');
				const interactive = message.responseTarget !== 'calling-agent';
				const kwEl = boxId ? __kustoGetQuerySectionElement(boxId) : null;
				if (kwEl && typeof kwEl.copilotAppendClarifyingQuestion === 'function') {
					kwEl.copilotAppendClarifyingQuestion(
						message.question || '',
						message.entryId || '',
						interactive,
					);
					if (interactive) {
						if (typeof kwEl.setExpanded === 'function') { kwEl.setExpanded(true); }
						try { kwEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch { /* ignore */ }
					}
				} else {
					const sqlEl = boxId ? __kustoGetSqlSectionElement(boxId) : null;
					if (sqlEl && typeof sqlEl.copilotAppendClarifyingQuestion === 'function') {
						sqlEl.copilotAppendClarifyingQuestion(
							message.question || '',
							message.entryId || ''
						);
						if (typeof sqlEl.setExpanded === 'function') { sqlEl.setExpanded(true); }
						try { sqlEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch { /* ignore */ }
					}
				}
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'copilotWriteQueryDone':
			try {
				const boxId = String(message.boxId || '');
				const kwEl = boxId ? __kustoGetQuerySectionElement(boxId) : null;
				if (kwEl && typeof kwEl.copilotWriteQueryDone === 'function') {
					kwEl.copilotWriteQueryDone(!!message.ok, message.message || '');
					if (kwEl.completeKustoCopilotRequest?.(message) === true) {
						emitAppliedKustoCopilotDone(message);
					}
				} else {
					const sqlEl = boxId ? __kustoGetSqlSectionElement(boxId) : null;
					if (sqlEl && typeof sqlEl.copilotWriteQueryDone === 'function') {
						sqlEl.copilotWriteQueryDone(!!message.ok, message.message || '');
					}
				}
			} catch (e) { console.error('[kusto]', e); }
			break;

		case 'copilotInlineCompletionResult':
			try {
				const requestId = message.requestId;
				const completions = message.completions;
				// Delegate to the handler registered by the inline completions provider.
				// This caches the result and re-triggers the inline suggest action.
				if (typeof _win.__kustoHandleInlineCompletionResult === 'function') {
					_win.__kustoHandleInlineCompletionResult(requestId, completions);
				}
			} catch (err: any) { console.error('[Kusto] Error handling completion result', err); }
			break;
		
		// ─────────────────────────────────────────────────────────────────────────
		// VS Code Copilot Chat Tool Orchestrator Messages
		// ─────────────────────────────────────────────────────────────────────────
		
		case 'requestToolState':
			// Extension is requesting the current sections state
			try {
				const requestId = message.requestId;
				if (requestId) {
					const state = getKqlxState();
					const sections = (state && state.sections) ? state.sections.map((section: any) => {
						if (section?.type === 'sql') {
							const sqlEl = __kustoGetSqlSectionElement(String(section.id || ''));
							return {
								...section,
								connectionId: String(sqlEl?.getSqlConnectionId?.() || section.connectionIdHint || ''),
								database: String(sqlEl?.getDatabase?.() || section.database || ''),
								ownerToken: String(sqlEl?.getCopilotOwnerToken?.() || ''),
							};
						}
						if (canonicalSectionKind(section?.type) !== 'query') return section;
						const boxId = String(section.id || '').trim();
						const connectionId = boxId ? String(__kustoGetConnectionId(boxId) || '').trim() : '';
						const database = boxId ? String(__kustoGetDatabase(boxId) || section.database || '').trim() : '';
						let requestToken = boxId ? String(schemaRequestTokenByBoxId[boxId] || '') : '';
						if (message.purpose === 'schema-refresh'
							&& connectionId === (message.targetConnectionId || '').trim()
							&& boxId && database) {
							const lease = kustoEditorSchemaCoordinator.getLease(boxId);
							if (lease) {
								const currentTarget = kustoEditorSchemaCoordinator.getTarget(boxId);
								kustoEditorSchemaCoordinator.setTarget(lease, connectionId, database, {
									connectionRevision: currentTarget?.connectionRevision,
									connectionIdentityKey: currentTarget?.connectionIdentityKey,
								});
								requestToken = `schema_tool_${Date.now()}_${Math.random().toString(16).slice(2)}`;
								const request = kustoEditorSchemaCoordinator.beginSchemaRequest(lease, requestToken);
								if (request) {
									schemaRequestTokenByBoxId[boxId] = requestToken;
									schemaFetchInFlightByBoxId[boxId] = false;
									lastSchemaRequestAtByBoxId[boxId] = 0;
									setKustoPreparationIdle(boxId);
								}
								else requestToken = '';
							}
						}
						const lifecycle = boxId ? kustoEditorSchemaCoordinator.getIdentity(boxId) : undefined;
						return connectionId ? {
							...section,
							connectionId,
							...(database ? { database } : {}),
							...(requestToken ? { schemaRequestToken: requestToken } : {}),
							...(lifecycle || {}),
						} : section;
					}) : [];
					const response = createToolStateResponseMessage(requestId, sections);
					if (response.ok) {
						postMessageToHost(response.value);
					} else {
						const unavailable = createToolStateResponseMessage(
							requestId,
							[],
							'The current tool state could not be captured.',
						);
						if (unavailable.ok) postMessageToHost(unavailable.value);
					}
				}
			} catch (err: any) {
				console.error('[Kusto Tools] Error getting state:', err);
				try {
					const response = createToolStateResponseMessage(message.requestId, []);
					if (response.ok) postMessageToHost(response.value);
				} catch (e) { console.error('[kusto]', e); }
			}
			break;
		
		case 'toolAddSection':
			// Add a new section via tool orchestrator
			try {
				const requestId = String(message.requestId || '');
				const input = message.input || {};
				const requestedSectionType = String(input.type || '').trim();
				const admission = getAddSectionAdmission(
					canonicalSectionKind(requestedSectionType) ?? requestedSectionType.toLowerCase(),
				);
				if (!admission.ok) {
					postMessageToHost({
						type: 'toolResponse', requestId, result: { sectionId: '', success: false }, error: admission.error,
					});
					break;
				}
				const sectionType = admission.sectionKind;
				if ((sectionType === 'chart' || sectionType === 'transformation')
					&& Object.prototype.hasOwnProperty.call(input, 'dataSourceResultIndex')
					&& (typeof input.dataSourceResultIndex !== 'number'
						|| !Number.isSafeInteger(input.dataSourceResultIndex)
						|| input.dataSourceResultIndex < 0)) {
					postMessageToHost({
						type: 'toolResponse', requestId, result: { sectionId: '', success: false },
						error: 'dataSourceResultIndex must be a non-negative safe integer.',
					});
					break;
				}
				const textValue = input.text ?? input.content;
				const creationOptions: Record<string, unknown> = sectionType === 'query'
					? { ...(input.query ? { initialQuery: String(input.query) } : {}) }
					: sectionType === 'sql'
						? { ...(input.query ? { query: String(input.query) } : {}) }
						: sectionType === 'chart'
							? {
								...(input.name !== undefined ? { name: String(input.name) } : {}),
								...(input.dataSourceId !== undefined ? { dataSourceId: String(input.dataSourceId) } : {}),
								...(input.dataSourceResultIndex !== undefined ? { dataSourceResultIndex: input.dataSourceResultIndex } : {}),
								...(input.chartType !== undefined ? { chartType: String(input.chartType) } : {}),
							}
						: sectionType === 'transformation'
							? {
								...(input.name !== undefined ? { name: String(input.name) } : {}),
								...(input.dataSourceId !== undefined ? { dataSourceId: String(input.dataSourceId) } : {}),
								...(input.dataSourceResultIndex !== undefined ? { dataSourceResultIndex: input.dataSourceResultIndex } : {}),
							}
						: sectionType === 'markdown'
							? { ...(textValue !== undefined ? { text: String(textValue) } : {}) }
							: sectionType === 'python'
								? { ...(input.code !== undefined ? { code: String(input.code) } : {}) }
							: sectionType === 'html'
								? { ...(input.code ? { code: String(input.code) } : {}) }
								: sectionType === 'url'
										? {
											...(input.url ? { url: String(input.url) } : {}),
											...(input.name ? { name: String(input.name) } : {}),
										}
									: {};
				const creation = createSectionWithCapabilities(sectionType, creationOptions);
				const sectionId = creation.ok ? creation.sectionId : '';
				let success = creation.ok;
				let creationError = creation.ok ? undefined : creation.error;
				if (sectionId && input.name && sectionType !== 'url') __kustoSetSectionName(sectionId, input.name);
				if (success && sectionType === 'query' && (input.clusterUrl || input.connectionId || input.database)) {
					const applied = applyToolKustoTarget(sectionId, input);
					if (!applied.success) {
						success = false;
						creationError = applied.error;
					}
				}
				
				if (success && sectionId) { markSectionAgentTouched(sectionId); }
				try { schedulePersist(undefined, true); } catch (e) { console.error('[kusto]', e); }
				if (success && (sectionType === 'chart' || sectionType === 'html'
					|| sectionType === 'transformation' || sectionType === 'markdown'
					|| sectionType === 'python' || sectionType === 'url')
					&& isHostOwnedMarkdownDocument()) {
					success = await waitForHostOwnedMarkdownCommands();
					if (!success) creationError = 'The host rejected the document section command.';
				}
				postMessageToHost({
					type: 'toolResponse', requestId, result: { sectionId, success },
					error: success ? undefined : creationError || 'Failed to add section',
				});
			} catch (err: any) {
				console.error('[Kusto Tools] Error in toolAddSection:', err);
				postMessageToHost({ type: 'toolResponse', requestId: message.requestId, result: { success: false }, error: err.message || String(err) });
			}
			break;
		
		case 'toolRemoveSection':
			// Remove a section by ID
			try {
				const requestId = String(message.requestId || '');
				const sectionId = String(message.sectionId || '');
				let success = false;
				let removalError = 'Section not found';
				let removedSectionType = '';
				
				try {
					if (!sectionId) {
						success = false;
					} else if (isPinnedFirstSection(sectionId)) {
						removalError = 'The first section is pinned and cannot be removed from a compatibility document.';
					} else {
						const sectionEl = document.getElementById(sectionId) as any;
						const tagName = String(sectionEl?.tagName || '').toLowerCase();
						let sectionType = tagName === 'kw-query-section' ? 'query'
							: tagName === 'kw-chart-section' ? 'chart'
								: tagName === 'kw-transformation-section' ? 'transformation'
									: tagName === 'kw-markdown-section' ? 'markdown'
										: tagName === 'kw-python-section' ? 'python'
											: tagName === 'kw-url-section' ? 'url'
												: tagName === 'kw-html-section' ? 'html'
													: tagName === 'kw-sql-section' ? 'sql'
														: '';
						if (!sectionType) {
							try {
								const serializedType = String(sectionEl?.serialize?.()?.type || '');
								sectionType = canonicalSectionKind(serializedType) ?? serializedType.toLowerCase();
							} catch { /* use ID fallback for legacy elements */ }
						}
						if (!sectionType) {
							if (tagName === 'kw-query-section' || sectionId.startsWith('query_')) sectionType = 'query';
							else if (tagName === 'kw-chart-section' || sectionId.startsWith('chart_')) sectionType = 'chart';
							else if (tagName === 'kw-transformation-section' || sectionId.startsWith('transformation_')) sectionType = 'transformation';
							else if (tagName === 'kw-markdown-section' || sectionId.startsWith('markdown_')) sectionType = 'markdown';
							else if (tagName === 'kw-python-section' || sectionId.startsWith('python_')) sectionType = 'python';
							else if (tagName === 'kw-url-section' || sectionId.startsWith('url_')) sectionType = 'url';
							else if (tagName === 'kw-html-section' || sectionId.startsWith('html_')) sectionType = 'html';
							else if (tagName === 'kw-sql-section' || sectionId.startsWith('sql_')) sectionType = 'sql';
						}
						removedSectionType = sectionType;
						if (sectionType === 'query') { removeQueryBox(sectionId); success = true; }
						else if (sectionType === 'chart') { removeChartBox(sectionId); success = true; }
						else if (sectionType === 'transformation') { removeTransformationBox(sectionId); success = true; }
						else if (sectionType === 'markdown') { removeMarkdownBox(sectionId); success = true; }
						else if (sectionType === 'python') { removePythonBox(sectionId); success = true; }
						else if (sectionType === 'url') { removeUrlBox(sectionId); success = true; }
						else if (sectionType === 'html') { removeHtmlBox(sectionId); success = true; }
						else if (sectionType === 'sql') { removeSqlBox(sectionId); success = true; }
					}

					if (success) {
						agentTouchedStateBySectionId.delete(sectionId);
						if (queryEditors && queryEditors[sectionId]) {
							delete queryEditors[sectionId];
						}
					}
				} catch (err: any) {
					console.error('[Kusto Tools] Error removing section:', err);
				}
				
				if (success) {
					try { schedulePersist(undefined, true); } catch (e) { console.error('[kusto]', e); }
				}
				if (success && (removedSectionType === 'chart' || removedSectionType === 'html'
					|| removedSectionType === 'transformation'
					|| removedSectionType === 'markdown' || removedSectionType === 'python'
					|| removedSectionType === 'url') && isHostOwnedMarkdownDocument()) {
					success = await waitForHostOwnedMarkdownCommands();
					if (!success) removalError = 'The host rejected the document section command.';
				}
				postMessageToHost({ type: 'toolResponse', requestId, result: { success }, error: success ? undefined : removalError });
			} catch (err: any) {
				postMessageToHost({ type: 'toolResponse', requestId: message.requestId, result: { success: false }, error: err.message || String(err) });
			}
			break;
		
		case 'toolCollapseSection':
			// Collapse or expand a section
			try {
				const requestId = String(message.requestId || '');
				const sectionId = String(message.sectionId || '');
				const collapsed = !!message.collapsed;
				const beforeSignature = getSectionSerializedSignature(sectionId);
				let success = false;
				
				try {
					const sectionEl = document.getElementById(sectionId) as any;
					if (sectionEl && typeof sectionEl.setExpanded === 'function') {
						sectionEl.setExpanded(!collapsed);
						success = true;
						const sectionTag = sectionEl.tagName?.toLowerCase();
						if (sectionTag === 'kw-url-section' && isHostOwnedMarkdownDocument()) {
							success = commitUrlDocumentState(sectionId)
								&& await waitForHostOwnedMarkdownCommands();
						} else if (sectionTag === 'kw-chart-section' && isHostOwnedMarkdownDocument()) {
							success = await waitForHostOwnedMarkdownCommands();
						} else if (sectionTag === 'kw-html-section' && isHostOwnedMarkdownDocument()) {
							success = commitHtmlDocumentState(sectionId)
								&& await waitForHostOwnedMarkdownCommands();
						} else if (sectionTag === 'kw-transformation-section' && isHostOwnedMarkdownDocument()) {
							success = await waitForHostOwnedMarkdownCommands();
						} else if (sectionTag === 'kw-python-section' && isHostOwnedMarkdownDocument()) {
							success = await waitForHostOwnedMarkdownCommands();
						} else if (sectionTag === 'kw-markdown-section' && isHostOwnedMarkdownDocument()) {
							success = await waitForHostOwnedMarkdownCommands();
						}
					}
				} catch (err: any) {
					console.error('[Kusto Tools] Error collapsing section:', err);
				}
				
				if (success) { markSectionAgentTouched(sectionId, beforeSignature); }
				postMessageToHost({ type: 'toolResponse', requestId, result: { success }, error: success ? undefined : 'Failed to collapse/expand section' });
				if (success) {
					try { schedulePersist(undefined, true); } catch (e) { console.error('[kusto]', e); }
				}
			} catch (err: any) {
				postMessageToHost({ type: 'toolResponse', requestId: message.requestId, result: { success: false }, error: err.message || String(err) });
			}
			break;
		
		case 'toolReorderSections':
			// Reorder all sections in the notebook
			try {
				const requestId = String(message.requestId || '');
				const rawSectionIds = Array.isArray(message.sectionIds) ? message.sectionIds.map((id: any) => String(id)) : [];
				const hiddenDevelopmentNoteIds = new Set(
					(isHostOwnedDevelopmentNoteDocument()
						? getOptimisticHostOwnedDevelopmentNoteSections()
						: pState.metadataFreeDevelopmentNoteSections
							.filter((section: any) => section?.type === 'devnotes'))
						.map((section: any) => String(section.id || '').trim())
						.filter(Boolean),
				);
				const sectionIds = rawSectionIds.filter((id: any) => !hiddenDevelopmentNoteIds.has(id.trim()));
				let success = false;
				let error = '';
				
				try {
					const container = document.getElementById('queries-container');
					if (!container) {
						error = 'Container not found';
					} else {
						// Get current section elements (all direct children with an id)
						const currentIds = Array.from(container.children)
							.map((el: any) => el.id)
							.filter((id: any) => id);
						
						// Validate: all current IDs must be in the new order
						const missingIds = currentIds.filter((id: any) => !sectionIds.includes(id));
						const unknownIds = sectionIds.filter((id: any) => !currentIds.includes(id));
						
						if (missingIds.length > 0) {
							error = 'Missing section IDs in reorder list: ' + missingIds.join(', ');
						} else if (unknownIds.length > 0) {
							error = 'Unknown section IDs: ' + unknownIds.join(', ');
						} else if (pState.firstSectionPinned && currentIds.length > 0 && sectionIds[0] !== currentIds[0]) {
							error = 'The first section is pinned and cannot be moved. Its content is stored in the .kql/.csl file.';
						} else {
							// Reorder: move sections to match the new order
							for (const sectionId of sectionIds) {
								const el = document.getElementById(sectionId) as any;
								if (el && el.parentNode === container) {
									container.appendChild(el);
								}
							}
							success = true;
						}
					}
				} catch (err: any) {
					console.error('[Kusto Tools] Error reordering sections:', err);
					error = err.message || String(err);
				}
				
				postMessageToHost({ type: 'toolResponse', requestId, result: { success, error: error || undefined }, error: success ? undefined : (error || 'Failed to reorder sections') });
				try { schedulePersist(undefined, true); } catch (e) { console.error('[kusto]', e); }
			} catch (err: any) {
				postMessageToHost({ type: 'toolResponse', requestId: message.requestId, result: { success: false }, error: err.message || String(err) });
			}
			break;
		
		case 'toolConfigureQuerySection': {
			const requestId = String(message.requestId || '');
			const input = message.input || {};
			const sectionId = String(input.sectionId || '');
			const configureRuntimeEpoch = kustoToolConfigureRuntimeEpoch;
			const configureLease = reserveKustoToolConfigureLease(sectionId);
			let success = false;
			let deferResponse = false;
			let failureError = '';
			let executionFenceHeld = false;
			const priorConfigure = configureLease.waitForTurn();
			if (priorConfigure) await priorConfigure;
			const runtimeIsCurrent = () => configureRuntimeEpoch === kustoToolConfigureRuntimeEpoch
				&& isDocumentMutationAllowed();
			let sectionOwner = __kustoGetQuerySectionElement(sectionId);
			const beforeSignature = getSectionSerializedSignature(sectionId);
			const persistedMutationRequested = input.name !== undefined || input.query !== undefined
				|| !!(input.clusterUrl || input.connectionId || input.database);
			const throwIfCancelled = () => {
				if (cancelledKustoToolRequestIds.delete(requestId)) {
					throw new Error('Query was cancelled');
				}
			};
			const sectionIsCurrent = () => !!sectionOwner
				&& runtimeIsCurrent()
				&& __kustoGetQuerySectionElement(sectionId) === sectionOwner;
			const ensureConfigurationOwned = async (
				expectedSignature: string,
			): Promise<'accepted' | 'reconciled' | undefined> => {
				const persisted = await persistDocumentAndWaitForAck('tool-configure-query');
				if (!runtimeIsCurrent()) return undefined;
				if (persisted) {
					return sectionIsCurrent() && getSectionSerializedSignature(sectionId) === expectedSignature
						? 'accepted'
						: undefined;
				}
				const rejectedRevision = pState.documentEditRevision;
				if (!sectionIsCurrent() || getSectionSerializedSignature(sectionId) !== expectedSignature) return undefined;
				const reconciled = await reconcileDocumentWithHost(10000, rejectedRevision);
				if (!runtimeIsCurrent()) return undefined;
				if (!reconciled) {
					if (pState.documentEditRevision === rejectedRevision
						&& sectionIsCurrent()
						&& getSectionSerializedSignature(sectionId) === expectedSignature) {
						lockDocumentAfterPersistenceFailure();
					}
					return undefined;
				}
				sectionOwner = __kustoGetQuerySectionElement(sectionId);
				return !!sectionOwner && getSectionSerializedSignature(sectionId) === expectedSignature
					? 'reconciled'
					: undefined;
			};
			try {
				try {
					if (!runtimeIsCurrent()) throw new Error('The document runtime changed before configuration could start.');
					throwIfCancelled();
					if (input.name !== undefined && pState.compatibilityMode
						&& (pState.documentKind === 'kql' || pState.documentKind === 'sql')) {
						throw new Error('Section names require a companion metadata file. Upgrade this compatibility document before setting a name.');
					}
					if (input.execute) {
						const requestedRetarget = !!(input.clusterUrl || input.connectionId);
						if (requestedRetarget && !String(input.database || '').trim()) {
							throw new Error('database is required when retargeting and executing a Kusto query section.');
						}
						const resolved = resolveToolKustoConnection(input);
						if (resolved.error) throw new Error(resolved.error);
						const effectiveConnectionId = String(resolved.connection?.id || __kustoGetConnectionId(sectionId) || '').trim();
						const effectiveDatabase = String(input.database || __kustoGetDatabase(sectionId) || '').trim();
						if (!effectiveConnectionId || !effectiveDatabase) {
							throw new Error('A cluster connection and database are required before executing a Kusto query section.');
						}
					}
					if (!sectionOwner) throw new Error(`Query section "${sectionId}" was not found.`);
					if (optimizationMetadataByBoxId[sectionId]?.isComparison
						&& (input.clusterUrl || input.connectionId || input.database)) {
						throw new Error('A Kusto comparison target is owned by its source section and cannot be retargeted independently.');
					}
					if (input.execute) {
						if (!acquireKustoToolExecutionFence(sectionId, requestId)) {
							throw new Error('Another query configuration is still settling for this section.');
						}
						executionFenceHeld = true;
					}
					const resolvedTarget = resolveToolKustoConnection(input);
					if (resolvedTarget.error) throw new Error(resolvedTarget.error);
					let editor = queryEditors?.[sectionId];
					if (input.query !== undefined) {
						if (!editor?.setValue) editor = await waitForQueryEditorReady(sectionId, 10000, sectionOwner);
						if (!runtimeIsCurrent()) throw new Error('The document runtime changed while the query editor was becoming ready.');
						throwIfCancelled();
						if (!sectionIsCurrent()) throw new Error(`Query section "${sectionId}" changed before its editor became ready.`);
						if (!editor?.setValue) throw new Error(`Query section "${sectionId}" editor is not ready.`);
					}
					throwIfCancelled();
					if (!sectionIsCurrent()) throw new Error(`Query section "${sectionId}" changed before configuration could apply.`);
					if (input.name !== undefined) { __kustoSetSectionName(sectionId, input.name); success = true; }
					if (input.query !== undefined) {
						editor.setValue(String(input.query));
						success = true;
					}
					if (input.clusterUrl || input.connectionId || input.database) {
						const applied = applyToolKustoTarget(sectionId, input);
						if (!applied.success) throw new Error(applied.error);
						success = true;
					}
					if (input.execute) {
						setRunMode(sectionId, 'plain');
						const configuredSignature = getSectionSerializedSignature(sectionId);
						const configuredOperationalState = captureKustoToolOperationalState(sectionId);
						const configurationChanged = persistedMutationRequested || configuredSignature !== beforeSignature;
						if (configurationChanged) {
							const ownership = await ensureConfigurationOwned(configuredSignature);
							if (!ownership) throw new Error('The configured query was not accepted by the document host.');
							if (ownership === 'reconciled') {
								editor = await waitForQueryEditorReady(sectionId, 10000, sectionOwner);
								if (!editor) throw new Error('The reconciled query editor is not ready.');
							}
						}
						throwIfCancelled();
						const dispatchOperationalState = captureKustoToolOperationalState(sectionId);
						if (!sectionIsCurrent()
							|| getSectionSerializedSignature(sectionId) !== configuredSignature
							|| !sameToolOperationalConfiguration(configuredOperationalState, dispatchOperationalState)
							|| !sameToolOperationalState(
								dispatchOperationalState,
								captureKustoToolOperationalState(sectionId),
							)) {
							throw new Error('The query section changed before execution could start.');
						}
						deferResponse = true;
						let responded = false;
						let executionId = '';
						const modelConsumerIds = new Set<string>([indexedModelConsumerId(requestId, 0)]);
						const cleanup = () => {
							try { window.removeEventListener(ADMITTED_KUSTO_TERMINAL_EVENT, resultHandler as EventListener); } catch { /* best effort */ }
							try { kustoToolExecutionOwnerByRequestId.delete(requestId); } catch { /* best effort */ }
							try { kustoToolExecutionSettlementByRequestId.delete(requestId); } catch { /* best effort */ }
							try { cancelledKustoToolRequestIds.delete(requestId); } catch { /* best effort */ }
							releaseModelResultConsumers(modelConsumerIds);
						};
						const respond = (result: unknown) => {
							if (responded) return;
							responded = true;
							cleanup();
							postMessageToHost({ type: 'toolResponse', requestId, result });
						};
						const resultHandler = (event: Event) => {
							try {
								const terminal = (event as CustomEvent).detail;
								if (!executionId || terminal?.executionId !== executionId || terminal?.boxId !== sectionId) return;
								if (terminal.type === 'queryResult') {
									const artifacts = bindModelResultArtifacts(
										requestId, sectionId, executionId, terminal.result, modelConsumerIds,
									);
									if (!artifacts?.length) {
										respond({ success: false, error: 'Query results are not permitted for model use.' });
										return;
									}
									const resultSets = projectModelResultSets(artifacts, 5);
									const primary = resultSets[0];
									respond({
										success: true, rowCount: primary.rowCount, columns: primary.columns,
										resultPreview: JSON.stringify({
											columns: primary.columns, rows: primary.results, totalRows: primary.rowCount,
										}, null, 2),
										resultSets,
									});
								} else if (terminal.type === 'queryError') respond({ success: false, error: terminal.error || 'Query execution failed' });
								else if (terminal.type === 'queryCancelled') respond({ success: false, error: 'Query was cancelled' });
							} catch (error) {
								respond({ success: false, error: error instanceof Error ? error.message : String(error) });
							}
						};
						kustoToolExecutionSettlementByRequestId.set(requestId, () => {
							respond({ success: false, error: 'Query was cancelled' });
						});
						window.addEventListener(ADMITTED_KUSTO_TERMINAL_EVENT, resultHandler as EventListener);
						try {
							executionId = executeQuery(
								sectionId, undefined, 'tool', undefined, 'all', requestId,
							) || '';
							const owner = __kustoGetQuerySectionElement(sectionId)?.getActiveExecution?.();
							if (!executionId || !owner) respond({ success: false, error: 'Query execution did not start.' });
							else {
								kustoToolExecutionOwnerByRequestId.set(requestId, owner);
								postMessageToHost({ type: 'toolExecutionStarted', requestId, owner });
							}
							success = true;
						} catch (error) {
							failureError = error instanceof Error ? error.message : String(error);
							respond({ success: false, error: failureError });
						}
					}
				} catch (error) {
					console.error('[Kusto Tools] Error configuring query section:', error);
					success = false;
					failureError = error instanceof Error ? error.message : String(error);
				}
				if (success) markSectionAgentTouched(sectionId, beforeSignature);
				if (!deferResponse && success) {
					const configuredSignature = getSectionSerializedSignature(sectionId);
					if (!await ensureConfigurationOwned(configuredSignature)) {
						success = false;
						failureError = 'The configured query was not accepted by the document host.';
					}
				}
				if (!deferResponse) {
					postMessageToHost({
						type: 'toolResponse', requestId, result: { success, resultPreview: '' },
						error: success ? undefined : (failureError || 'Failed to configure query section'),
					});
				}
			} finally {
				if (executionFenceHeld) releaseKustoToolExecutionFence(sectionId, requestId);
				configureLease.settle();
				if (!deferResponse) cancelledKustoToolRequestIds.delete(requestId);
			}
			break;
		}

		case 'toolCancelKustoExecution': {
			const requestId = String(message.requestId || '');
			const owner = message.owner || kustoToolExecutionOwnerByRequestId.get(requestId);
			const settleCancellation = kustoToolExecutionSettlementByRequestId.get(requestId);
			if (!owner) {
				if (settleCancellation) settleCancellation();
				else if (requestId) cancelledKustoToolRequestIds.add(requestId);
				break;
			}
			try {
				const section = __kustoGetQuerySectionElement(owner.boxId);
				const active = section?.getActiveExecution?.();
				if (active?.executionId === owner.executionId
					&& active.sectionInstanceId === owner.sectionInstanceId
					&& active.targetGeneration === owner.targetGeneration) {
					(window as any).cancelQuery?.(owner.boxId);
				}
			} finally {
				settleCancellation?.();
			}
			break;
		}

		case 'toolCancelKustoCopilot': {
			const requestId = String(message.requestId || '');
			const owner = kustoCopilotToolOwnerByRequestId.get(requestId);
			if (!owner) {
				if (requestId) cancelledKustoToolRequestIds.add(requestId);
				break;
			}
			__kustoGetQuerySectionElement(owner.boxId)?.cancelKustoCopilotRequest?.(owner);
			break;
		}
		
		case 'toolUpdateMarkdownSection':
			// Update a markdown section
			try {
				const requestId = String(message.requestId || '');
				const input = message.input || {};
				const sectionId = String(input.sectionId || '');
				const beforeSignature = getSectionSerializedSignature(sectionId);
				let success = false;
				const sectionElement = document.getElementById(sectionId);
				if (!sectionElement || sectionElement.tagName.toLowerCase() !== 'kw-markdown-section') {
					postMessageToHost({
						type: 'toolResponse', requestId, result: { success: false }, error: 'Markdown section not found',
					});
					break;
				}
				
				try {
					// Update section name if provided
					if (input.name !== undefined) {
						__kustoSetSectionName(sectionId, input.name);
						success = true;
					}
					
					// Accept both 'text' and 'content' - LLMs may use either property name
					const textValue = input.text ?? input.content;
					if (textValue !== undefined) {
						const textToSet = String(textValue);
						pState.pendingMarkdownTextByBoxId = pState.pendingMarkdownTextByBoxId || {};
						pState.pendingMarkdownTextByBoxId[sectionId] = textToSet;
						
						// Try to update existing editor (exposed on window from extraBoxes.js)
						const editorInstance = window.__kustoMarkdownEditors && window.__kustoMarkdownEditors[sectionId];
						if (editorInstance && typeof editorInstance.setValue === 'function') {
							editorInstance.setValue(textToSet);
							delete pState.pendingMarkdownTextByBoxId[sectionId];
							success = true;
							
							// Fit to contents after updating - with retries to handle async layout
							const fitToContents = () => {
								try {
									__kustoMaximizeMarkdownBox(sectionId);
								} catch (e) { console.error('[kusto]', e); }
							};
							// Apply immediately and with delays to handle async editor layout
							fitToContents();
							setTimeout(fitToContents, 100);
							setTimeout(fitToContents, 300);
							// If currently in Preview mode, re-render the viewer immediately
							try {
								if (typeof window.__kustoApplyMarkdownEditorMode === 'function') {
									window.__kustoApplyMarkdownEditorMode(sectionId);
								}
							} catch (e) { console.error('[kusto]', e); }
						} else {
							// Editor not initialized yet - text will be applied when editor initializes
							// from __kustoPendingMarkdownTextByBoxId
							success = true;
						}
					}
					
					if (input.mode && typeof window.__kustoSetMarkdownMode === 'function') {
						window.__kustoSetMarkdownMode(sectionId, input.mode);
						success = true;
					}
				} catch (err: any) {
					console.error('[Kusto Tools] Error updating markdown section:', err);
				}
				
				if (success) { markSectionAgentTouched(sectionId, beforeSignature); }
				if (success) success = commitMarkdownDocumentState(sectionId);
				try { schedulePersist(undefined, true); } catch (e) { console.error('[kusto]', e); }
				if (success && isHostOwnedMarkdownDocument()) {
					success = await waitForHostOwnedMarkdownCommands();
				}
				postMessageToHost({ type: 'toolResponse', requestId, result: { success }, error: success ? undefined : 'Failed to update markdown section' });
			} catch (err: any) {
				postMessageToHost({ type: 'toolResponse', requestId: message.requestId, result: { success: false }, error: err.message || String(err) });
			}
			break;
		
		case 'toolConfigureChart':
			// Configure a chart section
			try {
				const requestId = String(message.requestId || '');
				const input = message.input || {};
				const sectionId = String(input.sectionId || '');
				const beforeSignature = getSectionSerializedSignature(sectionId);
				let success = false;
				let validationStatus: any = null;
				
				try {
					if (Object.prototype.hasOwnProperty.call(input, 'dataSourceResultIndex')
						&& (typeof input.dataSourceResultIndex !== 'number'
							|| !Number.isSafeInteger(input.dataSourceResultIndex)
							|| input.dataSourceResultIndex < 0)) {
						postMessageToHost({
							type: 'toolResponse', requestId,
							result: { success: false }, error: 'dataSourceResultIndex must be a non-negative safe integer.',
						});
						break;
					}
					// Validate that the target section is actually a chart
					const chartEl = document.getElementById(sectionId);
					if (!chartEl || chartEl.tagName !== 'KW-CHART-SECTION') {
						postMessageToHost({
							type: 'toolResponse',
							requestId,
							result: {
								success: false,
								error: `Section '${sectionId}' is not a chart section. Use configureQuerySection for query sections.`,
							}
						});
						break;
					}
					const chartState = typeof (chartEl as any).serialize === 'function'
						? (chartEl as any).serialize()
						: {};
					const unavailableResultError = Object.prototype.hasOwnProperty.call(input, 'dataSourceResultIndex')
						? getUnavailableResultIndexError(
							'dataSourceResultIndex', input.dataSourceId ?? chartState.dataSourceId,
							input.dataSourceResultIndex,
						)
						: undefined;
					if (unavailableResultError) {
						postMessageToHost({
							type: 'toolResponse', requestId,
							result: { success: false }, error: unavailableResultError,
						});
						break;
					}

					// Update section name if provided
					if (input.name !== undefined) {
						__kustoSetSectionName(sectionId, input.name);
						success = true;
					}
					
					// Apply chart configuration
					if (typeof window.__kustoConfigureChart === 'function') {
						success = window.__kustoConfigureChart(sectionId, input) === true;
					} else {
						// Fallback: store in pending state
						window.__kustoPendingChartConfig = window.__kustoPendingChartConfig || {};
						window.__kustoPendingChartConfig[sectionId] = input;
						success = true;
					}
					
					// Get validation status to help agent verify configuration
					validationStatus = __kustoGetChartValidationStatus(sectionId);
				} catch (err: any) {
					console.error('[Kusto Tools] Error configuring chart:', err);
				}
				
				if (success) { markSectionAgentTouched(sectionId, beforeSignature); }
				if (success && isHostOwnedMarkdownDocument()) {
					success = await waitForHostOwnedMarkdownCommands();
				}
				// Include validation status in response so agent can verify configuration worked
				const result = { success, ...( validationStatus ? { validation: validationStatus } : {}) };
				try { schedulePersist(undefined, true); } catch (e) { console.error('[kusto]', e); }
				postMessageToHost({ type: 'toolResponse', requestId, result, error: success ? undefined : 'Failed to configure chart' });
			} catch (err: any) {
				postMessageToHost({ type: 'toolResponse', requestId: message.requestId, result: { success: false }, error: err.message || String(err) });
			}
			break;
		
		case 'toolConfigureTransformation':
			// Configure a transformation section
			try {
				const requestId = String(message.requestId || '');
				const input = message.input || {};
				const sectionId = String(input.sectionId || '');
				const beforeSignature = getSectionSerializedSignature(sectionId);
				let success = false;
				
				try {
					let invalidResultIndexField = '';
					for (const key of ['dataSourceResultIndex', 'joinRightDataSourceResultIndex'] as const) {
						if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
						if (typeof input[key] !== 'number' || !Number.isSafeInteger(input[key]) || input[key] < 0) {
							invalidResultIndexField = key;
							break;
						}
					}
					if (invalidResultIndexField) {
						postMessageToHost({
							type: 'toolResponse', requestId, result: { success: false },
							error: `${invalidResultIndexField} must be a non-negative safe integer.`,
						});
						break;
					}
					const transformationEl = document.getElementById(sectionId);
					if (!transformationEl || transformationEl.tagName !== 'KW-TRANSFORMATION-SECTION') {
						postMessageToHost({
							type: 'toolResponse', requestId,
							result: { success: false },
							error: `Section '${sectionId}' is not a transformation section.`,
						});
						break;
					}
					const transformationState = typeof (transformationEl as any).serialize === 'function'
						? (transformationEl as any).serialize()
						: {};
					let unavailableResultError: string | undefined;
					if (Object.prototype.hasOwnProperty.call(input, 'dataSourceResultIndex')) {
						unavailableResultError = getUnavailableResultIndexError(
							'dataSourceResultIndex', input.dataSourceId ?? transformationState.dataSourceId,
							input.dataSourceResultIndex,
						);
					}
					if (!unavailableResultError
						&& Object.prototype.hasOwnProperty.call(input, 'joinRightDataSourceResultIndex')) {
						unavailableResultError = getUnavailableResultIndexError(
							'joinRightDataSourceResultIndex',
							input.joinRightDataSourceId ?? transformationState.joinRightDataSourceId,
							input.joinRightDataSourceResultIndex,
						);
					}
					if (unavailableResultError) {
						postMessageToHost({
							type: 'toolResponse', requestId,
							result: { success: false }, error: unavailableResultError,
						});
						break;
					}
					// Update section name if provided
					if (input.name !== undefined) {
						__kustoSetSectionName(sectionId, input.name);
						success = true;
					}
					
					// Apply transformation configuration
					if (typeof window.__kustoConfigureTransformation === 'function') {
						success = window.__kustoConfigureTransformation(sectionId, input) === true;
					} else {
						// Fallback: store in pending state
						window.__kustoPendingTransformationConfig = window.__kustoPendingTransformationConfig || {};
						window.__kustoPendingTransformationConfig[sectionId] = input;
						success = true;
					}
				} catch (err: any) {
					console.error('[Kusto Tools] Error configuring transformation:', err);
				}
				
				if (success) { markSectionAgentTouched(sectionId, beforeSignature); }
				if (success && isHostOwnedMarkdownDocument()) {
					success = commitTransformationDocumentState(sectionId)
						&& await waitForHostOwnedMarkdownCommands();
				}
				try { schedulePersist(undefined, true); } catch (e) { console.error('[kusto]', e); }
				postMessageToHost({ type: 'toolResponse', requestId, result: { success }, error: success ? undefined : 'Failed to configure transformation' });
			} catch (err: any) {
				postMessageToHost({ type: 'toolResponse', requestId: message.requestId, result: { success: false }, error: err.message || String(err) });
			}
			break;
		
		case 'toolConfigureHtmlSection':
			try {
				const requestId = String(message.requestId || '');
				const sectionId = String(message.sectionId || '');
				let success = false;
				let shouldAutoFit = false;
				let beforeSignature = '';
				
				try {
					const el = document.getElementById(sectionId) as any;
					if (el?.tagName === 'KW-HTML-SECTION' && typeof el.setCode === 'function') {
						beforeSignature = getSectionSerializedSignature(sectionId);
						if (typeof message.name === 'string') {
							__kustoSetSectionName(sectionId, message.name);
						}
						if (typeof message.code === 'string') {
							let codeChanged = true;
							try {
								if (typeof el.getCode === 'function') codeChanged = el.getCode() !== message.code;
							} catch (e) { console.error('[kusto]', e); }
							el.setCode(message.code);
							shouldAutoFit = shouldAutoFit || codeChanged;
						}
						if (typeof message.mode === 'string') {
							let modeChanged = true;
							try {
								if (typeof el.getMode === 'function') modeChanged = el.getMode() !== message.mode;
							} catch (e) { console.error('[kusto]', e); }
							el.setMode(message.mode);
							shouldAutoFit = shouldAutoFit || modeChanged;
						}
						const hasManualPreviewHeight = typeof el.getMode === 'function'
							&& el.getMode() === 'preview'
							&& el.previewHeightUserSet === true;
						if (shouldAutoFit && !hasManualPreviewHeight && typeof el.fitToContents === 'function') {
							if (document.getElementById(sectionId) === el) {
								try { el.fitToContents(); } catch (e) { console.error('[kusto]', e); }
							}
						}
						success = true;
					}
				} catch (err: any) {
					console.error('[Kusto Tools] Error configuring HTML section:', err);
				}
				
				if (success) { markSectionAgentTouched(sectionId, beforeSignature); }
				if (success && isHostOwnedMarkdownDocument()) {
					success = commitHtmlDocumentState(sectionId)
						&& await waitForHostOwnedMarkdownCommands();
				}
				// Immediate persist (no 400ms debounce) — the tool response is sent right
				// after this, and the host may save/close before a debounced persist fires.
				if (success) {
					try { schedulePersist(undefined, true); } catch (e) { console.error('[kusto]', e); }
				}
				postMessageToHost({ type: 'toolResponse', requestId, result: { success, sectionId }, error: success ? undefined : 'Failed to configure HTML section' });
			} catch (err: any) {
				postMessageToHost({ type: 'toolResponse', requestId: message.requestId, result: { success: false }, error: err.message || String(err) });
			}
			break;

		case 'toolGetHtmlDashboardContext':
			try {
				const requestId = String(message.requestId || '');
				const sectionId = String(message.sectionId || '');
				let result: any = { success: false, sectionId, error: 'HTML section not found or does not support dashboard context.' };
				try {
					const el = document.getElementById(sectionId) as any;
					if (el && typeof el.getDashboardExportContext === 'function') {
						result = { success: true, ...el.getDashboardExportContext() };
					}
				} catch (err: any) {
					result = { success: false, sectionId, error: err?.message || String(err) };
				}
				postMessageToHost({ type: 'toolResponse', requestId, result, error: result.success ? undefined : result.error });
			} catch (err: any) {
				postMessageToHost({ type: 'toolResponse', requestId: message.requestId, result: { success: false }, error: err.message || String(err) });
			}
			break;

		// ── SQL tool messages ───────────────────────────────────────────

		case 'toolConfigureSqlSection': {
			const requestId = String(message.requestId || '');
			const input = message.input || {};
			const sectionId = String(input.sectionId || '');
			const executionId = String(input.executionId || '').trim();
			const configureRuntimeEpoch = kustoToolConfigureRuntimeEpoch;
			const configureLease = reserveSqlToolConfigureLease(sectionId);
			let reservedSqlElement: any;
			let reservedExecution: Promise<any> | undefined;
			const configuredSqlElements = new Set<any>();
			let success = false;
			try {
				const priorConfigure = configureLease.waitForTurn();
				if (priorConfigure) await priorConfigure;
				const runtimeIsCurrent = () => configureRuntimeEpoch === kustoToolConfigureRuntimeEpoch
					&& isDocumentMutationAllowed();
				const throwIfCancelled = () => {
					if (cancelledKustoToolRequestIds.delete(requestId)) throw new Error('Query was cancelled');
				};
				let sqlEl = __kustoGetSqlSectionElement(sectionId);
				const sectionIsCurrent = () => !!sqlEl && runtimeIsCurrent()
					&& __kustoGetSqlSectionElement(sectionId) === sqlEl;
				const ensureConfigurationOwned = async (
					expectedSignature: string,
				): Promise<'accepted' | 'reconciled' | undefined> => {
					const persisted = await persistDocumentAndWaitForAck('tool-configure-sql');
					if (!runtimeIsCurrent()) return undefined;
					if (persisted) {
						return sectionIsCurrent() && getSectionSerializedSignature(sectionId) === expectedSignature
							? 'accepted'
							: undefined;
					}
					const rejectedRevision = pState.documentEditRevision;
					if (!sectionIsCurrent() || getSectionSerializedSignature(sectionId) !== expectedSignature) return undefined;
					const reconciled = await reconcileDocumentWithHost(10000, rejectedRevision);
					if (!runtimeIsCurrent()) return undefined;
					if (!reconciled) {
						if (pState.documentEditRevision === rejectedRevision && sectionIsCurrent()
							&& getSectionSerializedSignature(sectionId) === expectedSignature) {
							lockDocumentAfterPersistenceFailure();
						}
						return undefined;
					}
					sqlEl = __kustoGetSqlSectionElement(sectionId);
					return !!sqlEl && getSectionSerializedSignature(sectionId) === expectedSignature
						? 'reconciled'
						: undefined;
				};

				if (!runtimeIsCurrent()) throw new Error('The document runtime changed before SQL configuration could start.');
				throwIfCancelled();
				if (input.name !== undefined && pState.compatibilityMode
					&& (pState.documentKind === 'kql' || pState.documentKind === 'sql')) {
					throw new Error('Section names require a companion metadata file. Upgrade this compatibility document before setting a name.');
				}
				if (!sqlEl) throw new Error(`SQL section "${sectionId}" was not found.`);
				if (sqlEl.isComparisonAdmissionPending?.() === true) {
					throw new Error('SQL comparison admission is still settling.');
				}
				if (input.execute) {
					if (!executionId || typeof sqlEl.beginToolConfiguration !== 'function'
						|| typeof sqlEl.reserveToolRun !== 'function'
						|| typeof sqlEl.startReservedToolRun !== 'function') {
						throw new Error('SQL section does not support tool execution reservation.');
					}
					sqlEl.beginToolConfiguration(executionId);
					configuredSqlElements.add(sqlEl);
				}
				let requestedConnection: any;
				if (input.connectionId || input.serverUrl || (input.execute && input.resolvedConnection)) {
					const requestedConnectionId = String(input.connectionId || input.resolvedConnection?.id || '');
					requestedConnection = (Array.isArray(sqlConnections) ? sqlConnections : []).find((candidate: any) =>
						candidate && (requestedConnectionId
							? String(candidate.id || '') === requestedConnectionId
							: String(candidate.serverUrl || '').toLowerCase().includes(String(input.serverUrl).toLowerCase()))
					) || (input.resolvedConnection && String(input.resolvedConnection.id || '') === requestedConnectionId
						? input.resolvedConnection
						: undefined);
					if (!requestedConnection || (requestedConnectionId && String(requestedConnection.id || '') !== requestedConnectionId)) {
						throw new Error('The exact requested SQL connection is not available in this editor.');
					}
					if (input.requestedTargetSignature
						&& sqlConnectionTargetSignature(requestedConnection) !== String(input.requestedTargetSignature)) {
						throw new Error('The requested SQL connection target changed before adoption.');
					}
					if (typeof sqlEl.configureToolTarget !== 'function') {
						throw new Error('SQL section does not support exact tool targeting.');
					}
				}
				throwIfCancelled();
				const beforeSignature = getSectionSerializedSignature(sectionId);
				if (requestedConnection) {
					sqlEl.configureToolTarget(
						requestedConnection,
						input.database !== undefined ? String(input.database) : undefined,
						input.execute ? input.expectedExecutionOwner : undefined,
					);
					success = true;
				}
				if (input.execute && input.expectedExecutionOwner
					&& !input.connectionId && !input.serverUrl && !input.resolvedConnection) {
					if (typeof sqlEl.setToolExpectedOwner !== 'function') {
						throw new Error('SQL section does not support exact tool ownership.');
					}
					sqlEl.setToolExpectedOwner(input.expectedExecutionOwner);
				}
				if (input.name !== undefined && typeof sqlEl.setName === 'function') {
					sqlEl.setName(String(input.name));
					success = true;
				}
				if (input.query !== undefined && typeof sqlEl.setQuery === 'function') {
					sqlEl.setQuery(String(input.query));
					success = true;
				}
				if (input.database && !input.connectionId && !input.serverUrl && !input.execute
					&& typeof sqlEl.setDatabase === 'function') {
					sqlEl.setDatabase(String(input.database));
					sqlEl.dispatchEvent(new CustomEvent('sql-database-changed', {
						detail: { boxId: sectionId, database: input.database, source: 'tool' },
						bubbles: true, composed: true,
					}));
					success = true;
				}
				if (input.execute) {
					try { setRunMode(sectionId, 'plain'); } catch (error) { console.error('[kusto]', error); }
				}
				const configuredSignature = getSectionSerializedSignature(sectionId);
				const configuredOperationalState = captureSqlToolOperationalState(sectionId);
				const configurationChanged = success || configuredSignature !== beforeSignature;
				if (configurationChanged) {
					const ownership = await ensureConfigurationOwned(configuredSignature);
					if (!ownership) throw new Error('The configured SQL query was not accepted by the document host.');
					if (ownership === 'reconciled' && input.execute) {
						if (!sqlEl || typeof sqlEl.beginToolConfiguration !== 'function'
							|| typeof sqlEl.reserveToolRun !== 'function'
							|| typeof sqlEl.startReservedToolRun !== 'function') {
							throw new Error('The reconciled SQL section does not support tool execution reservation.');
						}
						sqlEl.beginToolConfiguration(executionId);
						configuredSqlElements.add(sqlEl);
						if (input.expectedExecutionOwner) {
							if (typeof sqlEl.setToolExpectedOwner !== 'function') {
								throw new Error('The reconciled SQL section does not support exact tool ownership.');
							}
							sqlEl.setToolExpectedOwner(input.expectedExecutionOwner);
						}
					}
				}
				throwIfCancelled();
				const dispatchOperationalState = captureSqlToolOperationalState(sectionId);
				if (!sectionIsCurrent()
					|| getSectionSerializedSignature(sectionId) !== configuredSignature
					|| !sameToolOperationalConfiguration(configuredOperationalState, dispatchOperationalState)
					|| !sameToolOperationalState(
						dispatchOperationalState,
						captureSqlToolOperationalState(sectionId),
					)) {
					throw new Error('The SQL section changed before execution could start.');
				}
				if (configurationChanged) markSectionAgentTouched(sectionId, beforeSignature);
				let execution: any;
				if (input.execute) {
					reservedSqlElement = sqlEl;
					reservedExecution = sqlEl.reserveToolRun(executionId) as Promise<any>;
					void reservedExecution.catch(() => undefined);
					sqlEl.startReservedToolRun(executionId);
					execution = await reservedExecution!;
					success = true;
				}
				postMessageToHost({
					type: 'toolResponse', requestId,
					result: {
						success,
						...(execution ? {
							resultPreview: `${execution.rowCount} row${execution.rowCount === 1 ? '' : 's'}`,
							executionOwner: execution.owner,
							executionId: execution.executionId,
						} : {}),
					},
				});
			} catch (error) {
				reservedSqlElement?.abortReservedToolRun?.(executionId, error);
				for (const element of configuredSqlElements) element?.clearToolExpectedOwner?.();
				postMessageToHost({
					type: 'toolResponse', requestId, result: { success: false },
					error: error instanceof Error ? error.message : String(error),
				});
			} finally {
				for (const element of configuredSqlElements) element?.endToolConfiguration?.(executionId);
				configureLease.settle();
				cancelledKustoToolRequestIds.delete(requestId);
			}
			break;
		}

		case 'toolCancelSqlExecution':
			try {
				const requestId = String(message.requestId || '');
				if (requestId) cancelledKustoToolRequestIds.add(requestId);
				const sqlEl = __kustoGetSqlSectionElement(String(message.sectionId || ''));
				if (typeof sqlEl?.cancelToolRun === 'function') sqlEl.cancelToolRun(String(message.executionId || ''));
			} catch (e) { console.error('[kusto]', e); }
			break;

		case 'toolCancelSqlCopilot':
			try {
				const requestId = String(message.requestId || '');
				const cancellation = sqlCopilotToolCancellationByRequestId.get(requestId);
				if (cancellation) {
					cancellation();
					break;
				}
				const sqlEl = __kustoGetSqlSectionElement(String(message.sectionId || ''));
				if (sqlEl && String(sqlEl.getCopilotOwnerToken?.() || '') === String(message.expectedOwnerToken || '')) {
					sqlEl.copilotWriteQueryCancel?.();
				}
			} catch (e) { console.error('[kusto]', e); }
			break;

		case 'toolGetSqlSchema':
			try {
				const requestId = String(message.requestId || '');
				const sectionId = String(message.sectionId || '');
				const schema = sqlSchemaByBoxId[sectionId];
				const sqlEl = __kustoGetSqlSectionElement(sectionId);
				const owner = {
					connectionId: typeof sqlEl?.getConnectionId === 'function' ? String(sqlEl.getConnectionId() || '') : '',
					database: typeof sqlEl?.getDatabase === 'function' ? String(sqlEl.getDatabase() || '') : '',
					ownerToken: typeof sqlEl?.getCopilotOwnerToken === 'function' ? String(sqlEl.getCopilotOwnerToken() || '') : '',
				};
				if (schema) {
					postMessageToHost({ type: 'toolResponse', requestId, result: { success: true, schema, owner } });
				} else {
					postMessageToHost({ type: 'toolResponse', requestId, result: { success: false, error: 'No schema loaded for this section. Connect to a server and select a database first.', owner } });
				}
			} catch (err: any) {
				postMessageToHost({ type: 'toolResponse', requestId: message.requestId, result: { success: false }, error: err.message || String(err) });
			}
			break;
		
		case 'toolDelegateToKustoWorkbenchCopilot':
			// Delegate through the section's exact Copilot request owner and return
			// only after the request has reached an applied terminal state.
			(async () => {
				let cleanupDelegation: (() => void) | undefined;
				try {
					const requestId = String(message.requestId || '');
					if (requestId && cancelledKustoToolRequestIds.delete(requestId)) {
						postMessageToHost({ type: 'toolResponse', requestId, result: { success: false, error: 'Copilot request was cancelled.' } });
						return;
					}
					const input = message.input || {};
					const question = String(input.question || '').trim();
					const maxResultRows = normalizeAskKustoCopilotMaxResultRows(input.maxResultRows);
					let sectionId = String(input.sectionId || '').trim();
					if (!question) {
						postMessageToHost({
							type: 'toolResponse', requestId,
							result: { success: false, error: 'A non-empty Kusto Copilot question is required.' },
						});
						return;
					}
					
					// If no section specified, use the first query section or create one
					if (!sectionId) {
						const sections = document.querySelectorAll('[data-section-type="query"]');
						if (sections.length > 0) {
							sectionId = sections[0].id;
						}
					}
					let querySection = sectionId ? __kustoGetQuerySectionElement(sectionId) : null;
					if (querySection && (querySection.isCopilotChatRunning?.() === true
						|| querySection.getActiveKustoCopilotRequest?.())) {
						postMessageToHost({
							type: 'toolResponse', requestId,
							result: { success: false, error: 'Kusto Copilot is already running in this section.', sectionId },
						});
						return;
					}
					if (!sectionId) {
						const creation = createSectionWithCapabilities('query');
						if (!creation.ok) {
							postMessageToHost({ type: 'toolResponse', requestId, result: { success: false }, error: creation.error });
							return;
						}
						sectionId = creation.sectionId;
						markSectionAgentTouched(sectionId);
						querySection = __kustoGetQuerySectionElement(sectionId);
					}
					if (input.clusterUrl || input.connectionId || input.database) {
						const applied = applyToolKustoTarget(sectionId, input);
						if (!applied.success) {
							postMessageToHost({ type: 'toolResponse', requestId, result: { success: false, error: applied.error } });
							return;
						}
					}
					
					if (!sectionId) {
						postMessageToHost({ type: 'toolResponse', requestId, result: { success: false, error: 'No query section available' } });
						return;
					}
					// VALIDATE: Check that connection and database are configured on this section
					const currentConnectionId = __kustoGetConnectionId(sectionId) || '';
					const currentDatabase = __kustoGetDatabase(sectionId) || '';
					
					// Get cluster URL for context
					let currentClusterUrl = '';
					try {
						if (currentConnectionId && Array.isArray(connections)) {
							const conn = connections.find((c: any) => c && String(c.id || '') === currentConnectionId);
							currentClusterUrl = conn ? String(conn.clusterUrl || '') : '';
						}
					} catch (e) { console.error('[kusto]', e); }
					
					if (!currentConnectionId) {
						postMessageToHost({ 
							type: 'toolResponse', 
							requestId, 
							result: { 
								success: false, 
								error: 'Query section has no cluster connection configured.',
								sectionId,
								fix: 'Use #configureKustoQuerySection to set up the connection first. Call #listKustoFavorites to find available cluster/database pairs.'
							}
						});
						return;
					}
					
					if (!currentDatabase) {
						postMessageToHost({ 
							type: 'toolResponse', 
							requestId, 
							result: { 
								success: false, 
								error: `Query section is connected to cluster${currentClusterUrl ? ` (${currentClusterUrl})` : ''} but no database is selected.`,
								sectionId,
								clusterUrl: currentClusterUrl || undefined,
								fix: 'Use #configureKustoQuerySection to set the database. You can use #getKustoSchema with the clusterUrl to see available databases.'
							}
						});
						return;
					}
				
					// Agent-generated queries always use the unmodified Run Query mode.
					const beforeSignature = getSectionSerializedSignature(sectionId);
					try {
						setRunMode(sectionId, 'plain');
					} catch (e) { console.error('[kusto]', e); }
					markSectionAgentTouched(sectionId, beforeSignature);
					querySection = __kustoGetQuerySectionElement(sectionId);
					if (!querySection || typeof querySection.submitCopilotChatRequest !== 'function') {
						postMessageToHost({ type: 'toolResponse', requestId, result: { success: false, error: 'Kusto Copilot chat is not available.' } });
						return;
					}
				
				// Set up listeners before the atomic request submission.
				let responded = false;
				let generatedQuery = '';
				let queryGenerated = false;
				let expectedExecutionId = '';
				let executedQuery = '';
				let expectedCopilotRequest: KustoCopilotRequestIdentity | undefined;
				let pendingClarification: KustoCopilotClarifyingQuestionMessage | undefined;
				let pendingQueryTerminal: any = null;
				let boundModelArtifacts: readonly ResultArtifact[] = [];
				let timeoutId: ReturnType<typeof setTimeout> | undefined;
				const modelConsumerIds = new Set<string>([indexedModelConsumerId(requestId, 0)]);
				const cleanup = () => {
					try { window.removeEventListener(ADMITTED_KUSTO_COPILOT_EVENT, resultHandler as EventListener); } catch { /* best effort */ }
					try { window.removeEventListener(APPLIED_KUSTO_COPILOT_DONE_EVENT, doneHandler as EventListener); } catch { /* best effort */ }
					try { window.removeEventListener(ADMITTED_KUSTO_EXECUTION_STARTED_EVENT, startedHandler as EventListener); } catch { /* best effort */ }
					try { window.removeEventListener(ADMITTED_KUSTO_TERMINAL_EVENT, terminalHandler as EventListener); } catch { /* best effort */ }
					try { if (timeoutId !== undefined) clearTimeout(timeoutId); } catch { /* best effort */ }
					try { kustoCopilotToolOwnerByRequestId.delete(requestId); } catch { /* best effort */ }
					try { cancelledKustoToolRequestIds.delete(requestId); } catch { /* best effort */ }
					releaseModelResultConsumers(modelConsumerIds);
				};
				cleanupDelegation = cleanup;

				const startedHandler = (event: Event) => {
					try {
						const msg = (event as CustomEvent).detail;
						if (!msg || !expectedCopilotRequest || msg.producer !== 'copilot'
							|| !hasKustoCopilotRequestIdentity(msg)
							|| !kustoCopilotRequestIdentityEquals(expectedCopilotRequest, msg)) return;
						const started = msg as KustoCopilotRequestIdentity & Record<string, any>;
						expectedExecutionId = String(started.executionId || '');
						executedQuery = typeof started.query === 'string' ? started.query : '';
						if (!executedQuery.trim()) {
							sendModelResultFailure('Query provenance is unavailable for model use.');
							return;
						}
						generatedQuery = executedQuery;
					} catch (error) {
						sendModelResultFailure(error instanceof Error ? error.message : String(error));
					}
				};
				
				const sendModelResultFailure = (error: string) => {
					if (responded) return;
					responded = true;
					cleanup();
					postMessageToHost({
						type: 'toolResponse', requestId,
						result: { success: false, query: generatedQuery || undefined, error },
					});
				};

				// Helper to send a response from the exact bound artifact revision.
				const sendSuccessResponse = () => {
					if (responded) return;
					if (!boundModelArtifacts.length || boundModelArtifacts.some(artifact => (
						getBoundResultArtifact(indexedModelConsumerId(requestId, artifact.resultIndex ?? 0), sectionId)
							?.artifactId !== artifact.artifactId
						|| artifact.producer?.executionId !== expectedExecutionId
						|| artifact.policy?.sendToModel !== true
					))) {
						sendModelResultFailure('Query results are not permitted for model use.');
						return;
					}
					
					// Don't call __kustoCopilotWriteQueryDone here — the regular
					// 'copilotWriteQueryDone' handler already does it.
					
					const resultSets = projectModelResultSets(boundModelArtifacts, maxResultRows);
					const primary = resultSets[0];
					const anyTruncated = resultSets.some(set => set.truncated);
					responded = true;
					cleanup();
					postMessageToHost({ 
						type: 'toolResponse', 
						requestId, 
						result: { 
							success: true,
							query: executedQuery || generatedQuery,
							rowCount: primary.rowCount,
							columns: primary.columns,
							results: primary.results,
							maxResultRows,
							returnedRowCount: primary.returnedRowCount,
							resultSets,
							truncated: anyTruncated
								? `Results truncated to ${maxResultRows} rows${boundModelArtifacts.length > 1 ? ' across all result sets' : ''}`
								: undefined
						}
					});
				};
				
				const resultHandler = (event: Event) => {
					try {
						if (responded) return;
						const clarification = parseKustoCopilotClarifyingQuestionMessage(
							(event as CustomEvent).detail,
						);
						if (!clarification.ok || clarification.value.responseTarget !== 'calling-agent'
							|| !expectedCopilotRequest
							|| !kustoCopilotRequestIdentityEquals(expectedCopilotRequest, clarification.value)) return;
						pendingClarification = clarification.value;
					} catch (err: any) {
						console.error('[Kusto Tools] Error in result handler:', err);
						sendModelResultFailure(err instanceof Error ? err.message : String(err));
					}
				};

				const doneHandler = (event: Event) => {
					try {
						const output = (event as CustomEvent).detail as Record<string, unknown>;
						if (!output || responded || output.type !== 'copilotWriteQueryDone'
							|| !expectedCopilotRequest || !hasKustoCopilotRequestIdentity(output)
							|| !kustoCopilotRequestIdentityEquals(expectedCopilotRequest, output)) return;
						const done = output as KustoCopilotRequestIdentity & {
							type: 'copilotWriteQueryDone'; ok: boolean; message?: string; retired?: boolean;
						};
						if (pendingClarification && done.ok === true && done.retired !== true) {
							const result = createKustoCopilotClarificationRequiredResult(
								pendingClarification.question,
								pendingClarification.boxId,
							);
							if (!result.ok) {
								sendModelResultFailure(result.error);
								return;
							}
							responded = true;
							cleanup();
							postMessageToHost({ type: 'toolResponse', requestId, result: result.value });
							return;
						}
						pendingClarification = undefined;
						queryGenerated = true;
						try {
							const editor = queryEditors && queryEditors[sectionId];
							generatedQuery = executedQuery
								|| (editor && typeof editor.getValue === 'function' ? editor.getValue() : '');
						} catch (e) { console.error('[kusto]', e); }
						if (!done.ok) {
							responded = true;
							cleanup();
							postMessageToHost({
								type: 'toolResponse', requestId,
								result: {
									success: false,
									error: done.message || 'Copilot failed to generate query',
									query: generatedQuery || undefined,
								},
							});
							return;
						}
						if (pendingQueryTerminal?.type === 'queryResult') {
							sendSuccessResponse();
							return;
						}
						if (pendingQueryTerminal?.type === 'modelResultDenied') {
							sendModelResultFailure(pendingQueryTerminal.error);
							return;
						}
						if (pendingQueryTerminal?.type === 'queryError') {
							responded = true;
							cleanup();
							postMessageToHost({
								type: 'toolResponse', requestId,
								result: {
									success: false, query: generatedQuery || undefined,
									error: pendingQueryTerminal.error || 'Query execution failed',
								},
							});
						}
					} catch (err: any) {
						console.error('[Kusto Tools] Error in done handler:', err);
						sendModelResultFailure(err instanceof Error ? err.message : String(err));
					}
				};

				const terminalHandler = (event: Event) => {
					try {
						const msg = (event as CustomEvent).detail;
						if (!msg || responded || !expectedCopilotRequest || msg.producer !== 'copilot'
							|| !hasKustoCopilotRequestIdentity(msg)
							|| !kustoCopilotRequestIdentityEquals(expectedCopilotRequest, msg)) return;
						const terminal = msg as KustoCopilotRequestIdentity & Record<string, any>;
						if (!expectedExecutionId || String(terminal.executionId || '') !== expectedExecutionId) return;
						if (terminal.type === 'queryResult') {
							const artifacts = bindModelResultArtifacts(
								requestId, sectionId, expectedExecutionId, terminal.result, modelConsumerIds,
							);
							if (!artifacts?.length) {
								const denied = { type: 'modelResultDenied', error: 'Query results are not permitted for model use.' };
								if (queryGenerated) sendModelResultFailure(denied.error);
								else pendingQueryTerminal = denied;
								return;
							}
							boundModelArtifacts = artifacts;
							if (queryGenerated) sendSuccessResponse();
							else pendingQueryTerminal = terminal;
							return;
						}
						if (terminal.type === 'queryError') {
							if (!queryGenerated) {
								pendingQueryTerminal = terminal;
								return;
							}
							responded = true;
							cleanup();
							postMessageToHost({
								type: 'toolResponse', requestId,
								result: {
									success: false, query: generatedQuery || undefined,
									error: terminal.error || 'Query execution failed',
								},
							});
							return;
						}
						if (terminal.type === 'queryCancelled') {
							sendModelResultFailure('Query execution was cancelled.');
						}
					} catch (error) {
						sendModelResultFailure(error instanceof Error ? error.message : String(error));
					}
				};
				
				window.addEventListener(ADMITTED_KUSTO_COPILOT_EVENT, resultHandler as EventListener);
				window.addEventListener(APPLIED_KUSTO_COPILOT_DONE_EVENT, doneHandler as EventListener);
				window.addEventListener(ADMITTED_KUSTO_EXECUTION_STARTED_EVENT, startedHandler as EventListener);
				window.addEventListener(ADMITTED_KUSTO_TERMINAL_EVENT, terminalHandler as EventListener);
				
				// Timeout after 3 minutes
				timeoutId = setTimeout(() => {
					if (!responded) {
						responded = true;
						cleanup();
						
						// Clear the Copilot chat "thinking..." state on timeout
						// (unlike cancel/error, no regular handler will clear this)
						try {
							const kwEl = __kustoGetQuerySectionElement(sectionId);
							if (kwEl && typeof kwEl.copilotWriteQueryDone === 'function') {
								kwEl.copilotWriteQueryDone(false, 'Request timed out');
							}
						} catch (e) { console.error('[kusto]', e); }
						
						postMessageToHost({ 
							type: 'toolResponse', 
							requestId, 
							result: { 
								success: false,
								timedOut: true,
								query: generatedQuery || undefined,
								error: 'Request timed out after 3 minutes'
							}
						});
					}
				}, 180000);
				
				const submittedOwner = querySection.submitCopilotChatRequest(question, true);
				if (!hasKustoCopilotRequestIdentity(submittedOwner)) {
					cleanup();
					postMessageToHost({
						type: 'toolResponse', requestId,
						result: { success: false, error: 'Kusto Copilot request did not start. The section may already be busy.' },
					});
				} else {
					expectedCopilotRequest = submittedOwner;
					kustoCopilotToolOwnerByRequestId.set(requestId, submittedOwner);
					if (cancelledKustoToolRequestIds.delete(requestId)) {
						querySection.cancelKustoCopilotRequest?.(submittedOwner);
					}
				}
				
				} catch (err: any) {
					try { cleanupDelegation?.(); } catch { /* best effort */ }
					console.error('[Kusto Tools] Error delegating to Copilot:', err);
					postMessageToHost({ type: 'toolResponse', requestId: message.requestId, result: { success: false, error: err.message || String(err) } });
				}
			})();
			break;
		
		case 'toolDelegateToSqlCopilot':
			// Delegate a question to the SQL Copilot Chat — simplified version of the Kusto handler.
			(async () => {
				try {
					const requestId = String(message.requestId || '');
					const input = message.input || {};
					const question = String(input.question || '');
					const expectedOwnerToken = String(input.expectedOwnerToken || '');
					const expectedConnectionId = String(input.expectedConnectionId || '');
					const expectedDatabase = String(input.expectedDatabase || '');
					let sectionId = String(input.sectionId || '');
					
					// If no section specified, use the first SQL section
					if (!sectionId) {
						const sections = document.querySelectorAll('[data-section-type="sql"]');
						if (sections.length > 0) {
							sectionId = sections[0].id;
						} else {
							// Try to find any SQL section via the sqlBoxes array
							if (typeof sqlBoxes !== 'undefined' && sqlBoxes.length > 0) {
								sectionId = sqlBoxes[0];
							}
						}
					}
					
					if (!sectionId) {
						postMessageToHost({ type: 'toolResponse', requestId, result: { success: false, error: 'No SQL section available. Add a SQL section first.' } });
						return;
					}
					
					const sqlEl = __kustoGetSqlSectionElement(sectionId);
					if (!sqlEl) {
						postMessageToHost({ type: 'toolResponse', requestId, result: { success: false, error: `SQL section "${sectionId}" not found.` } });
						return;
					}
					const capturedOwner = {
						connectionId: expectedConnectionId,
						database: expectedDatabase,
						ownerToken: expectedOwnerToken,
					};
					const ownerIsCurrent = () => !!expectedOwnerToken
						&& String(sqlEl.getCopilotOwnerToken?.() || '') === expectedOwnerToken
						&& String(sqlEl.getConnectionId?.() || '') === expectedConnectionId
						&& String(sqlEl.getDatabase?.() || '') === expectedDatabase;
					const postOwnedFailure = (error: string, extra: Record<string, unknown> = {}) => postMessageToHost({
						type: 'toolResponse', requestId,
						result: { success: false, error, owner: capturedOwner, ...extra },
					});
					if (!ownerIsCurrent()) {
						postOwnedFailure('SQL Copilot owner changed before dispatch.');
						return;
					}
					let responded = false;
					let resultHandler: ((event: any) => void) | undefined;
					let timeoutId: ReturnType<typeof setTimeout> | undefined;
					const cleanupDelegation = () => {
						if (resultHandler) window.removeEventListener('message', resultHandler);
						if (timeoutId) clearTimeout(timeoutId);
						if (sqlCopilotToolCancellationByRequestId.get(requestId) === cancelDelegation) {
							sqlCopilotToolCancellationByRequestId.delete(requestId);
						}
					};
					const cancelDelegation = () => {
						if (responded) return;
						responded = true;
						cleanupDelegation();
						if (ownerIsCurrent()) sqlEl.copilotWriteQueryCancel?.();
					};
					sqlCopilotToolCancellationByRequestId.set(requestId, cancelDelegation);
					
					// Ensure copilot chat is visible
					if (typeof sqlEl.setCopilotChatVisible === 'function') {
						sqlEl.setCopilotChatVisible(true);
					}

					// Force 'Run Query' mode (plain) — agent-generated queries must not
					// have TOP 100 limits silently appended.
					const beforeSignature = getSectionSerializedSignature(sectionId);
					try { setRunMode(sectionId, 'plain'); } catch (e) { console.error('[kusto]', e); }
					markSectionAgentTouched(sectionId, beforeSignature);

					await new Promise((r: any) => setTimeout(r, 150));
					if (responded) return;
					if (!ownerIsCurrent()) {
						cleanupDelegation();
						postOwnedFailure('SQL Copilot owner changed before dispatch.');
						return;
					}
					
					// Find the chat element
					const chatEl = typeof sqlEl.getCopilotChatEl === 'function' ? sqlEl.getCopilotChatEl() : null;
					if (!chatEl || typeof chatEl.setInputText !== 'function') {
						cleanupDelegation();
						postMessageToHost({ type: 'toolResponse', requestId, result: { success: false, error: 'SQL Copilot chat not available. Is Copilot enabled?' } });
						return;
					}
					
					if (!ownerIsCurrent()) {
						cleanupDelegation();
						postOwnedFailure('SQL Copilot owner changed before dispatch.');
						return;
					}
					chatEl.setInputText(question);
					
					// Listen for results
					let generatedQuery = '';
					
					resultHandler = (event: any) => {
						try {
							const msg = event && event.data;
							if (!msg || responded) return;
							if (msg.type === 'copilotWriteQueryDone' && msg.boxId === sectionId
								&& String(msg.ownerToken || '') === expectedOwnerToken
								&& String(sqlEl.getCopilotOwnerToken?.() || '') === expectedOwnerToken) {
								responded = true;
								cleanupDelegation();
								try {
									if (typeof sqlEl.getCopilotEditorValue === 'function') {
										generatedQuery = sqlEl.getCopilotEditorValue() || '';
									}
								} catch (e) { console.error('[kusto]', e); }
								postMessageToHost({
									type: 'toolResponse', requestId,
									result: {
										success: !!msg.ok,
										answer: msg.ok ? 'Query generated successfully.' : (msg.message || 'Failed'),
										query: generatedQuery || undefined,
										error: msg.ok ? undefined : (msg.message || 'Failed'),
										owner: {
											connectionId: typeof sqlEl.getConnectionId === 'function' ? String(sqlEl.getConnectionId() || '') : '',
											database: typeof sqlEl.getDatabase === 'function' ? String(sqlEl.getDatabase() || '') : '',
											ownerToken: typeof sqlEl.getCopilotOwnerToken === 'function' ? String(sqlEl.getCopilotOwnerToken() || '') : '',
										},
									}
								});
							}
						} catch (err: any) { console.error('[kusto]', err); }
					};
					
					window.addEventListener('message', resultHandler);
					timeoutId = setTimeout(() => {
						if (!responded) {
							cancelDelegation();
							postOwnedFailure('Request timed out after 3 minutes', { timedOut: true });
						}
					}, 180000);
					
					// Send the message
					const sendBtn = chatEl.shadowRoot?.querySelector('.send-btn') as HTMLElement | null;
					if (!ownerIsCurrent()) {
						cleanupDelegation();
						postOwnedFailure('SQL Copilot owner changed before dispatch.');
					} else if (sendBtn) sendBtn.click();
					else {
						cleanupDelegation();
						postOwnedFailure('Could not find send button');
					}
				} catch (err: any) {
					console.error('[kusto]', err);
					postMessageToHost({ type: 'toolResponse', requestId: message.requestId, result: { success: false, error: err.message || String(err) } });
				}
			})();
			break;
		
		case 'changedSections':
			// Update per-section unsaved-change indicators.
			// Message shape: ChangedSectionsMessage { type, changes: SectionChangeInfo[] }
			try {
				const changes: Array<{ id: string; status: 'modified' | 'new'; contentChanged: boolean; settingsChanged: boolean }> = Array.isArray(message.changes) ? message.changes : [];
				const changedById = new Map<string, 'modified' | 'new'>();
				for (const c of changes) {
					if (c && typeof c.id === 'string' && c.id) {
						changedById.set(c.id, c.status === 'new' ? 'new' : 'modified');
					}
				}
				// Update all section elements in the DOM.
				const container = document.getElementById('queries-container');
				if (container) {
					for (const child of Array.from(container.children)) {
						const id = child.id || '';
						if (!id) continue;
						const el = child as any;
						const shell = el.shadowRoot?.querySelector('kw-section-shell');
						const status = changedById.get(id) || '';
						if (!status) {
							clearSectionAgentTouched(id, shell);
						}
						if (shell) {
							shell.hasChanges = status;
							shell.showDiffBtn = status === 'modified';
							if (status) {
								reconcileSectionAgentTouched(id, status, shell);
							}
						}
						// Mirror attribute on the section host for :host() glow styles.
						if (status) {
							el.setAttribute('has-changes', status);
							el.removeAttribute('title');
						} else {
							el.removeAttribute('has-changes');
							el.removeAttribute('title');
						}
					}
				}
			} catch (e) { console.error('[kusto]', e); }
			break;

		case 'shareContentReady':
			// Write rich HTML + plain text to the clipboard for Teams / rich-text paste.
			try {
				const { html, text } = message;
				if (navigator.clipboard && typeof navigator.clipboard.write === 'function') {
					const htmlBlob = new Blob([html], { type: 'text/html' });
					const textBlob = new Blob([text], { type: 'text/plain' });
					navigator.clipboard.write([
						new ClipboardItem({ 'text/html': htmlBlob, 'text/plain': textBlob })
					]).catch(() => {
						// Fallback to plain text if HTML clipboard write fails.
						try { navigator.clipboard.writeText(text); } catch (e) { console.error('[kusto]', e); }
					});
				} else if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
					navigator.clipboard.writeText(text);
				}
			} catch (e) { console.error('[kusto]', e); }
			break;

		case 'resetCopilotModelSelection':
			// Clear the cached model selection from webview state and localStorage
			try {
				// Clear from vscode state
				const state = (typeof _win.vscode !== 'undefined' && _win.vscode && _win.vscode.getState) ? (_win.vscode.getState() || {}) : {};
				delete state.lastOptimizeModelId;
				if (typeof _win.vscode !== 'undefined' && _win.vscode && _win.vscode.setState) {
					_win.vscode.setState(state);
				}
			} catch (e) { console.error('[kusto]', e); }
			try {
				// Clear from localStorage
				localStorage.removeItem('kusto.optimize.lastModelId');
			} catch (e) { console.error('[kusto]', e); }
			break;
	}
};

function getCompatibilityProjectionFingerprint(message: Record<string, unknown>): string {
	const {
		protocolVersion: _protocolVersion,
		channel: _channel,
		viewSessionId: _viewSessionId,
		requestId: _requestId,
		requestSource: _requestSource,
		reloadRequestId: _reloadRequestId,
		sourceGeneration: _sourceGeneration,
		...projection
	} = message;
	try {
		return JSON.stringify(projection);
	} catch {
		return '';
	}
}

export async function drainBufferedHostMessages(): Promise<void> {
	const buffered = Array.isArray((window as any).__kustoBufferedHostMessages)
		? (window as any).__kustoBufferedHostMessages.splice(0)
		: [];
	for (const message of buffered) {
		try {
			await __kustoDispatchHostMessage(message);
		} catch (e) { console.error('[kusto]', e); }
	}
}

let mainWebviewMessageDispatcherStarted = false;

export async function startMainWebviewMessageDispatcher(): Promise<void> {
	if (mainWebviewMessageDispatcherStarted) return;
	mainWebviewMessageDispatcherStarted = true;
	window.addEventListener('message', async (event: any) => {
		const message = (event && event.data && typeof event.data === 'object') ? event.data : {};
		await __kustoDispatchHostMessage(message);
	});
	(window as any).__kustoHostMessageDispatcherReady = true;
	await drainBufferedHostMessages();
	postMessageToHost({ type: 'mainWebviewDispatcherReady' });
}
