// Persistence module — converted from legacy/persistence.js
// Window bridge exports at bottom for remaining legacy callers.
export {};

import { normalizeClusterUrl, isLeaveNoTraceCluster, normalizePersistedResultJson, trySerializeQueryResult } from '../shared/persistence-utils';
import { kustoClusterKey } from '../../shared/kustoClusterUrls.js';
import { resolveKustoConnection } from '../../shared/kustoAuth.js';
import { postMessageToHost } from '../shared/webview-messages';
import { pState } from '../shared/persistence-state';
import { clearResultsState, displayResultForBox, getCurrentResultArtifact, getResultsState, getResultsStateRevision } from './results-state';
import {
	createDerivedResultArtifactPublication,
	projectRowsToDeclaredColumns,
	publicationFromPersistedResultArtifact,
	RESULT_ARTIFACT_CSV_RESET_EVENT,
	toPersistedResultArtifact,
	type PersistedResultArtifactV1,
	type ResultArtifactPublication,
} from '../../shared/resultArtifact.js';
import {
	addQueryBox, removeQueryBox, updateConnectionSelects, toggleCacheControls,
	__kustoGetQuerySectionElement, __kustoSetSectionName, __kustoGetConnectionId, __kustoGetDatabase,
	__kustoSetAutoEnterFavoritesForBox, __kustoTryAutoEnterFavoritesModeForAllBoxes,
	__kustoClampResultsWrapperHeight,
	addPythonBox, addUrlBox, removePythonBox, removeUrlBox, pythonBoxes, urlBoxes,
	addHtmlBox, removeHtmlBox, htmlBoxes,
	addSqlBox, removeSqlBox, sqlBoxes,
	__kustoGetSqlSectionElement,
} from './section-factory';
import { schemaRequestTokenByBoxId } from './kusto-schema-request-state';
import {
	connections, queryBoxes, queryEditors, favoritesModeByBoxId, leaveNoTraceClusters,
	activeQueryEditorBoxId,
	setCaretDocsEnabled, setAutoTriggerAutocompleteEnabled,
	beginKustoPreparation,
	getKustoPreparationState,
	schemaDiagnosticsTrustedByBoxId,
	schemaFetchInFlightByBoxId,
	sqlFavoritesModeByBoxId,
	queryExecutionTimers,
	sqlLeaveNoTraceConnectionIds,
	sqlConnections,
	optimizationMetadataByBoxId,
} from './state';
import { sqlConnectionTargetSignatureMatches } from '../../shared/sqlConnectionIdentity.js';
import { addChartBox, removeChartBox, chartBoxes } from '../sections/kw-chart-section';
import { addTransformationBox, removeTransformationBox, transformationBoxes } from '../sections/kw-transformation-section';
import { addMarkdownBox, removeMarkdownBox, markdownBoxes, markdownEditors } from '../sections/kw-markdown-section';
import { __kustoCloseShareModal, setRunMode, updateCaretDocsToggleButtons, updateAutoTriggerAutocompleteToggleButtons } from '../sections/kw-query-toolbar';
import { __kustoUpdateQueryResultsToggleButton, __kustoApplyResultsVisibility } from '../sections/query-execution.controller';
import { perfMark } from './perf.js';
import { traceFileOpen } from './file-open-trace.js';
import { shouldStartKustoSchemaPrewarm } from '../shared/schema-utils.js';
import { kustoEditorSchemaCoordinator } from './kusto-editor-schema-runtime.js';


const _win = window;
// Persistence + .kqlx document round-tripping.
//
// The extension host stores the state as JSON in a .kqlx file.
// This file provides:
// - export: collect the current UI state
// - restore: rebuild the UI from a state object
// - debounced write-through: postMessage({type:'persistDocument'})

let __kustoPersistenceEnabled = false;
let __kustoPersistenceSuppressedForTest = false;
let __kustoPersistTimer: any = null;
let __kustoDocumentDataApplyCount = 0;
let __kustoHasAppliedDocument = false;
let __kustoLastAppliedDocumentUri = '';
let __kustoSchemaPrewarmTimer: any = null;
const __kustoSchemaPrewarmSentKeys = new Set<string>();
let __kustoHtmlPowerBiCompatibilityTimer: any = null;
let __kustoHtmlPowerBiCompatibilityRunToken = 0;
let __kustoRestoreResultGeneration = 0;
let __kustoDeferredRestoredResultScheduled = false;
let __kustoKustoPolicyReady = false;
let __kustoKustoPolicyGloballyBlocked = false;
let __kustoKustoPolicyClusterKeys = new Set<string>();
let __kustoKustoPolicyRevocationGenerations: Record<string, number> = {};
let __kustoRequiredPolicyRequestId = '';
let __kustoPersistenceEpoch = 0;
let __kustoPendingProtectedResultPurge = false;

function __kustoIsReadOnlyBrowserViewer(): boolean {
	return (_win as any).__kustoReadOnlyMode === true;
}

type DeferredRestoredResultJob = {
	generation: number;
	documentUri: string;
	boxId: string;
	resultJson: string;
	resultArtifact?: unknown;
	kind: 'query' | 'sql';
	resultsHeightPx?: number;
	initialResultsRevision: number;
	persistenceEpoch: number;
	sqlOwnerConnectionId?: string;
	kustoClusterUrl?: string;
	kustoAuthorityId?: string;
	kustoConnectionIdHint?: string;
	kustoDatabase?: string;
	expectedQueryText?: string;
	expectedResultDatabase?: string;
	sqlOwnerSourceBoxId?: string;
	kustoAccountPartition?: string;
	kustoLeaveNoTraceRevision?: number;
	derivedSourceBoxId?: string;
};
type DeferredRestoredResultState = 'ready' | 'pending' | 'invalid';

let __kustoDeferredRestoredResultJobs: DeferredRestoredResultJob[] = [];
type PendingSqlOwnedRestore = {
	generation: number;
	documentUri: string;
	boxId: string;
	resultJson: string;
	resultArtifact?: unknown;
	kind: 'query' | 'sql';
	resultsHeightPx?: number;
	expectedQueryText?: string;
	expectedResultDatabase?: string;
	sqlOwnerSourceBoxId?: string;
	derivedSourceBoxId?: string;
	persistedOwner: { connectionIdHint?: unknown; targetSignature?: unknown; principalFingerprint?: unknown; revocationGeneration?: unknown; sourceBoxId?: unknown };
};
let __kustoPendingSqlOwnedRestores: PendingSqlOwnedRestore[] = [];
let __kustoLegacyDocumentPreferences: {
	caretDocsEnabled?: boolean;
	autoTriggerAutocompleteEnabled?: boolean;
} = {};

function legacyDocumentPreferencesForPersistence() {
	return { ...__kustoLegacyDocumentPreferences };
}

// Thin wrapper kept for the window bridge export.
function __kustoNormalizeClusterUrl(clusterUrl: any) {
	return normalizeClusterUrl(clusterUrl);
}

/**
 * Check if a cluster URL is marked as "Leave no trace".
 * Delegates to the pure shared function, providing the window global.
 */
function __kustoIsLeaveNoTraceCluster(clusterUrl: any) {
	try {
		const list = leaveNoTraceClusters;
		return isLeaveNoTraceCluster(clusterUrl, Array.isArray(list) ? list : []);
	} catch {
		return false;
	}
}

function __kustoIsVisibleExpandedQuerySection(boxId: string): boolean {
	try {
		const el = __kustoGetQuerySectionElement(boxId) as any;
		if (!el) return false;
		if (typeof el.isExpanded === 'function' && !el.isExpanded()) return false;
		if (el.classList && el.classList.contains('is-collapsed')) return false;
		const style = typeof getComputedStyle === 'function' ? getComputedStyle(el) : null;
		if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
		if (typeof el.getClientRects === 'function' && el.getClientRects().length === 0) return false;
		return true;
	} catch {
		return false;
	}
}

function __kustoPickSchemaPrewarmBoxId(): string {
	try {
		const active = String(activeQueryEditorBoxId || '');
		if (active && __kustoIsVisibleExpandedQuerySection(active)) {
			return active;
		}
	} catch (e) { console.error('[kusto]', e); }
	try {
		for (const boxId of queryBoxes || []) {
			const id = String(boxId || '');
			if (id && __kustoIsVisibleExpandedQuerySection(id)) {
				return id;
			}
		}
	} catch (e) { console.error('[kusto]', e); }
	return '';
}

export function __kustoScheduleLocalSchemaPrewarm(reason: string = 'file-open'): void {
	try {
		if (__kustoSchemaPrewarmTimer) {
			clearTimeout(__kustoSchemaPrewarmTimer);
		}
		__kustoSchemaPrewarmTimer = setTimeout(() => {
			__kustoSchemaPrewarmTimer = null;
			try {
				if (!window.vscode) return;
				const boxId = __kustoPickSchemaPrewarmBoxId();
				if (!boxId) return;
				let ownerId = boxId;
				try {
					if (typeof (window as any).__kustoGetSelectionOwnerBoxId === 'function') {
						ownerId = (window as any).__kustoGetSelectionOwnerBoxId(boxId) || boxId;
					}
				} catch (e) { console.error('[kusto]', e); }
				const connectionId = __kustoGetConnectionId(ownerId);
				const database = __kustoGetDatabase(ownerId);
				if (!connectionId || !database) return;
				const authoritativeToken = String(schemaRequestTokenByBoxId[boxId] || '');
				const preparation = getKustoPreparationState(boxId);
				if (!shouldStartKustoSchemaPrewarm({
					schemaFetchInFlight: !!schemaFetchInFlightByBoxId[boxId],
					authoritativeRequestToken: authoritativeToken,
					preparationStatus: preparation.status,
					diagnosticsTrusted: schemaDiagnosticsTrustedByBoxId[boxId] !== false,
				})) {
					return;
				}
				const requestToken = 'schema_prewarm_' + Date.now() + '_' + Math.random().toString(16).slice(2);
				const section = __kustoGetQuerySectionElement(boxId) as any;
				const lifecycleTarget = section?.setSchemaLifecycleTarget?.(connectionId, database);
				if (!lifecycleTarget) return;
				const key = connectionId + '|' + database + '|' + lifecycleTarget.targetGeneration;
				if (__kustoSchemaPrewarmSentKeys.has(key)) return;
				const lifecycle = section.beginSchemaLifecycleRequest?.(requestToken);
				if (!lifecycle) return;
				try { schemaRequestTokenByBoxId[boxId] = requestToken; } catch (e) { console.error('[kusto]', e); }
				__kustoSchemaPrewarmSentKeys.add(key);
				beginKustoPreparation(boxId, {
					stage: 'schema',
					blockers: ['schema', 'worker'],
					target: { connectionId, database, requestToken },
				});
				postMessageToHost({
					type: 'prefetchSchema',
					connectionId,
					database,
					boxId,
					forceRefresh: false,
					requestToken,
					cacheOnly: true,
					silent: true,
					reason,
					sectionInstanceId: lifecycle.sectionInstanceId,
					targetGeneration: lifecycle.targetGeneration,
				});
			} catch (e) { console.error('[kusto]', e); }
		}, 80);
	} catch (e) { console.error('[kusto]', e); }
}

function __kustoCancelHtmlPowerBiCompatibilityCheck(): void {
	try {
		__kustoHtmlPowerBiCompatibilityRunToken++;
		if (__kustoHtmlPowerBiCompatibilityTimer) {
			clearTimeout(__kustoHtmlPowerBiCompatibilityTimer);
			__kustoHtmlPowerBiCompatibilityTimer = null;
		}
	} catch (e) { console.error('[kusto]', e); }
}

function __kustoClearHtmlPowerBiCompatibilityNotices(): void {
	try {
		const ids = Array.isArray(htmlBoxes) ? htmlBoxes.slice().map((id: any) => String(id || '')).filter(Boolean) : [];
		for (const id of ids) {
			const el = document.getElementById(id) as any;
			if (el && typeof el.clearPowerBiCompatibilityNotice === 'function') {
				el.clearPowerBiCompatibilityNotice();
			}
		}
	} catch (e) { console.error('[kusto]', e); }
}

export function __kustoSetHtmlPowerBiCompatibilityCheckEnabled(enabled: boolean): void {
	try {
		const next = enabled !== false;
		const previous = pState.htmlPowerBiCompatibilityCheckEnabled !== false;
		pState.htmlPowerBiCompatibilityCheckEnabled = next;
		if (!next) {
			__kustoCancelHtmlPowerBiCompatibilityCheck();
			__kustoClearHtmlPowerBiCompatibilityNotices();
			return;
		}
		if (!previous && next) {
			__kustoScheduleHtmlPowerBiCompatibilityCheck('settings-enabled');
		}
	} catch (e) { console.error('[kusto]', e); }
}

function __kustoQueueIdle(callback: () => void): void {
	try {
		const requestIdle = (window as any).requestIdleCallback;
		if (typeof requestIdle === 'function') {
			requestIdle(() => callback(), { timeout: 500 });
			return;
		}
	} catch (e) { console.error('[kusto]', e); }
	try { setTimeout(callback, 25); } catch (e) { console.error('[kusto]', e); }
}

function __kustoSetDocumentLoading(loading: boolean, text?: string): void {
	try {
		const body = document.body as HTMLElement | null;
		if (body && body.dataset) {
			if (loading) {
				body.dataset.kustoDocumentLoading = 'true';
			} else {
				delete body.dataset.kustoDocumentLoading;
			}
		}
		const loader = document.getElementById('documentLoading') as HTMLElement | null;
		if (loader) {
			loader.style.display = '';
			loader.setAttribute('aria-hidden', loading ? 'false' : 'true');
			if (text) {
				const label = loader.querySelector('.document-loading-text');
				if (label) label.textContent = text;
			}
		}
		const container = document.getElementById('queries-container') as HTMLElement | null;
		if (container) {
			if (loading) {
				container.setAttribute('aria-busy', 'true');
			} else {
				container.removeAttribute('aria-busy');
			}
		}
	} catch (e) { console.error('[kusto]', e); }
}

function __kustoStartRestoreResultBatch(): number {
	__kustoRestoreResultGeneration++;
	__kustoDeferredRestoredResultJobs = [];
	__kustoPendingSqlOwnedRestores = [];
	__kustoDeferredRestoredResultScheduled = false;
	__kustoPendingProtectedResultPurge = false;
	return __kustoRestoreResultGeneration;
}

function __kustoSqlOwnerMatchesPersisted(element: any, persistedSection: any): boolean {
	const expectedConnectionId = String(persistedSection?.connectionIdHint || '').trim();
	const expectedTargetSignature = String(persistedSection?.targetSignature || '');
	if (!expectedConnectionId || !expectedTargetSignature) return false;
	const currentConnectionId = String(element?.getConnectionId?.() || element?.getSqlConnectionId?.() || '').trim();
	if (!currentConnectionId || currentConnectionId !== expectedConnectionId) return false;
	const currentConnection = sqlConnections.find(connection => String(connection?.id || '') === currentConnectionId);
	if (!currentConnection || !sqlConnectionTargetSignatureMatches(currentConnection, expectedTargetSignature)) return false;
	const expectedPrincipalFingerprint = String(persistedSection?.principalFingerprint || '').trim();
	const currentPrincipalFingerprint = String(currentConnection.principalFingerprint || '').trim();
	const expectedRevocationGeneration = Number(persistedSection?.revocationGeneration ?? 0);
	const currentRevocationGeneration = Number(currentConnection.revocationGeneration ?? 0);
	if (!Number.isSafeInteger(expectedRevocationGeneration)
		|| expectedRevocationGeneration < 0
		|| expectedRevocationGeneration !== currentRevocationGeneration) return false;
	const authType = String(currentConnection.authType || '').trim().toLowerCase();
	if (authType === 'aad') return !!expectedPrincipalFingerprint && expectedPrincipalFingerprint === currentPrincipalFingerprint;
	return !expectedPrincipalFingerprint || expectedPrincipalFingerprint === currentPrincipalFingerprint;
}

function __kustoQueuePendingSqlOwnedRestore(job: Omit<PendingSqlOwnedRestore, 'generation' | 'documentUri'>): void {
	const connectionIdHint = String(job.persistedOwner?.connectionIdHint || '').trim();
	const targetSignature = String(job.persistedOwner?.targetSignature || '');
	if (!job.boxId || !job.resultJson || !connectionIdHint || !targetSignature) return;
	__kustoPendingSqlOwnedRestores.push({
		...job,
		generation: __kustoRestoreResultGeneration,
		documentUri: String(pState.documentUri || ''),
	});
}

export function resolvePendingSqlResultRestores(): void {
	const pending = __kustoPendingSqlOwnedRestores;
	__kustoPendingSqlOwnedRestores = [];
	for (const job of pending) {
		if (job.generation !== __kustoRestoreResultGeneration || job.documentUri !== String(pState.documentUri || '')) continue;
		const ownerElement = job.kind === 'sql'
			? __kustoGetSqlSectionElement(job.boxId)
			: __kustoGetSqlSectionElement(String((job.persistedOwner as any).sourceBoxId || ''));
		if (!__kustoSqlOwnerMatchesPersisted(ownerElement, job.persistedOwner)) continue;
		if (typeof ownerElement?.canPersistResults === 'function' && !ownerElement.canPersistResults()) continue;
		__kustoSetStoredQueryResultJson(job.boxId, job.resultJson);
		__kustoQueueRestoredResult({
			kind: job.kind,
			boxId: job.boxId,
			resultJson: job.resultJson,
			resultArtifact: job.resultArtifact,
			resultsHeightPx: job.resultsHeightPx,
			expectedQueryText: job.expectedQueryText,
			expectedResultDatabase: job.expectedResultDatabase,
			sqlOwnerSourceBoxId: String((job.persistedOwner as any).sourceBoxId || job.sqlOwnerSourceBoxId || job.boxId).trim(),
			sqlOwnerConnectionId: String(job.persistedOwner.connectionIdHint || '').trim(),
			derivedSourceBoxId: job.derivedSourceBoxId,
		});
	}
	__kustoScheduleDeferredRestoredResults();
}

export function discardPendingSqlResultRestores(protectedConnectionIds: readonly string[]): void {
	const protectedIds = new Set(protectedConnectionIds.map(id => String(id || '').trim()).filter(Boolean));
	__kustoPendingSqlOwnedRestores = __kustoPendingSqlOwnedRestores.filter(job => {
		const connectionId = String(job.persistedOwner.connectionIdHint || '').trim();
		return !!connectionId && !protectedIds.has(connectionId);
	});
	__kustoDeferredRestoredResultJobs = __kustoDeferredRestoredResultJobs.filter(job => {
		if (!job.sqlOwnerConnectionId) return job.kind === 'query';
		return !protectedIds.has(job.sqlOwnerConnectionId);
	});
}

function __kustoIsKustoOwnedRestore(job: DeferredRestoredResultJob): boolean {
	return job.kind === 'query' && !job.sqlOwnerConnectionId;
}

function __kustoHasDeferredResultDependencyCycle(job: DeferredRestoredResultJob): boolean {
	const jobsByBoxId = new Map(__kustoDeferredRestoredResultJobs
		.filter(candidate => __kustoIsDeferredResultJobDocumentCurrent(candidate))
		.map(candidate => [candidate.boxId, candidate]));
	const visited = new Set<string>();
	let current: DeferredRestoredResultJob | undefined = job;
	while (current?.derivedSourceBoxId) {
		if (visited.has(current.boxId)) return true;
		visited.add(current.boxId);
		current = jobsByBoxId.get(current.derivedSourceBoxId);
	}
	return false;
}

function __kustoResolveKustoResultCluster(boxId: string, clusterUrl?: string, connectionIdHint?: string): string {
	const directCluster = String(clusterUrl || '').trim();
	if (directCluster) return directCluster;
	const section = document.getElementById(boxId) as any;
	const sectionCluster = String(section?.getClusterUrl?.() || '').trim();
	if (sectionCluster) return sectionCluster;
	const connectionId = String(connectionIdHint || section?.getConnectionId?.() || '').trim();
	return String(connections.find(connection => String(connection?.id || '') === connectionId)?.clusterUrl || '').trim();
}

function __kustoIsProtectedKustoResult(boxId: string, clusterUrl?: string, connectionIdHint?: string): boolean {
	if (__kustoKustoPolicyGloballyBlocked) return true;
	const key = kustoClusterKey(__kustoResolveKustoResultCluster(boxId, clusterUrl, connectionIdHint));
	return !!key && __kustoKustoPolicyClusterKeys.has(key);
}

function __kustoIsSqlOwnedQueryBox(boxId: string): boolean {
	const sourceBoxId = String((optimizationMetadataByBoxId[boxId] as any)?.sourceBoxId || '').trim();
	if (sourceBoxId) {
		const source = document.getElementById(sourceBoxId);
		return String(source?.tagName || '').toLowerCase() === 'kw-sql-section';
	}
	return false;
}

export function markKustoLeaveNoTracePolicyPending(): void {
	__kustoKustoPolicyReady = false;
}

function __kustoRequestFreshLeaveNoTracePolicy(): string {
	const requestId = `kusto-policy-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
	__kustoRequiredPolicyRequestId = requestId;
	__kustoKustoPolicyReady = false;
	postMessageToHost({ type: 'getConnections', policyRequestId: requestId });
	return requestId;
}

export function getPendingKustoLeaveNoTracePolicyRequestIdForTest(): string {
	return __kustoRequiredPolicyRequestId;
}

export function canPersistKustoResult(clusterUrl: unknown): boolean {
	if (!__kustoKustoPolicyReady || __kustoKustoPolicyGloballyBlocked) return false;
	const key = kustoClusterKey(String(clusterUrl || ''));
	return !!key && !__kustoKustoPolicyClusterKeys.has(key);
}

function __kustoRequestProtectedResultPurge(): void {
	__kustoPendingProtectedResultPurge = true;
	if (!__kustoPersistenceEnabled || pState.restoreInProgress) return;
	__kustoPendingProtectedResultPurge = false;
	__kustoLastPersistSignature = '';
	schedulePersist('kusto-leave-no-trace-policy', true);
}

export function applyKustoLeaveNoTracePolicy(
	clusterUrls: readonly unknown[],
	globallyBlocked = false,
	policyRequestId?: unknown,
	revocationGenerations: Record<string, number> = {},
): void {
	const responseRequestId = String(policyRequestId || '').trim();
	if (__kustoRequiredPolicyRequestId && responseRequestId !== __kustoRequiredPolicyRequestId) return;
	__kustoKustoPolicyClusterKeys = new Set(clusterUrls.map(value => kustoClusterKey(String(value || ''))).filter(Boolean));
	__kustoKustoPolicyGloballyBlocked = globallyBlocked;
	__kustoKustoPolicyRevocationGenerations = Object.fromEntries(Object.entries(revocationGenerations)
		.map(([cluster, generation]) => [kustoClusterKey(cluster), Number(generation)] as const)
		.filter(([cluster, generation]) => !!cluster && Number.isSafeInteger(generation) && generation >= 0));
	if (__kustoRequiredPolicyRequestId) {
		__kustoRequiredPolicyRequestId = '';
	}
	__kustoKustoPolicyReady = true;
	let changed = false;

	__kustoDeferredRestoredResultJobs = __kustoDeferredRestoredResultJobs.filter(job => {
		if (!__kustoIsKustoOwnedRestore(job)) return true;
		if (!__kustoIsDeferredResultJobDocumentCurrent(job)) return false;
		if (__kustoIsProtectedKustoResult(job.boxId, job.kustoClusterUrl, job.kustoConnectionIdHint)) {
			if (pState.queryResultJsonByBoxId?.[job.boxId] === job.resultJson) __kustoDeleteStoredQueryResultJson(job.boxId);
			changed = true;
			return false;
		}
		const ownerState = __kustoGetDeferredResultJobOwnerState(job);
		if (ownerState === 'invalid') changed = true;
		return ownerState !== 'invalid';
	});

	for (const rawBoxId of queryBoxes || []) {
		const boxId = String(rawBoxId || '').trim();
		if (!boxId || __kustoIsSqlOwnedQueryBox(boxId) || !__kustoIsProtectedKustoResult(boxId)) continue;
		const hadStoredResult = !!pState.queryResultJsonByBoxId?.[boxId];
		const hadRenderedResult = !!getResultsState(boxId);
		__kustoDeleteStoredQueryResultJson(boxId);
		clearResultsState(boxId);
		try { (document.getElementById(boxId) as any)?.clearResults?.(); } catch (e) { console.error('[kusto]', e); }
		if (pState.lastExecutedBox === boxId) pState.lastExecutedBox = '';
		changed = changed || hadStoredResult || hadRenderedResult;
	}

	if (changed) {
		__kustoPendingProtectedResultPurge = true;
	}
	__kustoScheduleDeferredRestoredResults();
	if (__kustoPendingProtectedResultPurge
		&& !__kustoDeferredRestoredResultJobs.some(__kustoIsKustoOwnedRestore)) {
		try { __kustoRequestProtectedResultPurge(); } catch (e) { console.error('[kusto]', e); }
	}
}

function __kustoQueueRestoredResult(job: Omit<DeferredRestoredResultJob, 'generation' | 'documentUri' | 'initialResultsRevision' | 'persistenceEpoch'>): void {
	try {
		const boxId = String(job.boxId || '');
		const resultJson = String(job.resultJson || '');
		if (!boxId || !resultJson) return;
		if (job.kind === 'sql') {
			const section = __kustoGetSqlSectionElement(boxId);
			if (typeof section?.canPersistResults === 'function' && !section.canPersistResults()) return;
		}
		if (job.kind === 'query' && !job.sqlOwnerConnectionId && __kustoKustoPolicyReady) {
			if (__kustoIsProtectedKustoResult(boxId, job.kustoClusterUrl, job.kustoConnectionIdHint)) {
				__kustoDeleteStoredQueryResultJson(boxId);
				__kustoRequestProtectedResultPurge();
				return;
			}
		}
		__kustoDeferredRestoredResultJobs.push({
			...job,
			boxId,
			resultJson,
			generation: __kustoRestoreResultGeneration,
			documentUri: String(pState.documentUri || ''),
			initialResultsRevision: getResultsStateRevision(boxId),
			persistenceEpoch: __kustoPersistenceEpoch,
		});
	} catch (e) { console.error('[kusto]', e); }
}

function __kustoIsDeferredResultJobDocumentCurrent(job: DeferredRestoredResultJob): boolean {
	return job.generation === __kustoRestoreResultGeneration
		&& String(pState.documentUri || '') === job.documentUri;
}

function __kustoCurrentRestoredQueryText(job: DeferredRestoredResultJob): string {
	if (job.kind === 'sql') {
		const sqlSection = __kustoGetSqlSectionElement(job.boxId);
		const sectionQuery = sqlSection?.getQuery?.();
		return String(sectionQuery !== undefined ? sectionQuery : pState.pendingSqlQueryByBoxId?.[job.boxId] || '');
	}
	const editorQuery = queryEditors?.[job.boxId]?.getValue?.();
	const pendingQuery = pState.pendingQueryTextByBoxId?.[job.boxId];
	return String(editorQuery !== undefined && (editorQuery !== '' || pendingQuery === undefined)
		? editorQuery
		: pendingQuery || '');
}

function __kustoLiveSqlRestoredResultProducer(job: DeferredRestoredResultJob): Readonly<{
	engine: 'sql';
	query: string;
	connectionId: string;
	database: string;
}> | undefined {
	if (!job.sqlOwnerConnectionId) return undefined;
	const ownerBoxId = String(job.sqlOwnerSourceBoxId || job.boxId).trim();
	const ownerSection = __kustoGetSqlSectionElement(ownerBoxId);
	if (!ownerSection) return undefined;
	const query = __kustoCurrentRestoredQueryText(job);
	const connectionId = String(ownerSection.getConnectionId?.() || ownerSection.getSqlConnectionId?.() || '').trim();
	const database = String(ownerSection.getDatabase?.() || '').trim();
	return query.trim() && connectionId && database ? { engine: 'sql', query, connectionId, database } : undefined;
}

function __kustoGetDeferredResultJobOwnerState(job: DeferredRestoredResultJob): DeferredRestoredResultState {
	try {
		if (!__kustoIsDeferredResultJobDocumentCurrent(job)) return 'invalid';
		if (job.persistenceEpoch !== __kustoPersistenceEpoch) return 'invalid';
		if (getResultsStateRevision(job.boxId) !== job.initialResultsRevision) return 'invalid';
		const sectionEl = document.getElementById(job.boxId);
		if (!sectionEl) return 'invalid';
		const tag = String(sectionEl.tagName || '').toLowerCase();
		if (__kustoIsReadOnlyBrowserViewer()) {
			const expectedTag = job.kind === 'sql' ? 'kw-sql-section' : 'kw-query-section';
			if (tag !== expectedTag) return 'invalid';
			if (job.expectedQueryText !== undefined
				&& __kustoCurrentRestoredQueryText(job) !== job.expectedQueryText) return 'invalid';
			if (queryExecutionTimers?.[job.boxId]) return 'invalid';
			return 'ready';
		}
		if (job.sqlOwnerConnectionId) {
			const liveProducer = __kustoLiveSqlRestoredResultProducer(job);
			if (!liveProducer) return 'pending';
			if (liveProducer.query !== String(job.expectedQueryText || '')
				|| liveProducer.connectionId !== String(job.sqlOwnerConnectionId || '').trim()
				|| liveProducer.database.toLowerCase() !== String(job.expectedResultDatabase || '').trim().toLowerCase()) {
				return 'invalid';
			}
		}
		if (job.kind === 'query') {
			if (!job.sqlOwnerConnectionId && job.expectedQueryText !== undefined) {
				const editorQuery = queryEditors?.[job.boxId]?.getValue?.();
				const pendingQuery = pState.pendingQueryTextByBoxId?.[job.boxId];
				const currentQuery = String(editorQuery !== undefined && (editorQuery !== '' || pendingQuery === undefined)
					? editorQuery
					: pendingQuery || '');
				if (currentQuery !== job.expectedQueryText) return 'invalid';
				const expectedClusterUrl = String(job.kustoClusterUrl || '').trim();
				const expectedDatabase = String(job.kustoDatabase || '').trim();
				if (!expectedClusterUrl || !expectedDatabase) return 'invalid';
				const resolution = resolveKustoConnection(connections || [], {
					clusterUrl: expectedClusterUrl,
					authorityId: job.kustoAuthorityId,
					connectionIdHint: job.kustoConnectionIdHint,
				});
				if (resolution.kind === 'missing') return 'pending';
				if (resolution.kind !== 'matched') return 'invalid';
				const currentConnectionId = String((sectionEl as any).getConnectionId?.() || '').trim();
				const currentDatabase = String((sectionEl as any).getDatabase?.() || '').trim();
				if (!currentConnectionId || !currentDatabase) return 'pending';
				if (currentConnectionId !== String(resolution.connection.id || '').trim()) return 'invalid';
				if (currentDatabase !== expectedDatabase) return 'invalid';
				const expectedAccountPartition = String(job.kustoAccountPartition || '').trim();
				const currentAccountPartition = String((resolution.connection as any).accountPartition || '').trim();
				const expectedRevision = Number(job.kustoLeaveNoTraceRevision);
				const currentRevision = __kustoKustoPolicyRevocationGenerations[kustoClusterKey(expectedClusterUrl)] ?? 0;
				if (!expectedAccountPartition || currentAccountPartition !== expectedAccountPartition
					|| !Number.isSafeInteger(expectedRevision) || expectedRevision < 0
					|| currentRevision !== expectedRevision) return 'invalid';
			}
			if (job.derivedSourceBoxId) {
				if (job.derivedSourceBoxId === job.boxId) return 'invalid';
				if (__kustoHasDeferredResultDependencyCycle(job)) return 'invalid';
				if (!getCurrentResultArtifact(job.derivedSourceBoxId)) {
					return __kustoDeferredRestoredResultJobs.some(candidate => (
						candidate !== job && candidate.boxId === job.derivedSourceBoxId
					)) ? 'pending' : 'invalid';
				}
			}
			if (queryExecutionTimers?.[job.boxId]) return 'invalid';
			return tag === 'kw-query-section' ? 'ready' : 'invalid';
		}
		if (typeof (sectionEl as any).canPersistResults === 'function' && !(sectionEl as any).canPersistResults()) return 'invalid';
		if ((sectionEl as any)._executing === true || (sectionEl as HTMLElement).dataset?.testExecuting === 'true') return 'invalid';
		return tag === 'kw-sql-section' ? 'ready' : 'invalid';
	} catch {
		return 'invalid';
	}
}

function __kustoGetDeferredResultJobState(job: DeferredRestoredResultJob): DeferredRestoredResultState {
	const ownerState = __kustoGetDeferredResultJobOwnerState(job);
	if (ownerState !== 'ready') return ownerState;
	if (__kustoIsReadOnlyBrowserViewer()) {
		const stored = String(pState.queryResultJsonByBoxId?.[job.boxId] || '');
		return job.kind === 'query' ? (!stored || stored === job.resultJson ? 'ready' : 'invalid')
			: (stored === job.resultJson ? 'ready' : 'invalid');
	}
	if (__kustoIsKustoOwnedRestore(job)) {
		if (!__kustoKustoPolicyReady) return 'pending';
		if (__kustoIsProtectedKustoResult(job.boxId, job.kustoClusterUrl, job.kustoConnectionIdHint)) return 'invalid';
	}
	const stored = String(pState.queryResultJsonByBoxId?.[job.boxId] || '');
	return (__kustoIsKustoOwnedRestore(job) ? !stored || stored === job.resultJson : stored === job.resultJson)
		? 'ready'
		: 'invalid';
	}

function __kustoIsDeferredResultJobCurrent(job: DeferredRestoredResultJob): boolean {
	return __kustoGetDeferredResultJobState(job) === 'ready';
}

export function getDeferredRestoredResultJobCountForTest(): number {
	return __kustoDeferredRestoredResultJobs.length;
}

function __kustoPersistedArtifactClaimsCapability(
	value: unknown,
	capability: 'sendToModel' | 'shareToClipboard' | 'exportToCsv',
): boolean {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const policy = (value as { policy?: unknown }).policy;
	return !!policy && typeof policy === 'object' && !Array.isArray(policy)
		&& (policy as Record<string, unknown>)[capability] === true;
}

function __kustoTrustedRestoredResultProducer(job: DeferredRestoredResultJob): Readonly<{
	engine: 'kusto' | 'sql';
	query: string;
	connectionId: string;
	database: string;
}> | undefined {
	const liveSqlProducer = __kustoLiveSqlRestoredResultProducer(job);
	if (job.sqlOwnerConnectionId) return liveSqlProducer;
	const section = document.getElementById(job.boxId) as any;
	const engine = 'kusto';
	const query = __kustoCurrentRestoredQueryText(job);
	const connectionId = String(section?.getConnectionId?.() || '').trim();
	const database = String(job.expectedResultDatabase || job.kustoDatabase || section?.getDatabase?.() || '').trim();
	return query.trim() && connectionId && database ? { engine, query, connectionId, database } : undefined;
}

function __kustoExpectedPersistedProducer(
	value: unknown,
	trustedProducer: Readonly<{ engine: 'kusto' | 'sql'; query: string; connectionId: string; database: string }>,
	strict: boolean,
): Readonly<{ engine?: string; query?: string; connectionId?: string; database?: string }> | undefined {
	if (strict) return trustedProducer;
	if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
	const producer = (value as { producer?: unknown }).producer;
	if (!producer || typeof producer !== 'object' || Array.isArray(producer)) return undefined;
	const expected: { engine?: string; query?: string; connectionId?: string; database?: string } = {};
	for (const key of ['engine', 'query', 'connectionId', 'database'] as const) {
		if ((producer as Record<string, unknown>)[key] !== undefined) expected[key] = trustedProducer[key];
	}
	return Object.keys(expected).length ? expected : undefined;
}

function __kustoRenderDeferredRestoredResult(job: DeferredRestoredResultJob): void {
	try {
		if (!__kustoIsDeferredResultJobCurrent(job)) return;
		let parsed: any;
		try {
			parsed = JSON.parse(job.resultJson);
		} catch {
			if (pState.queryResultJsonByBoxId?.[job.boxId] === job.resultJson) {
				__kustoDeleteStoredQueryResultJson(job.boxId);
			}
			return;
		}
		if (!parsed || typeof parsed !== 'object') return;
		if (!__kustoIsDeferredResultJobCurrent(job)) return;

		if (!parsed.metadata || typeof parsed.metadata !== 'object') {
			parsed.metadata = { executionTime: '' };
		} else if (typeof parsed.metadata.executionTime === 'undefined') {
			parsed.metadata.executionTime = '';
		}
		const parsedColumns = Array.isArray(parsed.columns) ? parsed.columns : [];
		parsed.rows = projectRowsToDeclaredColumns(parsedColumns, parsed.rows);

		if (job.kind === 'sql') {
			try {
				const rh = job.resultsHeightPx;
				if (typeof rh === 'number' && Number.isFinite(rh) && rh > 0) {
					const sqlWrapper = document.getElementById(job.boxId + '_sql_results_wrapper') as HTMLElement | null;
					if (sqlWrapper) {
						sqlWrapper.style.height = Math.max(120, Math.round(rh)) + 'px';
						sqlWrapper.dataset.kustoUserResized = 'true';
					}
				}
			} catch (e) { console.error('[kusto]', e); }
		}

		if (!__kustoIsDeferredResultJobCurrent(job)) return;
		const browserReadOnly = __kustoIsReadOnlyBrowserViewer();
		if (__kustoIsKustoOwnedRestore(job) && !browserReadOnly) {
			if (!__kustoSetKustoResultOwner(job.boxId, {
				accountPartition: job.kustoAccountPartition,
				leaveNoTraceRevision: job.kustoLeaveNoTraceRevision,
			})) return;
			__kustoSetStoredQueryResultJson(job.boxId, job.resultJson);
		}
		pState.lastExecutedBox = job.boxId;
		const trustedProducer = __kustoTrustedRestoredResultProducer(job);
		const derivedSourceArtifact = job.derivedSourceBoxId
			? getCurrentResultArtifact(job.derivedSourceBoxId)
			: null;
		const trustedDerivedPublication = derivedSourceArtifact
			? createDerivedResultArtifactPublication(
				{
					...(trustedProducer || { engine: job.sqlOwnerConnectionId ? 'sql' : 'kusto' }),
					boxId: job.boxId,
					producer: 'comparison',
				},
				[{ artifact: derivedSourceArtifact, role: 'comparison-source' }],
			)
			: undefined;
		const baseExpectedPolicy = {
				exposeToActiveContent: true,
				...(__kustoPersistedArtifactClaimsCapability(job.resultArtifact, 'sendToModel') ? { sendToModel: true } : {}),
				...(__kustoIsKustoOwnedRestore(job) ? {
				accountPartition: job.kustoAccountPartition,
				leaveNoTraceRevision: job.kustoLeaveNoTraceRevision,
				} : {}),
				...(job.derivedSourceBoxId ? {
					derivedLineage: trustedDerivedPublication?.lineage || [],
					derivedSourcePolicies: trustedDerivedPublication?.policy?.sourcePolicies || [],
				} : {}),
			};
		const claimsClipboardShare = __kustoPersistedArtifactClaimsCapability(job.resultArtifact, 'shareToClipboard');
		const claimsCsvExport = __kustoPersistedArtifactClaimsCapability(job.resultArtifact, 'exportToCsv');
		const claimsModelUse = __kustoPersistedArtifactClaimsCapability(job.resultArtifact, 'sendToModel');
		const claimsProducerCapability = claimsModelUse || claimsClipboardShare || claimsCsvExport;
		const expectedProducer = trustedProducer
			? __kustoExpectedPersistedProducer(job.resultArtifact, trustedProducer, claimsProducerCapability)
			: undefined;
		const persistedPublication: ResultArtifactPublication | undefined = browserReadOnly
			? {
				producer: {
					engine: job.kind === 'sql' ? 'sql' : 'kusto', boxId: job.boxId,
					query: __kustoCurrentRestoredQueryText(job), producer: 'browser-restored',
				},
				policy: { exportToCsv: true },
			}
			: (trustedProducer
				? publicationFromPersistedResultArtifact(job.resultArtifact, job.boxId, {
					...baseExpectedPolicy,
					...(claimsClipboardShare ? { shareToClipboard: true } : {}),
					...(claimsCsvExport ? { exportToCsv: true } : {}),
					...(expectedProducer ? { expectedProducer } : {}),
				})
				: undefined);
		const artifactPublication: ResultArtifactPublication | undefined = persistedPublication && trustedProducer && !browserReadOnly
			? {
				...persistedPublication,
				producer: {
					...persistedPublication.producer,
					...trustedProducer,
					boxId: job.boxId,
					producer: persistedPublication.producer?.producer || 'restored',
				},
			}
			: persistedPublication;
		if (job.derivedSourceBoxId && !artifactPublication) {
			__kustoDeleteStoredQueryResultJson(job.boxId);
			return;
		}
		const resultAccepted = displayResultForBox(parsed, job.boxId, {
			label: 'Results',
			showExecutionTime: true,
			...(artifactPublication ? { artifactPublication } : {}),
		});
		if (resultAccepted === false) {
			__kustoDeleteStoredQueryResultJson(job.boxId);
			return;
		}
		const restoredArtifact = toPersistedResultArtifact(getCurrentResultArtifact(job.boxId));
		__kustoSetStoredResultArtifact(
			job.boxId,
			restoredArtifact || job.resultArtifact,
			artifactPublication,
		);
		if (job.kind === 'query') {
			try {
				__kustoSetQueryResultsOutputHeightPx(job.boxId, job.resultsHeightPx);
			} catch (e) { console.error('[kusto]', e); }
		}
	} catch (e) { console.error('[kusto]', e); }
}

function __kustoScheduleDeferredRestoredResults(): void {
	try {
		if (__kustoDeferredRestoredResultScheduled || __kustoDeferredRestoredResultJobs.length === 0) return;
		if (!__kustoIsReadOnlyBrowserViewer()
			&& !__kustoKustoPolicyReady && __kustoDeferredRestoredResultJobs.every(__kustoIsKustoOwnedRestore)) return;
		__kustoDeferredRestoredResultScheduled = true;
		__kustoQueueIdle(() => {
			__kustoDeferredRestoredResultScheduled = false;
			const nextIndex = __kustoDeferredRestoredResultJobs.findIndex(job => __kustoGetDeferredResultJobState(job) !== 'pending');
			const job = nextIndex >= 0 ? __kustoDeferredRestoredResultJobs.splice(nextIndex, 1)[0] : undefined;
			if (job) {
				if (__kustoGetDeferredResultJobState(job) === 'ready') {
					__kustoRenderDeferredRestoredResult(job);
				} else {
					__kustoDeleteStoredQueryResultJson(job.boxId);
					if (__kustoIsKustoOwnedRestore(job)) __kustoPendingProtectedResultPurge = true;
				}
			}
			if (__kustoDeferredRestoredResultJobs.some(candidate => __kustoGetDeferredResultJobState(candidate) !== 'pending')) {
				__kustoScheduleDeferredRestoredResults();
			} else if (__kustoPendingProtectedResultPurge) {
				__kustoRequestProtectedResultPurge();
			}
		});
	} catch (e) { console.error('[kusto]', e); }
}

export function resolvePendingKustoResultRestores(): void {
	while (true) {
		const nextIndex = __kustoDeferredRestoredResultJobs.findIndex(job => __kustoGetDeferredResultJobState(job) !== 'pending');
		if (nextIndex < 0) break;
		const job = __kustoDeferredRestoredResultJobs.splice(nextIndex, 1)[0];
		if (__kustoGetDeferredResultJobState(job) === 'ready') {
			__kustoRenderDeferredRestoredResult(job);
		} else {
			__kustoDeleteStoredQueryResultJson(job.boxId);
			if (__kustoIsKustoOwnedRestore(job)) __kustoPendingProtectedResultPurge = true;
		}
	}
	if (__kustoPendingProtectedResultPurge
		&& !__kustoDeferredRestoredResultJobs.some(__kustoIsKustoOwnedRestore)) {
		__kustoRequestProtectedResultPurge();
	}
}

export function __kustoScheduleHtmlPowerBiCompatibilityCheck(_reason: string = 'document-restore'): void {
	try {
		__kustoCancelHtmlPowerBiCompatibilityCheck();
		if (pState.htmlPowerBiCompatibilityCheckEnabled === false) {
			__kustoClearHtmlPowerBiCompatibilityNotices();
			return;
		}
		const ids = Array.isArray(htmlBoxes) ? htmlBoxes.slice().map((id: any) => String(id || '')).filter(Boolean) : [];
		if (ids.length === 0) return;
		const runToken = ++__kustoHtmlPowerBiCompatibilityRunToken;
		__kustoHtmlPowerBiCompatibilityTimer = setTimeout(() => {
			__kustoHtmlPowerBiCompatibilityTimer = null;
			const pending = ids.slice();
			const processNextBatch = () => {
				try {
					if (runToken !== __kustoHtmlPowerBiCompatibilityRunToken) return;
					const startedAt = Date.now();
					let processed = 0;
					while (pending.length > 0 && processed < 2 && Date.now() - startedAt < 12) {
						const id = pending.shift();
						const el = id ? document.getElementById(id) as any : null;
						if (el && typeof el.evaluatePowerBiCompatibilityNotice === 'function') {
							const shouldRun = typeof el.shouldRunPowerBiCompatibilityNoticeCheck === 'function'
								? el.shouldRunPowerBiCompatibilityNoticeCheck()
								: !(typeof el.isPowerBiUpgradeNoticeDismissed === 'function' && el.isPowerBiUpgradeNoticeDismissed());
							if (shouldRun) el.evaluatePowerBiCompatibilityNotice();
						}
						processed++;
					}
					if (pending.length > 0) {
						__kustoQueueIdle(processNextBatch);
					}
				} catch (e) { console.error('[kusto]', e); }
			};
			__kustoQueueIdle(processNextBatch);
		}, 500);
	} catch (e) { console.error('[kusto]', e); }
}

// Document capabilities (set by extension host via the persistenceMode message).
// - allowedSectionKinds controls which add buttons are shown/enabled.
// - defaultSectionKind controls which section we create for an empty document.
// - upgradeRequestType controls which message we send when in compatibility mode.
// Defaults are set in pState (shared/persistence-state.ts).

export function __kustoApplyDocumentCapabilities() {
	try {
		const allowed = Array.isArray(pState.allowedSectionKinds)
			? pState.allowedSectionKinds.map((k: any) => String(k))
			: ['query', 'python', 'url', 'html', 'markdown'];

		// If no section kinds are allowed, hide the entire add-controls container.
		const addControlsContainer = document.querySelector('.add-controls') as HTMLElement | null;
		if (addControlsContainer) {
			addControlsContainer.style.display = allowed.length === 0 ? 'none' : '';
		}

		// Update inline buttons visibility.
		// NOTE: Buttons inside .add-controls-options share a common parent, so we hide
		// individual buttons directly rather than trying to hide a wrapper element.
		const btns = document.querySelectorAll('.add-controls-options .add-control-btn');
		for (const btn of btns as any) {
			try {
				const kind = btn && btn.getAttribute ? String(btn.getAttribute('data-add-kind') || '') : '';
				const visible = !kind || allowed.includes(kind);
				btn.style.display = visible ? '' : 'none';
			} catch (e) { console.error('[kusto]', e); }
		}

		// Update dropdown items visibility (for narrow viewport dropdown)
		const dropdownItems = document.querySelectorAll('.add-controls-dropdown-item[data-add-kind]');
		for (const item of dropdownItems as any) {
			try {
				const kind = item.getAttribute ? String(item.getAttribute('data-add-kind') || '') : '';
				const visible = !kind || allowed.includes(kind);
				item.style.display = visible ? '' : 'none';
			} catch (e) { console.error('[kusto]', e); }
		}
	} catch (e) { console.error('[kusto]', e); }
}

export function __kustoSetCompatibilityMode(enabled: any) {
	try {
		pState.compatibilityMode = !!enabled;
		const msg = String(pState.compatibilityTooltip || 'This file is in .kql/.csl mode. Click to upgrade to .kqlx and enable sections.');
		const wrappers = document.querySelectorAll('.add-controls .add-control-wrapper');
		for (const w of wrappers as any) {
			try {
				if (enabled) {
					w.title = msg;
				} else if (w.title === msg) {
					w.title = '';
				}
			} catch (e) { console.error('[kusto]', e); }
		}
		const buttons = document.querySelectorAll('.add-controls .add-control-btn');
		for (const btn of buttons as any) {
			try {
				// Keep enabled; clicking will offer to upgrade.
				btn.disabled = false;
				btn.setAttribute('aria-disabled', 'false');
				// Tooltip is on wrapper span.
				btn.title = '';
			} catch (e) { console.error('[kusto]', e); }
		}

		// Apply visibility of add buttons based on allowed kinds.
		try { __kustoApplyDocumentCapabilities(); } catch (e) { console.error('[kusto]', e); }

		// If we just entered compatibility mode, ensure any early queued add clicks don't
		// accidentally create extra sections that can't be persisted.
		if (enabled) {
			try {
				pState.queryEditorPendingAdds = { query: 0, chart: 0, transformation: 0, markdown: 0, python: 0, url: 0 };
			} catch (e) { console.error('[kusto]', e); }
		}
	} catch (e) { console.error('[kusto]', e); }
}

export function __kustoRequestAddSection(kind: any, afterBoxId?: string) {
	const k = String(kind || '').trim();
	if (!k) return;

	// Respect allowed section kinds.
	try {
		const allowed = Array.isArray(pState.allowedSectionKinds)
			? pState.allowedSectionKinds.map((v: any) => String(v))
			: ['query', 'chart', 'python', 'url', 'html', 'markdown'];
		if (allowed.length > 0 && !allowed.includes(k)) {
			return;
		}
	} catch (e) { console.error('[kusto]', e); }

	// For .kql/.csl compatibility files: offer upgrade instead of adding sections.
	try {
		if (pState.compatibilityMode) {
			try {
				// IMPORTANT: results persistence is debounced; if the user clicks "add chart" right
				// after executing, the current resultJson may not have been sent to the extension yet.
				// So capture the current state and send it along with the upgrade request.
				let state = null;
				try {
					if (typeof getKqlxState === 'function') {
						state = getKqlxState();
					}
				} catch (e) { console.error('[kusto]', e); }
				try { schedulePersist('upgrade', true); } catch (e) { console.error('[kusto]', e); }
				const editRevision = pState.documentEditRevision;
				if (pState.upgradeRequestType === 'requestUpgradeToMdx') {
					postMessageToHost({ type: 'requestUpgradeToMdx', addKind: k, state, editRevision });
				} else if (pState.upgradeRequestType === 'requestUpgradeToSqlx') {
					postMessageToHost({ type: 'requestUpgradeToSqlx', addKind: k, state, editRevision });
				} else {
					postMessageToHost({ type: 'requestUpgradeToKqlx', addKind: k, state, editRevision });
				}
			} catch (e) { console.error('[kusto]', e); }
			return;
		}
	} catch (e) { console.error('[kusto]', e); }

	// Build options with insertion position if provided.
	const opts: Record<string, unknown> = afterBoxId ? { afterBoxId } : {};

	// Normal .kqlx flow.
	if (k === 'query') return addQueryBox(opts);
	if (k === 'chart') return addChartBox(opts);
	if (k === 'transformation') return addTransformationBox(opts);
	if (k === 'markdown') return addMarkdownBox(opts);
	if (k === 'python') return addPythonBox(opts);
	if (k === 'url') return addUrlBox(opts);
	if (k === 'html') return addHtmlBox(opts);
	if (k === 'sql') return addSqlBox(opts);
	// copilotQuery sections are deprecated; Copilot chat is now a per-editor toolbar toggle.
}

// Replace the early bootstrap stub (defined in queryEditor.js before all scripts load).
// In some browsers, relying on a global function declaration is not enough to override
// an existing window property, so assign explicitly.
try {
	_win.__kustoRequestAddSection = __kustoRequestAddSection;
} catch (e) { console.error('[kusto]', e); }

// During restore, Monaco editors are created asynchronously.
// Stash initial values here so init*Editor can apply them once the editor exists.
// (State maps are in pState — shared/persistence-state.ts.)
// Keep a cap to avoid ballooning the file, but try hard to keep *some* results
// (e.g. truncate rows) instead of dropping them entirely.
//
// Note: this is per-query-box, and the document can contain multiple boxes.
// We intentionally allow several MB because session.kqlx lives in extension global storage.
const __kustoMaxPersistedResultBytes = 5 * 1024 * 1024;
const __kustoMaxPersistedResultRowsHardCap = 5000;

const __kustoStoredResultSignatureByBoxId: Record<string, { json: string; token: string }> = {};
let __kustoStoredResultRevision = 0;

function __kustoResetStoredResultSignatures() {
	try {
		for (const key of Object.keys(__kustoStoredResultSignatureByBoxId)) {
			delete __kustoStoredResultSignatureByBoxId[key];
		}
	} catch (e) { console.error('[kusto]', e); }
}

function __kustoRememberStoredQueryResultJson(boxId: any, json: string) {
	try {
		const id = String(boxId || '');
		if (!id) return;
		const text = normalizePersistedResultJson(json);
		const current = __kustoStoredResultSignatureByBoxId[id];
		if (current && current.json === text) {
			return;
		}
		__kustoStoredResultRevision += 1;
		__kustoStoredResultSignatureByBoxId[id] = {
			json: text,
			token: 'result:' + __kustoStoredResultRevision + ':len:' + text.length,
		};
	} catch (e) { console.error('[kusto]', e); }
}

function __kustoSetStoredQueryResultJson(boxId: any, json: string) {
	try {
		const id = String(boxId || '');
		if (!id) return;
		const text = normalizePersistedResultJson(json);
		pState.queryResultJsonByBoxId[id] = text;
		__kustoRememberStoredQueryResultJson(id, text);
	} catch (e) { console.error('[kusto]', e); }
}

function __kustoSetStoredResultArtifact(
	boxId: unknown,
	value: unknown,
	locallyAdmittedPublication?: ResultArtifactPublication,
): void {
	const id = String(boxId || '').trim();
	if (!id) return;
	const admittedArtifact = getCurrentResultArtifact(id);
	const admittedPolicy = locallyAdmittedPublication?.policy || admittedArtifact?.policy;
	const admittedLineage = locallyAdmittedPublication?.lineage || admittedArtifact?.lineage;
	const publication = publicationFromPersistedResultArtifact(value, id, admittedPolicy ? {
		accountPartition: admittedPolicy.accountPartition,
		leaveNoTraceRevision: admittedPolicy.leaveNoTraceRevision,
		exposeToActiveContent: admittedPolicy.exposeToActiveContent,
		sendToModel: admittedPolicy.sendToModel,
		shareToClipboard: admittedPolicy.shareToClipboard,
		exportToCsv: admittedPolicy.exportToCsv,
		...(locallyAdmittedPublication?.producer ? {
			expectedProducer: {
				engine: locallyAdmittedPublication.producer.engine,
				query: locallyAdmittedPublication.producer.query,
				connectionId: locallyAdmittedPublication.producer.connectionId,
				database: locallyAdmittedPublication.producer.database,
			},
		} : {}),
		...(admittedLineage?.length ? {
			derivedLineage: admittedLineage,
			derivedSourcePolicies: admittedPolicy.sourcePolicies,
		} : {}),
	} : undefined);
	if (!publication?.persistedIdentity) {
		delete pState.resultArtifactByBoxId[id];
		return;
	}
	pState.resultArtifactByBoxId[id] = {
		version: 1,
		...publication.persistedIdentity,
		...(publication.producer ? { producer: publication.producer } : {}),
		...(publication.policy ? { policy: publication.policy } : {}),
		...(publication.lineage?.length ? { lineage: publication.lineage } : {}),
	} satisfies PersistedResultArtifactV1;
}

function __kustoSetKustoResultOwner(boxId: any, owner: unknown): boolean {
	const id = String(boxId || '').trim();
	const candidate = owner as { accountPartition?: unknown; leaveNoTraceRevision?: unknown } | undefined;
	const accountPartition = String(candidate?.accountPartition || '').trim();
	const leaveNoTraceRevision = Number(candidate?.leaveNoTraceRevision);
	if (!id || !accountPartition || !Number.isSafeInteger(leaveNoTraceRevision) || leaveNoTraceRevision < 0) return false;
	pState.kustoResultOwnerByBoxId[id] = { accountPartition, leaveNoTraceRevision };
	return true;
}

function __kustoDeleteStoredQueryResultJson(boxId: any) {
	try {
		const id = String(boxId || '');
		if (!id) return;
		delete pState.queryResultJsonByBoxId[id];
		delete pState.resultArtifactByBoxId[id];
		delete pState.kustoResultOwnerByBoxId[id];
		delete __kustoStoredResultSignatureByBoxId[id];
	} catch (e) { console.error('[kusto]', e); }
}

export function __kustoClearStoredQueryResult(boxId: any) {
	__kustoDeleteStoredQueryResultJson(boxId);
}

function __kustoGetStoredQueryResultToken(boxId: any, resultJson: any) {
	try {
		const id = String(boxId || '');
		const text = String(resultJson || '');
		if (!text) return '';
		if (!id) {
			return 'result:anonymous:len:' + text.length;
		}
		const current = __kustoStoredResultSignatureByBoxId[id];
		if (!current || current.json !== text) {
			__kustoRememberStoredQueryResultJson(id, text);
		}
		return __kustoStoredResultSignatureByBoxId[id]?.token || ('result:unknown:len:' + text.length);
	} catch {
		return '';
	}
}

function __kustoBuildPersistSignatureState(value: any): any {
	try {
		if (Array.isArray(value)) {
			return value.map(item => __kustoBuildPersistSignatureState(item));
		}
		if (!value || typeof value !== 'object') {
			return value;
		}
		const copy: Record<string, unknown> = {};
		for (const [key, child] of Object.entries(value)) {
			if (__kustoIsImplicitPersistSignatureDefault(key, child)) {
				continue;
			}
			if (key === 'resultJson' && typeof child === 'string' && child) {
				copy[key] = __kustoGetStoredQueryResultToken((value as any).id, child);
			} else {
				copy[key] = __kustoBuildPersistSignatureState(child);
			}
		}
		return copy;
	} catch {
		return value;
	}
}

function __kustoIsImplicitPersistSignatureDefault(key: string, value: unknown): boolean {
	if (key === 'expanded' && value === true) return true;
	if (key === 'resultsVisible' && value === true) return true;
	if (key === 'runMode' && (String(value || '') === 'take100' || String(value || '') === 'top100')) return true;
	if (key === 'cacheEnabled' && value === true) return true;
	if (key === 'cacheValue' && value === 1) return true;
	if (key === 'cacheUnit' && String(value || '') === 'days') return true;
	return false;
}

function __kustoGetPersistSignature(state: any) {
	try {
		return JSON.stringify(__kustoBuildPersistSignatureState(state));
	} catch {
		return '';
	}
}

export function __kustoTryStoreQueryResult(boxId: any, result: any, kustoOwner?: unknown) {
	try {
		if (!boxId) return;
		const id = String(boxId || '');
		const section = (document.getElementById(id)
			|| Array.from(document.querySelectorAll('kw-sql-section')).find(element =>
				String((element as any).boxId || element.getAttribute('box-id') || '') === id
			)) as any;
		const tagName = String(section?.tagName || '').toLowerCase();
		const sqlOwnedQuery = __kustoIsSqlOwnedQueryBox(id);
		const kustoOwned = !sqlOwnedQuery
			&& (tagName === 'kw-query-section' || (id.startsWith('query_') && typeof section?.canPersistResults !== 'function'));
		if (kustoOwned && !canPersistKustoResult(section?.getClusterUrl?.())) {
			__kustoDeleteStoredQueryResultJson(boxId);
			return;
		}
		if (sqlOwnedQuery) {
			const sourceBoxId = String((optimizationMetadataByBoxId[id] as any)?.sourceBoxId || '').trim();
			const source = sourceBoxId ? __kustoGetSqlSectionElement(sourceBoxId) : undefined;
			if (typeof source?.canPersistResults === 'function' && !source.canPersistResults()) {
				__kustoDeleteStoredQueryResultJson(boxId);
				return;
			}
		}
		if (typeof section?.canPersistResults === 'function' && !section.canPersistResults()) {
			__kustoDeleteStoredQueryResultJson(boxId);
			return;
		}
		const columns = Array.isArray(result?.columns) ? result.columns : [];
		const sourceRows = Array.isArray(result?.rows) ? result.rows : [];
		const rows = projectRowsToDeclaredColumns(columns, sourceRows);
		const persistedResult = rows === sourceRows ? result : { ...result, columns, rows };
		const { json } = trySerializeQueryResult(persistedResult, __kustoMaxPersistedResultBytes, __kustoMaxPersistedResultRowsHardCap);
		if (json) {
			if (kustoOwned && !__kustoSetKustoResultOwner(boxId, kustoOwner)) {
				__kustoDeleteStoredQueryResultJson(boxId);
				return;
			}
			__kustoSetStoredQueryResultJson(boxId, json);
			const descriptor = toPersistedResultArtifact(getCurrentResultArtifact(id));
			if (descriptor) pState.resultArtifactByBoxId[id] = descriptor;
			else delete pState.resultArtifactByBoxId[id];
		} else {
			__kustoDeleteStoredQueryResultJson(boxId);
		}
	} catch (e) { console.error('[kusto]', e); }
}

// Called by main.js when query results arrive.
export function __kustoOnQueryResult(boxId: any, result: any, kustoOwner?: unknown) {
	__kustoTryStoreQueryResult(boxId, result, kustoOwner);
	try { schedulePersist && schedulePersist(); } catch (e) { console.error('[kusto]', e); }
}

function __kustoFindQueryEditorWrapper(boxId: any, suffix: any) {
	try {
		const el = document.getElementById(boxId + suffix);
		let wrapper = (el && el.closest) ? el.closest('.query-editor-wrapper') as HTMLElement | null : null;
		if (!wrapper) {
			const box = document.getElementById(boxId);
			wrapper = (box && box.querySelector) ? box.querySelector('.query-editor-wrapper') as HTMLElement | null : null;
		}
		return wrapper;
	} catch {
		return null;
	}
}

function __kustoGetWrapperHeightPx(boxId: any, suffix: any) {
	try {
		// If the user manually resized, prefer the explicit height state.
		try {
			const map = pState.manualQueryEditorHeightPxByBoxId;
			const v = map ? map[boxId] : undefined;
			if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
				return Math.max(0, Math.round(v));
			}
		} catch (e) { console.error('[kusto]', e); }

		const wrapper = __kustoFindQueryEditorWrapper(boxId, suffix);
		if (!wrapper) return undefined;
		// Only persist heights that came from an explicit user resize (or a restored persisted height).
		// Auto-resize can also set an inline height, but that should not get saved into .kqlx.
		// Only persist height if the user explicitly resized (wrapper has an inline height).
		// Otherwise, default layout can vary by window size/theme and would cause spurious "dirty" writes.
		const inlineHeight = (wrapper.style && typeof wrapper.style.height === 'string') ? wrapper.style.height.trim() : '';
		if (!inlineHeight || inlineHeight === 'auto') return undefined;
		const m = inlineHeight.match(/^([0-9]+)px$/i);
		if (!m) return undefined;
		const px = parseInt(m[1], 10);
		if (!Number.isFinite(px)) return undefined;
		// If Monaco's content auto-resize set the height, do not persist.
		try {
			if (wrapper.dataset && wrapper.dataset.kustoAutoResized === 'true') {
				return undefined;
			}
		} catch (e) { console.error('[kusto]', e); }
		// Prefer the explicit user-resize marker, but accept any non-auto inline height.
		return Math.max(0, px);
	} catch {
		return undefined;
	}
}

function __kustoSetWrapperHeightPx(boxId: any, suffix: any, heightPx: any) {
	try {
		const wrapper = __kustoFindQueryEditorWrapper(boxId, suffix);
		if (!wrapper) return;
		const h = Number(heightPx);
		if (!Number.isFinite(h) || h <= 0) return;
		wrapper.style.height = Math.round(h) + 'px';
		try {
			wrapper.dataset.kustoUserResized = 'true';
		} catch (e) { console.error('[kusto]', e); }
		try {
			const editor = (queryEditors && queryEditors[boxId]) ? queryEditors[boxId] : null;
			if (editor && typeof editor.layout === 'function') {
				editor.layout();
			}
		} catch (e) { console.error('[kusto]', e); }
	} catch (e) { console.error('[kusto]', e); }
}

function __kustoGetQueryResultsOutputHeightPx(boxId: any) {
	try {
		const wrapper = document.getElementById(boxId + '_results_wrapper');
		if (!wrapper) return undefined;
		// Only persist heights that came from an explicit user resize (or a restored persisted height).
		try {
			if (!wrapper.dataset || wrapper.dataset.kustoUserResized !== 'true') {
				return undefined;
			}
		} catch {
			return undefined;
		}
		let inlineHeight = (wrapper.style && typeof wrapper.style.height === 'string') ? wrapper.style.height.trim() : '';
		// When results are hidden the wrapper is collapsed to 40px;
		// return the remembered pre-collapse height instead.
		try {
			const prevToggle = (wrapper.dataset && wrapper.dataset.kustoPreviousHeight) ? String(wrapper.dataset.kustoPreviousHeight).trim() : '';
			if (prevToggle && inlineHeight === '40px') {
				inlineHeight = prevToggle;
			}
		} catch (e) { console.error('[kusto]', e); }
		// If results were temporarily collapsed to auto, keep the user's last explicit height.
		if (!inlineHeight || inlineHeight === 'auto') {
			try {
				const prev = (wrapper.dataset && wrapper.dataset.kustoPrevHeight) ? String(wrapper.dataset.kustoPrevHeight).trim() : '';
				if (prev) {
					inlineHeight = prev;
				}
			} catch (e) { console.error('[kusto]', e); }
		}
		if (!inlineHeight || inlineHeight === 'auto') return undefined;
		const m = inlineHeight.match(/^([0-9]+)px$/i);
		if (!m) return undefined;
		const px = parseInt(m[1], 10);
		return Number.isFinite(px) ? Math.max(0, px) : undefined;
	} catch {
		return undefined;
	}
}

function __kustoSetQueryResultsOutputHeightPx(boxId: any, heightPx: any) {
	try {
		const wrapper = document.getElementById(boxId + '_results_wrapper');
		if (!wrapper) return;
		const h = Number(heightPx);
		if (!Number.isFinite(h) || h <= 0) return;
		// Query results resizer bounds use ~900px max; keep persisted restore within that.
		const clamped = Math.max(120, Math.min(900, Math.round(h)));
		// If results are currently hidden, don't override the collapsed height.
		// Store the persisted height so toggling results back on restores it.
		let resultsHidden = false;
		try {
			resultsHidden = !!(pState.resultsVisibleByBoxId[boxId] === false);
		} catch (e) { console.error('[kusto]', e); }
		if (resultsHidden) {
			try { wrapper.dataset.kustoPreviousHeight = clamped + 'px'; } catch (e) { console.error('[kusto]', e); }
			try { wrapper.dataset.kustoUserResized = 'true'; } catch (e) { console.error('[kusto]', e); }
			return;
		}
		wrapper.style.height = clamped + 'px';
		try {
			wrapper.dataset.kustoRestoredHeight = 'true';
			wrapper.dataset.kustoRestoredHeightPx = String(clamped);
		} catch (e) { console.error('[kusto]', e); }
		try { wrapper.dataset.kustoUserResized = 'true'; } catch (e) { console.error('[kusto]', e); }
		// If this section currently has short non-table content (errors, etc.), clamp on next tick.
		try {
			setTimeout(() => {
				try {
					__kustoClampResultsWrapperHeight(boxId);
				} catch (e) { console.error('[kusto]', e); }
			}, 0);
		} catch (e) { console.error('[kusto]', e); }
	} catch (e) { console.error('[kusto]', e); }
}

export function getKqlxState() {
	// Compatibility mode (.kql/.csl/.md): only a single section is supported.
	try {
		if (pState.compatibilityMode) {
			const singleKind = String(pState.compatibilitySingleKind || 'query');
			if (singleKind === 'markdown') {
				let firstMarkdownBoxId = null;
				try {
					const ids = Array.isArray(markdownBoxes) ? markdownBoxes : [];
					for (const id of ids) {
						if (typeof id === 'string' && id.startsWith('markdown_')) {
							firstMarkdownBoxId = id;
							break;
						}
					}
				} catch (e) { console.error('[kusto]', e); }
				let text = '';
				try {
					text = (firstMarkdownBoxId && markdownEditors && markdownEditors[firstMarkdownBoxId])
						? (markdownEditors[firstMarkdownBoxId].getValue() || '')
						: '';
				} catch (e) { console.error('[kusto]', e); }
				if (!text) {
					try {
						const pending = firstMarkdownBoxId
							? pState.pendingMarkdownTextByBoxId[firstMarkdownBoxId]
							: undefined;
						if (typeof pending === 'string') {
							text = pending;
						}
					} catch (e) { console.error('[kusto]', e); }
				}
				return {
					...legacyDocumentPreferencesForPersistence(),
					sections: [{ type: 'markdown', ...(firstMarkdownBoxId ? { id: firstMarkdownBoxId } : {}), text }]
				};
			}

			if (singleKind === 'sql') {
				let firstSqlBoxId = null;
				try {
					const ids = Array.isArray(sqlBoxes) ? sqlBoxes : [];
					for (const id of ids) {
						if (typeof id === 'string' && __kustoGetSqlSectionElement(id)) {
							firstSqlBoxId = id;
							break;
						}
					}
				} catch (e) { console.error('[kusto]', e); }
				let query = '';
				try {
					if (firstSqlBoxId) {
						const el = __kustoGetSqlSectionElement(firstSqlBoxId);
						if (el && typeof el.getQuery === 'function') {
							query = el.getQuery() || '';
						}
					}
				} catch (e) { console.error('[kusto]', e); }
				if (!query) {
					try {
						const pending = firstSqlBoxId
							? (pState.pendingSqlQueryByBoxId && pState.pendingSqlQueryByBoxId[firstSqlBoxId])
							: undefined;
						if (typeof pending === 'string') {
							query = pending;
						}
					} catch (e) { console.error('[kusto]', e); }
				}
				return {
					...legacyDocumentPreferencesForPersistence(),
					sections: [{ type: 'sql', ...(firstSqlBoxId ? { id: firstSqlBoxId } : {}), query }]
				};
			}

			let firstQueryBoxId = null;
			try {
				const ids = Array.isArray(queryBoxes) ? queryBoxes : [];
				for (const id of ids) {
					if (typeof id === 'string' && id.startsWith('query_')) {
						firstQueryBoxId = id;
						break;
					}
				}
			} catch (e) { console.error('[kusto]', e); }
			const q = (firstQueryBoxId && queryEditors && queryEditors[firstQueryBoxId])
				? (queryEditors[firstQueryBoxId].getValue() || '')
				: '';
			let clusterUrl = '';
			let authorityId = '';
			let connectionIdHint = '';
			let database = '';
			let resultJson = '';
			let resultArtifact: PersistedResultArtifactV1 | undefined;
			let kustoResultOwner: { accountPartition: string; leaveNoTraceRevision: number } | undefined;
			let favoritesMode;
			try {
				if (firstQueryBoxId) {
					// Selection (clusterUrl + database)
					try {
						const connectionId = __kustoGetConnectionId(firstQueryBoxId);
						if (connectionId && Array.isArray(connections)) {
							const conn = (connections || []).find((c: any) => c && String(c.id || '') === String(connectionId));
							clusterUrl = conn ? String(conn.clusterUrl || '') : '';
							authorityId = conn ? String(conn.authorityId || '') : '';
							connectionIdHint = conn ? String(conn.id || '') : '';
						}
					} catch (e) { console.error('[kusto]', e); }
					try {
						database = __kustoGetDatabase(firstQueryBoxId);
					} catch (e) { console.error('[kusto]', e); }
					// Persisted results (in-memory)
					try {
						if (pState.queryResultJsonByBoxId[firstQueryBoxId]) {
							resultJson = String(pState.queryResultJsonByBoxId[firstQueryBoxId]);
							resultArtifact = toPersistedResultArtifact(getCurrentResultArtifact(firstQueryBoxId))
								|| pState.resultArtifactByBoxId[firstQueryBoxId];
							kustoResultOwner = pState.kustoResultOwnerByBoxId[firstQueryBoxId];
						}
					} catch (e) { console.error('[kusto]', e); }
					// Favorites picker UI mode
					try {
						if (typeof favoritesModeByBoxId === 'object' && favoritesModeByBoxId && Object.prototype.hasOwnProperty.call(favoritesModeByBoxId, firstQueryBoxId)) {
							favoritesMode = !!favoritesModeByBoxId[firstQueryBoxId];
						}
					} catch (e) { console.error('[kusto]', e); }
				}
			} catch (e) { console.error('[kusto]', e); }
			return {
				...legacyDocumentPreferencesForPersistence(),
				sections: [
					{
						type: 'query',
						...(firstQueryBoxId ? { id: firstQueryBoxId } : {}),
						query: q,
						...(clusterUrl ? { clusterUrl } : {}),
						...(authorityId ? { authorityId } : {}),
						...(connectionIdHint ? { connectionIdHint } : {}),
						...(database ? { database } : {}),
						// Leave no trace: don't persist results from sensitive clusters
						...(resultJson && kustoResultOwner && !__kustoIsLeaveNoTraceCluster(clusterUrl) ? {
							resultJson,
							...(resultArtifact ? { resultArtifact } : {}),
							kustoAccountPartition: kustoResultOwner.accountPartition,
							kustoLeaveNoTraceRevision: kustoResultOwner.leaveNoTraceRevision,
						} : {}),
						...(typeof favoritesMode === 'boolean' ? { favoritesMode } : {})
					}
				]
			};
		}
	} catch (e) { console.error('[kusto]', e); }

	const sections: any[] = [];
	const container = document.getElementById('queries-container');
	const children = container ? Array.from(container.children || []) : [];
	for (const child of children) {
		const id = child && child.id ? String(child.id) : '';
		if (!id) continue;

		// All section types are Lit components that implement serialize().
		const el = document.getElementById(id);
		if (el && typeof (el as any).serialize === 'function') {
			try { sections.push((el as any).serialize()); } catch (e) { console.error('[kusto]', e); }
		}
	}

	// Re-inject passthrough dev notes sections (hidden, no DOM elements)
	try {
		for (const dn of pState.devNotesSections) {
			if (dn && dn.type === 'devnotes') sections.push(dn);
		}
	} catch (e) { console.error('[kusto]', e); }

	return {
		...legacyDocumentPreferencesForPersistence(),
		sections
	};
}

let __kustoLastPersistSignature = '';
let __kustoLastPersistRevision = 0;
let __kustoLastSentPersistSignature = '';
let __kustoLastSentPersistRevision = 0;
let __kustoPersistSnapshotSequence = 0;
const __kustoPendingPersistSnapshots = new Map<string, { signature: string; revision: number }>();
const MAX_PENDING_PERSIST_SNAPSHOTS = 32;
// In compatibility mode (no sidecar), only the query text is saved to disk.
// Track the last query text separately so cluster/database-only changes don't
// trigger unnecessary persistDocument messages that would dirty the file.
let __kustoLastCompatQueryText = '';

function __kustoSeedPersistSignatureFromCurrentState(): void {
	try {
		if (__kustoPersistTimer) {
			clearTimeout(__kustoPersistTimer);
			__kustoPersistTimer = null;
		}
		const sig = __kustoGetPersistSignature(getKqlxState());
		if (sig) {
			__kustoLastPersistSignature = sig;
			__kustoLastPersistRevision = pState.documentEditRevision;
			__kustoLastSentPersistSignature = sig;
			__kustoLastSentPersistRevision = pState.documentEditRevision;
		}
		__kustoPendingPersistSnapshots.clear();
	} catch (e) { console.error('[kusto]', e); }
}

function trackPendingPersistSnapshot(snapshotId: string, signature: string, revision: number): void {
	__kustoPendingPersistSnapshots.set(snapshotId, { signature, revision });
	while (__kustoPendingPersistSnapshots.size > MAX_PENDING_PERSIST_SNAPSHOTS) {
		const oldest = __kustoPendingPersistSnapshots.keys().next().value;
		if (typeof oldest !== 'string') break;
		__kustoPendingPersistSnapshots.delete(oldest);
	}
}

function preparePersistRevision(signature: string): number {
	if (signature !== __kustoLastSentPersistSignature
		|| __kustoLastSentPersistRevision !== pState.documentEditRevision) {
		pState.documentEditRevision += 1;
		__kustoLastSentPersistSignature = signature;
		__kustoLastSentPersistRevision = pState.documentEditRevision;
	}
	return pState.documentEditRevision;
}

export function adoptCurrentStateAsCleanForTest(): void {
	__kustoSeedPersistSignatureFromCurrentState();
}

export function suppressPersistenceForTest(suppressed = true): void {
	__kustoPersistenceSuppressedForTest = suppressed;
	if (suppressed && __kustoPersistTimer) {
		clearTimeout(__kustoPersistTimer);
		__kustoPersistTimer = null;
	}
}

export function isPersistenceSuppressedForTest(): boolean {
	return __kustoPersistenceSuppressedForTest;
}

export function schedulePersist(reason?: any, immediate?: any) {
	if (!__kustoPersistenceEnabled || __kustoPersistenceSuppressedForTest || pState.restoreInProgress) {
		return;
	}
	try {
		const r = (typeof reason === 'string' && reason) ? reason : '';
		const tracksEditRevision = pState.documentKind === 'kql' || pState.documentKind === 'sql';
		if (__kustoPersistTimer) {
			clearTimeout(__kustoPersistTimer);
			__kustoPersistTimer = null;
		}
		if (tracksEditRevision) {
			const state = getKqlxState();
			const sig = __kustoGetPersistSignature(state);
			if (sig && sig === __kustoLastPersistSignature
				&& __kustoLastPersistRevision === pState.documentEditRevision) {
				return;
			}
			const editRevision = preparePersistRevision(sig);
			if (r !== 'kusto-leave-no-trace-policy' && r !== 'kusto-leave-no-trace-restore') __kustoPersistenceEpoch++;
			const snapshotId = `compat-snapshot-${Date.now()}-${++__kustoPersistSnapshotSequence}`;
			trackPendingPersistSnapshot(snapshotId, sig, editRevision);
			postMessageToHost({
				type: 'persistDocument', state, reason: r,
				editRevision, snapshotId,
			});
			return;
		}
		const doPersist = () => {
			try {
				const state = getKqlxState();
				const sig = __kustoGetPersistSignature(state);
				if (sig && sig === __kustoLastPersistSignature) {
					return;
				}

				// In compatibility mode (.kql/.csl/.md without companion file), the only
				// thing we persist to disk is the section text itself. Cluster/database
				// selection changes should NOT mark the document dirty because there is
				// nowhere to save that metadata. Skip the persist if only metadata changed.
				if (pState.compatibilityMode) {
					try {
						let compatQueryText = '';
						const sections = (state && Array.isArray(state.sections)) ? state.sections : [];
						const singleKind = String(pState.compatibilitySingleKind || 'query');
						let firstQ = null;
						for (let si = 0; si < sections.length; si++) {
							if (sections[si] && String(sections[si].type || '') === singleKind) {
								firstQ = sections[si];
								break;
							}
						}
						if (singleKind === 'markdown') {
							if (firstQ && typeof firstQ.text === 'string') {
								compatQueryText = firstQ.text;
							}
						} else {
							if (firstQ && typeof firstQ.query === 'string') {
								compatQueryText = firstQ.query;
							}
						}
						if (compatQueryText === __kustoLastCompatQueryText) {
							// Only metadata changed (cluster, database, etc.) — skip persist.
							// Still update the full signature so it stays in sync.
							if (sig) { __kustoLastPersistSignature = sig; }
							return;
						}
						__kustoLastCompatQueryText = compatQueryText;
					} catch (e) { console.error('[kusto]', e); }
				}

				if (sig) {
					__kustoLastPersistSignature = sig;
				}
				if (r !== 'kusto-leave-no-trace-policy' && r !== 'kusto-leave-no-trace-restore') __kustoPersistenceEpoch++;
				postMessageToHost({ type: 'persistDocument', state, reason: r, editRevision: pState.documentEditRevision });
			} catch (e) { console.error('[kusto]', e); }
		};
		if (immediate) {
			// Immediate persist - no debounce
			doPersist();
		} else {
			__kustoPersistTimer = setTimeout(doPersist, 400);
		}
	} catch (e) { console.error('[kusto]', e); }
}

export function flushCompatibilityPersist(requestId?: string, reason = 'flush'): void {
	try {
		if (!__kustoPersistenceEnabled || pState.restoreInProgress) {
			if (requestId) {
				postMessageToHost({
					type: 'persistDocument', state: { sections: [] }, flushRequestId: requestId,
					flushUnavailableReason: pState.restoreInProgress ? 'restore-in-progress' : 'persistence-disabled',
				});
			}
			return;
		}
		if (__kustoPersistTimer) {
			clearTimeout(__kustoPersistTimer);
			__kustoPersistTimer = null;
		}
		const state = getKqlxState();
		if (pState.documentKind !== 'kql' && pState.documentKind !== 'sql') {
			__kustoPersistenceEpoch++;
			postMessageToHost({
				type: 'persistDocument', state,
				...(requestId ? { flushRequestId: requestId } : {}),
			});
			return;
		}
		if (__kustoPersistenceSuppressedForTest) {
			__kustoPersistenceEpoch++;
			const snapshotId = `compat-snapshot-${Date.now()}-${++__kustoPersistSnapshotSequence}`;
			const sig = __kustoGetPersistSignature(state);
			trackPendingPersistSnapshot(snapshotId, sig, pState.documentEditRevision);
			postMessageToHost({
				type: 'persistDocument', state, flush: true, reason,
				editRevision: pState.documentEditRevision, snapshotId,
				...(requestId ? { flushRequestId: requestId } : {}),
				testOnlyNoop: true,
			});
			return;
		}
		const sig = __kustoGetPersistSignature(state);
		const editRevision = preparePersistRevision(sig);
		__kustoPersistenceEpoch++;
		const snapshotId = `compat-snapshot-${Date.now()}-${++__kustoPersistSnapshotSequence}`;
		trackPendingPersistSnapshot(snapshotId, sig, editRevision);
		postMessageToHost({
			type: 'persistDocument', state, flush: true, reason,
			editRevision, snapshotId,
			...(requestId ? { flushRequestId: requestId } : {}),
		});
	} catch (e) { console.error('[kusto]', e); }
}

export function acknowledgePersistDocument(snapshotId: unknown, editRevision: unknown): void {
	const id = String(snapshotId || '').trim();
	if (!id) return;
	const pending = __kustoPendingPersistSnapshots.get(id);
	if (!pending) return;
	const revision = Number(editRevision);
	if (!Number.isSafeInteger(revision) || revision !== pending.revision) return;
	__kustoPendingPersistSnapshots.delete(id);
	if (revision < __kustoLastPersistRevision) return;
	__kustoLastPersistSignature = pending.signature;
	__kustoLastPersistRevision = revision;
	for (const [pendingId, snapshot] of __kustoPendingPersistSnapshots) {
		if (snapshot.revision <= revision) __kustoPendingPersistSnapshots.delete(pendingId);
	}
}

// Best-effort flush: when the user closes the editor, try to persist the latest state immediately.
// (The extension decides whether to actually auto-save to disk; for session.kqlx it does.)
try {
	window.addEventListener('beforeunload', () => {
		try {
			__kustoCancelHtmlPowerBiCompatibilityCheck();
			if (!__kustoPersistenceEnabled || __kustoPersistenceSuppressedForTest || pState.restoreInProgress) {
				return;
			}
			if (pState.documentKind === 'kql' || pState.documentKind === 'sql') {
				flushCompatibilityPersist(undefined, 'beforeunload');
				return;
			}
			if (!pState.isSessionFile) {
				return;
			}
			const state = getKqlxState();
			const sig = __kustoGetPersistSignature(state);
			if (sig && sig === __kustoLastPersistSignature) {
				return;
			}
			if (sig) {
				__kustoLastPersistSignature = sig;
			}
			__kustoPersistenceEpoch++;
			postMessageToHost({ type: 'persistDocument', state, flush: true, reason: 'flush', editRevision: pState.documentEditRevision });
		} catch (e) { console.error('[kusto]', e); }
	});
} catch (e) { console.error('[kusto]', e); }

function __kustoClearAllSections() {
	try {
		for (const id of (queryBoxes || []).slice()) {
			try { removeQueryBox(id); } catch (e) { console.error('[kusto]', e); }
		}
	} catch (e) { console.error('[kusto]', e); }
	try {
		for (const id of (chartBoxes || []).slice()) {
			try { removeChartBox(id); } catch (e) { console.error('[kusto]', e); }
		}
	} catch (e) { console.error('[kusto]', e); }
	try {
		for (const id of (transformationBoxes || []).slice()) {
			try { removeTransformationBox(id); } catch (e) { console.error('[kusto]', e); }
		}
	} catch (e) { console.error('[kusto]', e); }
	try {
		for (const id of (markdownBoxes || []).slice()) {
			try { removeMarkdownBox(id); } catch (e) { console.error('[kusto]', e); }
		}
	} catch (e) { console.error('[kusto]', e); }
	try {
		for (const id of (pythonBoxes || []).slice()) {
			try { removePythonBox(id); } catch (e) { console.error('[kusto]', e); }
		}
	} catch (e) { console.error('[kusto]', e); }
	try {
		for (const id of (urlBoxes || []).slice()) {
			try { removeUrlBox(id); } catch (e) { console.error('[kusto]', e); }
		}
	} catch (e) { console.error('[kusto]', e); }
	try {
		for (const id of (htmlBoxes || []).slice()) {
			try { removeHtmlBox(id); } catch (e) { console.error('[kusto]', e); }
		}
	} catch (e) { console.error('[kusto]', e); }
	try {
		for (const id of (sqlBoxes || []).slice()) {
			try { removeSqlBox(id); } catch (e) { console.error('[kusto]', e); }
		}
	} catch (e) { console.error('[kusto]', e); }
	// Clear passthrough dev notes sections
	try { pState.devNotesSections = []; } catch (e) { console.error('[kusto]', e); }
}

function applyKqlxState(state: any) {
	perfMark('webview.persistence.applyState.start');
	pState.restoreInProgress = true;
	try {
		__kustoSchemaPrewarmSentKeys.clear();
		__kustoStartRestoreResultBatch();
		__kustoPersistenceEnabled = false;

		// Reset persisted results when loading a new document.
		try {
			pState.queryResultJsonByBoxId = {};
			pState.resultArtifactByBoxId = {};
			pState.kustoResultOwnerByBoxId = {};
			__kustoResetStoredResultSignatures();
		} catch (e) { console.error('[kusto]', e); }

		__kustoClearAllSections();

		const s = state && typeof state === 'object' ? state : { sections: [] };
		__kustoLegacyDocumentPreferences = {
			...(typeof s.caretDocsEnabled === 'boolean' ? { caretDocsEnabled: s.caretDocsEnabled } : {}),
			...(typeof s.autoTriggerAutocompleteEnabled === 'boolean'
				? { autoTriggerAutocompleteEnabled: s.autoTriggerAutocompleteEnabled }
				: {}),
		};

		// Respect a global user preference (persisted in extension globalState) once it exists.
		// Only fall back to document state if the user has never explicitly toggled the feature.
		const userSet = (() => {
			try {
				return !!_win.__kustoCaretDocsEnabledUserSet;
			} catch {
				return false;
			}
		})();
		if (!userSet && typeof s.caretDocsEnabled === 'boolean') {
			setCaretDocsEnabled(!!s.caretDocsEnabled);
			try { updateCaretDocsToggleButtons(); } catch (e) { console.error('[kusto]', e); }
		}

		const autoUserSet = (() => {
			try {
				return !!_win.__kustoAutoTriggerAutocompleteEnabledUserSet;
			} catch {
				return false;
			}
		})();
		if (!autoUserSet && typeof s.autoTriggerAutocompleteEnabled === 'boolean') {
			setAutoTriggerAutocompleteEnabled(!!s.autoTriggerAutocompleteEnabled);
			try { updateAutoTriggerAutocompleteToggleButtons(); } catch (e) { console.error('[kusto]', e); }
		}

		// Compatibility mode (single-section plain text files): force exactly one editor and ignore all other sections.
		if (pState.compatibilityMode) {
			const singleKind = String(pState.compatibilitySingleKind || 'query');
			let singleText = '';
			let suggestedClusterUrl = '';
			let suggestedAuthorityId = '';
			let suggestedConnectionIdHint = '';
			let suggestedDatabase = '';
			try {
				const sections = Array.isArray(s.sections) ? s.sections : [];
				const first = sections.find((sec: any) => sec && String(sec.type || '') === singleKind);
				if (singleKind === 'markdown') {
					singleText = first ? String(first.text || '') : '';
				} else {
					singleText = first ? String(first.query || '') : '';
					// Optional: extension host can provide a best-effort suggested selection for .kql/.csl.
					try {
						suggestedClusterUrl = first ? String(first.clusterUrl || '') : '';
						suggestedAuthorityId = first ? String(first.authorityId || '') : '';
						suggestedConnectionIdHint = first ? String(first.connectionIdHint || '') : '';
						suggestedDatabase = first ? String(first.database || '') : '';
					} catch (e) { console.error('[kusto]', e); }
				}
			} catch (e) { console.error('[kusto]', e); }
			if (singleKind === 'markdown') {
				// IMPORTANT: pass text via options so addMarkdownBox can stash it before
				// initializing the TOAST UI editor (which triggers an immediate schedulePersist).
				const isPlainMd = String(pState.documentKind || '') === 'md';
				// Initialize the compat text tracker so the first schedulePersist
				// after restore recognizes the baseline and only sends persistDocument
				// when the user actually edits the text (not just unrelated metadata).
				try { __kustoLastCompatQueryText = singleText; } catch (e) { console.error('[kusto]', e); }
				addMarkdownBox({ text: singleText, mdAutoExpand: isPlainMd });
				return;
			}
			if (singleKind === 'sql') {
				const sqlBoxId = 'sql_' + Date.now();
				try {
					pState.pendingSqlQueryByBoxId = pState.pendingSqlQueryByBoxId || {};
					pState.pendingSqlQueryByBoxId[sqlBoxId] = singleText;
				} catch (e) { console.error('[kusto]', e); }
				try { __kustoLastCompatQueryText = singleText; } catch (e) { console.error('[kusto]', e); }
				addSqlBox({ id: sqlBoxId });
				return;
			}
			const desiredClusterUrl = String(suggestedClusterUrl || '').trim();
			const db = String(suggestedDatabase || '').trim();
			const hasExplicitSelection = !!(desiredClusterUrl || db);
			const boxId = addQueryBox(hasExplicitSelection ? {
				clusterUrl: desiredClusterUrl,
				database: db,
			} : { schemaDiagnosticsTrusted: false });
			// Apply optional suggested cluster/db selection for compatibility-mode query docs.
			try {
				const kwEl = __kustoGetQuerySectionElement(boxId);
				if (kwEl) {
					if (desiredClusterUrl && typeof kwEl.setDesiredClusterUrl === 'function') {
						kwEl.setDesiredClusterUrl(desiredClusterUrl);
					}
					if (typeof kwEl.setDesiredConnectionIdentity === 'function') {
						kwEl.setDesiredConnectionIdentity(suggestedAuthorityId, suggestedConnectionIdHint);
					}
					if (db && typeof kwEl.setDesiredDatabase === 'function') {
						kwEl.setDesiredDatabase(db);
					}
				}
				// If this suggested selection exists in favorites, switch to Favorites mode by default.
				try {
					if (desiredClusterUrl && db) {
						__kustoSetAutoEnterFavoritesForBox(boxId, desiredClusterUrl, db);
					}
				} catch (e) { console.error('[kusto]', e); }
				// Ensure dropdowns see the desired selection once connections/favorites are available.
				try { updateConnectionSelects(); } catch (e) { console.error('[kusto]', e); }
				try {
					__kustoTryAutoEnterFavoritesModeForAllBoxes();
				} catch (e) { console.error('[kusto]', e); }
			} catch (e) { console.error('[kusto]', e); }
			try {
				pState.pendingQueryTextByBoxId[boxId] = singleText;
			} catch (e) { console.error('[kusto]', e); }
			// Initialize the compat query text tracker so the first schedulePersist
			// after restore recognizes the baseline and only sends persistDocument
			// when the user actually edits the query text (not just cluster/database).
			try { __kustoLastCompatQueryText = singleText; } catch (e) { console.error('[kusto]', e); }
			return;
		}

		const sections = Array.isArray(s.sections) ? s.sections : [];
		const resolveConnectionId = (clusterUrl: any, authorityId: any, connectionIdHint: any) => {
			try {
				const resolution = resolveKustoConnection(connections || [], { clusterUrl, authorityId, connectionIdHint });
				return resolution.kind === 'matched' ? String(resolution.connection.id || '') : '';
			} catch (e) { console.error('[kusto]', e); }
			return '';
		};
		for (const section of sections) {
			const t = section && section.type ? String(section.type) : '';
			if (t === 'devnotes') {
				// Dev notes are hidden — store as passthrough, no DOM element
				try {
					pState.devNotesSections = pState.devNotesSections || [];
					pState.devNotesSections.push(section);
				} catch (e) { console.error('[kusto]', e); }
				continue;
			}
			if (t === 'query' || t === 'copilotQuery') {
				const isLegacyCopilotQuerySection = t === 'copilotQuery';
				const comparisonSourceBoxId = String(section.comparisonSourceBoxId || '').trim();
				const comparisonSource = comparisonSourceBoxId ? sections.find((candidate: any) =>
					String(candidate?.id || '').trim() === comparisonSourceBoxId
				) : undefined;
				const comparisonSourceExists = !!comparisonSource;
				if (comparisonSourceBoxId && !comparisonSourceExists) {
					delete optimizationMetadataByBoxId[String(section.id || '')];
					continue;
				}
				const kustoComparisonSource = comparisonSourceExists && String(comparisonSource?.type || '') !== 'sql'
					? comparisonSource
					: undefined;
				const hasExplicitComparisonOwner = !!String(section.clusterUrl || section.authorityId || section.connectionIdHint || section.database || '').trim();
				const comparisonOwnerMatchesSource = !kustoComparisonSource || !hasExplicitComparisonOwner || (
					kustoClusterKey(String(section.clusterUrl || '')) === kustoClusterKey(String(kustoComparisonSource.clusterUrl || ''))
					&& String(section.authorityId || '').trim().toLowerCase() === String(kustoComparisonSource.authorityId || '').trim().toLowerCase()
					&& String(section.connectionIdHint || '').trim() === String(kustoComparisonSource.connectionIdHint || '').trim()
					&& String(section.database || '').trim().toLowerCase() === String(kustoComparisonSource.database || '').trim().toLowerCase()
				);
				const boxId = addQueryBox({
					id: (section.id ? String(section.id) : undefined),
					...(comparisonSourceBoxId ? { isComparison: true, comparisonSourceBoxId } : {}),
					expanded: (typeof section.expanded === 'boolean') ? !!section.expanded : true,
					clusterUrl: String(section.clusterUrl || ''),
					authorityId: String(section.authorityId || ''),
					connectionIdHint: String(section.connectionIdHint || ''),
					database: String(section.database || '')
				});
				if (comparisonSourceExists) {
					optimizationMetadataByBoxId[boxId] = { sourceBoxId: comparisonSourceBoxId, isComparison: true };
					optimizationMetadataByBoxId[comparisonSourceBoxId] = {
						...(optimizationMetadataByBoxId[comparisonSourceBoxId] || {}),
						comparisonBoxId: boxId,
					};
				}
				try {
					__kustoSetSectionName(boxId, String(section.name || ''));
				} catch (e) { console.error('[kusto]', e); }
				try {
					const desiredClusterUrl = String(section.clusterUrl || '');
					const desiredAuthorityId = String(section.authorityId || '');
					const connectionIdHint = String(section.connectionIdHint || '');
					const resolvedConnectionId = desiredClusterUrl ? resolveConnectionId(desiredClusterUrl, desiredAuthorityId, connectionIdHint) : '';
					const db = String(section.database || '');
					const kwEl = __kustoGetQuerySectionElement(boxId);
					// If this saved selection exists in favorites, switch to Favorites mode by default.
					try {
						if (desiredClusterUrl && db) {
							__kustoSetAutoEnterFavoritesForBox(boxId, desiredClusterUrl, db);
						}
					} catch (e) { console.error('[kusto]', e); }
					if (kwEl) {
						if (typeof kwEl.setPersistConnectionSelection === 'function') {
							kwEl.setPersistConnectionSelection(!!(desiredClusterUrl || db));
						}
						if (db && typeof kwEl.setDesiredDatabase === 'function') {
							kwEl.setDesiredDatabase(db);
						}
						if (desiredClusterUrl && typeof kwEl.setDesiredClusterUrl === 'function') {
							kwEl.setDesiredClusterUrl(desiredClusterUrl);
						}
						if (typeof kwEl.setDesiredConnectionIdentity === 'function') {
							kwEl.setDesiredConnectionIdentity(desiredAuthorityId, connectionIdHint);
						}
						if (resolvedConnectionId && typeof kwEl.setConnectionId === 'function') {
							kwEl.setConnectionId(resolvedConnectionId);
							// Trigger database field load for this connection.
							try {
								kwEl.dispatchEvent(new CustomEvent('connection-changed', {
									detail: { boxId: boxId, connectionId: resolvedConnectionId, clusterUrl: desiredClusterUrl },
									bubbles: true, composed: true,
								}));
							} catch (e) { console.error('[kusto]', e); }
						} else {
							// Try again after connections are populated.
							try { updateConnectionSelects(); } catch (e) { console.error('[kusto]', e); }
						}
					}
					try {
						__kustoTryAutoEnterFavoritesModeForAllBoxes();
					} catch (e) { console.error('[kusto]', e); }
				} catch (e) { console.error('[kusto]', e); }
				// Restore explicit favorites-mode UI state (if present). This is important for
				// upgrade/reload flows where boxes are recreated and would otherwise default back
				// to cluster/database pickers.
				try {
					if (typeof section.favoritesMode === 'boolean') {
						if (typeof (_win.__kustoSetFavoritesModeForBox) === 'function') {
							_win.__kustoSetFavoritesModeForBox(boxId, !!section.favoritesMode);
						}
					}
				} catch (e) { console.error('[kusto]', e); }
				// Monaco editor may not exist yet; store pending text for initQueryEditor.
				try {
					pState.pendingQueryTextByBoxId[boxId] = String(section.query || '');
				} catch (e) { console.error('[kusto]', e); }
				// Restore per-query results visibility BEFORE displaying results,
				// so displayResult sees the hidden state when creating kw-data-table.
				try {
					if (typeof section.resultsVisible === 'boolean') {
						pState.resultsVisibleByBoxId[boxId] = !!section.resultsVisible;
					}
				} catch (e) { console.error('[kusto]', e); }
				// Restore last result (if present + parseable).
				try {
					const sqlComparisonSource = String(comparisonSource?.type || '') === 'sql';
					const sourceSqlElement = sqlComparisonSource ? __kustoGetSqlSectionElement(comparisonSourceBoxId) : null;
					const sourceOwnerResolved = !sqlComparisonSource
						|| (__kustoIsReadOnlyBrowserViewer()
							? comparisonSourceExists
							: __kustoSqlOwnerMatchesPersisted(sourceSqlElement, comparisonSource));
					const rj = comparisonSourceBoxId && (!comparisonSourceExists || !sourceOwnerResolved || !comparisonOwnerMatchesSource)
						? ''
						: (section.resultJson ? String(section.resultJson) : '');
					if (sqlComparisonSource && !sourceOwnerResolved && section.resultJson) {
						__kustoQueuePendingSqlOwnedRestore({
							kind: 'query', boxId, resultJson: String(section.resultJson), resultsHeightPx: section.resultsHeightPx,
							resultArtifact: section.resultArtifact,
							expectedQueryText: String(section.query || ''),
							expectedResultDatabase: String(comparisonSource.database || ''),
							sqlOwnerSourceBoxId: comparisonSourceBoxId,
							derivedSourceBoxId: comparisonSourceBoxId,
							persistedOwner: {
								connectionIdHint: comparisonSource.connectionIdHint,
								targetSignature: comparisonSource.targetSignature,
								principalFingerprint: comparisonSource.principalFingerprint,
								revocationGeneration: comparisonSource.revocationGeneration,
								sourceBoxId: comparisonSourceBoxId,
							},
						});
					}
					if (rj) {
						if (sqlComparisonSource) __kustoSetStoredQueryResultJson(boxId, rj);
						__kustoQueueRestoredResult({
							kind: 'query', boxId, resultJson: rj, resultsHeightPx: section.resultsHeightPx,
							resultArtifact: section.resultArtifact,
							...(sqlComparisonSource ? { sqlOwnerConnectionId: String(comparisonSource.connectionIdHint || '').trim() } : {}),
							...(comparisonSourceBoxId ? { derivedSourceBoxId: comparisonSourceBoxId } : {}),
							...(sqlComparisonSource ? {
								expectedQueryText: String(section.query || ''),
								expectedResultDatabase: String(comparisonSource.database || ''),
								sqlOwnerSourceBoxId: comparisonSourceBoxId,
							} : {}),
							...(!sqlComparisonSource ? {
								kustoClusterUrl: String((kustoComparisonSource || section).clusterUrl || ''),
								kustoAuthorityId: String((kustoComparisonSource || section).authorityId || ''),
								kustoConnectionIdHint: String((kustoComparisonSource || section).connectionIdHint || ''),
								kustoDatabase: String((kustoComparisonSource || section).database || ''),
								expectedQueryText: String(section.query || ''),
								kustoAccountPartition: String(section.kustoAccountPartition || ''),
								kustoLeaveNoTraceRevision: Number(section.kustoLeaveNoTraceRevision),
							} : {}),
						});
					}
				} catch (e) { console.error('[kusto]', e); }
				try {
					setRunMode(boxId, String(section.runMode || 'take100'));
				} catch (e) { console.error('[kusto]', e); }
				try {
					const ce = document.getElementById(boxId + '_cache_enabled');
					const cv = document.getElementById(boxId + '_cache_value');
					const cu = document.getElementById(boxId + '_cache_unit');
					if (ce) (ce as any).checked = (section.cacheEnabled !== false);
					if (cv) (cv as any).value = String(section.cacheValue || 1);
					if (cu) (cu as any).value = String(section.cacheUnit || 'days');
					try { toggleCacheControls(boxId); } catch (e) { console.error('[kusto]', e); }
				} catch (e) { console.error('[kusto]', e); }
				// Apply results visibility UI (toggle button + legacy results wrapper).
				try {
					if (typeof section.resultsVisible === 'boolean') {
						try { __kustoUpdateQueryResultsToggleButton(boxId); } catch (e) { console.error('[kusto]', e); }
						try { __kustoApplyResultsVisibility(boxId); } catch (e) { console.error('[kusto]', e); }
					}
				} catch (e) { console.error('[kusto]', e); }
				// Copilot chat always starts closed — visibility is not restored from persisted state.
				try {
					if (typeof section.copilotChatWidthPx === 'number') {
						const kwEl = __kustoGetQuerySectionElement(boxId);
						if (kwEl && typeof kwEl.setCopilotChatWidthPx === 'function') {
							kwEl.setCopilotChatWidthPx(section.copilotChatWidthPx);
						}
					}
				} catch (e) { console.error('[kusto]', e); }
				// Monaco editor may initialize after restore; remember desired wrapper height for initQueryEditor.
				try {
					if (typeof section.editorHeightPx === 'number' && Number.isFinite(section.editorHeightPx) && section.editorHeightPx > 0) {
						pState.pendingWrapperHeightPxByBoxId[boxId] = section.editorHeightPx;
					}
				} catch (e) { console.error('[kusto]', e); }
				// Apply persisted heights after any Copilot chat installation/reparenting.
				try { __kustoSetWrapperHeightPx(boxId, '_query_editor', section.editorHeightPx); } catch (e) { console.error('[kusto]', e); }
				try { __kustoSetQueryResultsOutputHeightPx(boxId, section.resultsHeightPx); } catch (e) { console.error('[kusto]', e); }
				// Re-apply on next tick to avoid any late layout/resize observers overriding restored sizes.
				try {
					setTimeout(() => {
						try { __kustoSetWrapperHeightPx(boxId, '_query_editor', section.editorHeightPx); } catch (e) { console.error('[kusto]', e); }
						try { __kustoSetQueryResultsOutputHeightPx(boxId, section.resultsHeightPx); } catch (e) { console.error('[kusto]', e); }
						try {
const editor = (queryEditors && queryEditors[boxId]) ? queryEditors[boxId] : null;
							if (editor && typeof editor.layout === 'function') {
								editor.layout();
							}
						} catch (e) { console.error('[kusto]', e); }
					}, 0);
				} catch (e) { console.error('[kusto]', e); }
				continue;
			}

			if (t === 'chart') {
				const boxId = addChartBox({
					id: (section.id ? String(section.id) : undefined),
					name: String(section.name || ''),
					mode: (typeof section.mode === 'string') ? String(section.mode) : 'edit',
					expanded: (typeof section.expanded === 'boolean') ? !!section.expanded : true,
					editorHeightPx: (typeof section.editorHeightPx === 'number') ? section.editorHeightPx : undefined,
					dataSourceId: (typeof section.dataSourceId === 'string') ? section.dataSourceId : undefined,
					chartType: (typeof section.chartType === 'string') ? section.chartType : undefined,
					xColumn: (typeof section.xColumn === 'string') ? section.xColumn : undefined,
					yColumns: (Array.isArray(section.yColumns) ? section.yColumns : undefined),
					tooltipColumns: (Array.isArray(section.tooltipColumns) ? section.tooltipColumns : undefined),
					yColumn: (typeof section.yColumn === 'string') ? section.yColumn : undefined,
					legendColumn: (typeof section.legendColumn === 'string') ? section.legendColumn : undefined,
					legendPosition: (typeof section.legendPosition === 'string') ? section.legendPosition : undefined,
					stackMode: (typeof section.stackMode === 'string') ? section.stackMode : undefined,
					labelColumn: (typeof section.labelColumn === 'string') ? section.labelColumn : undefined,
					valueColumn: (typeof section.valueColumn === 'string') ? section.valueColumn : undefined,
					sourceColumn: (typeof section.sourceColumn === 'string') ? section.sourceColumn : undefined,
					targetColumn: (typeof section.targetColumn === 'string') ? section.targetColumn : undefined,
					orient: (typeof section.orient === 'string') ? section.orient : undefined,
					showDataLabels: (typeof section.showDataLabels === 'boolean') ? section.showDataLabels : false,
					labelMode: (typeof section.labelMode === 'string') ? section.labelMode : undefined,
					labelDensity: (typeof section.labelDensity === 'number') ? section.labelDensity : undefined,
					sortColumn: (typeof section.sortColumn === 'string') ? section.sortColumn : undefined,
					sortDirection: (typeof section.sortDirection === 'string') ? section.sortDirection : undefined,
					chartTitle: (typeof section.chartTitle === 'string') ? section.chartTitle : undefined,
					chartSubtitle: (typeof section.chartSubtitle === 'string') ? section.chartSubtitle : undefined,
					chartTitleAlign: (typeof section.chartTitleAlign === 'string') ? section.chartTitleAlign : undefined,
					xAxisSettings: (section.xAxisSettings && typeof section.xAxisSettings === 'object') ? section.xAxisSettings : undefined,
					yAxisSettings: (section.yAxisSettings && typeof section.yAxisSettings === 'object') ? section.yAxisSettings : undefined,
					legendSettings: (section.legendSettings && typeof section.legendSettings === 'object') ? section.legendSettings : undefined
				});
				try {
					// Ensure buttons/UI reflect persisted state.
					if (typeof _win.__kustoApplyChartMode === 'function') {
						_win.__kustoApplyChartMode(boxId);
					}
					if (typeof _win.__kustoApplyChartBoxVisibility === 'function') {
						_win.__kustoApplyChartBoxVisibility(boxId);
					}
				} catch (e) { console.error('[kusto]', e); }
				continue;
			}

			if (t === 'transformation') {
				let deriveColumns = undefined;
				try {
					if (Array.isArray(section.deriveColumns)) {
						deriveColumns = section.deriveColumns
							.filter((c: any) => c && typeof c === 'object')
							.map((c: any) => ({
								name: (typeof c.name === 'string') ? c.name : String((c.name ?? '') || ''),
								expression: (typeof c.expression === 'string') ? c.expression : String((c.expression ?? '') || '')
							}));
					} else {
						// Back-compat: migrate single-field derive into array.
						const legacyName = (typeof section.deriveColumnName === 'string') ? section.deriveColumnName : '';
						const legacyExpr = (typeof section.deriveExpression === 'string') ? section.deriveExpression : '';
						if (legacyName || legacyExpr) {
							deriveColumns = [{ name: legacyName || 'derived', expression: legacyExpr || '' }];
						}
					}
				} catch (e) { console.error('[kusto]', e); }
				let aggregations;
				try {
					if (Array.isArray(section.aggregations)) {
						aggregations = section.aggregations
							.filter((a: any) => a && typeof a === 'object')
							.map((a: any) => ({
								name: (typeof a.name === 'string') ? a.name : String((a.name ?? '') || ''),
								function: (typeof a.function === 'string') ? a.function : String((a.function ?? '') || ''),
								column: (typeof a.column === 'string') ? a.column : String((a.column ?? '') || '')
							}));
					}
				} catch (e) { console.error('[kusto]', e); }
				const boxId = addTransformationBox({
					id: (section.id ? String(section.id) : undefined),
					name: String(section.name || ''),
					mode: (typeof section.mode === 'string') ? String(section.mode) : 'edit',
					expanded: (typeof section.expanded === 'boolean') ? !!section.expanded : true,
					editorHeightPx: (typeof section.editorHeightPx === 'number') ? section.editorHeightPx : undefined,
					dataSourceId: (typeof section.dataSourceId === 'string') ? section.dataSourceId : undefined,
					transformationType: (typeof section.transformationType === 'string') ? section.transformationType : undefined,
					distinctColumn: (typeof section.distinctColumn === 'string') ? section.distinctColumn : undefined,
					deriveColumns,
					groupByColumns: (Array.isArray(section.groupByColumns) ? section.groupByColumns : undefined),
					aggregations: aggregations,
					pivotRowKeyColumn: (typeof section.pivotRowKeyColumn === 'string') ? section.pivotRowKeyColumn : undefined,
					pivotColumnKeyColumn: (typeof section.pivotColumnKeyColumn === 'string') ? section.pivotColumnKeyColumn : undefined,
					pivotValueColumn: (typeof section.pivotValueColumn === 'string') ? section.pivotValueColumn : undefined,
					pivotAggregation: (typeof section.pivotAggregation === 'string') ? section.pivotAggregation : undefined,
					pivotMaxColumns: (typeof section.pivotMaxColumns === 'number') ? section.pivotMaxColumns : undefined,
					joinRightDataSourceId: (typeof section.joinRightDataSourceId === 'string') ? section.joinRightDataSourceId : undefined,
					joinKind: (typeof section.joinKind === 'string') ? section.joinKind : undefined,
					joinKeys: Array.isArray(section.joinKeys)
						? section.joinKeys
							.filter((k: any) => k && typeof k === 'object')
							.map((k: any) => ({ left: String(k.left || ''), right: String(k.right || '') }))
						: undefined,
					joinOmitDuplicateColumns: (typeof section.joinOmitDuplicateColumns === 'boolean') ? section.joinOmitDuplicateColumns : undefined,
				});
				continue;
			}

			if (t === 'markdown') {
				let mode = '';
				try {
					const m = String(section.mode || '').toLowerCase();
					if (m === 'preview' || m === 'markdown' || m === 'wysiwyg') {
						mode = m;
					}
				} catch (e) { console.error('[kusto]', e); }
				// Back-compat: if this .kqlx uses the older `tab` field, treat preview tab as Preview mode.
				if (!mode) {
					try {
						const tab = String(section.tab || '').toLowerCase();
						if (tab === 'preview') {
							mode = 'preview';
						}
					} catch (e) { console.error('[kusto]', e); }
				}
				const boxId = addMarkdownBox({
					id: (section.id ? String(section.id) : undefined),
					text: String(section.text || ''),
					editorHeightPx: section.editorHeightPx,
					...(mode ? { mode } : {})
				});
				// Apply title and expanded state on the Lit element.
				try {
					const el = document.getElementById(boxId);
					if (el && typeof (el as any).setTitle === 'function') {
						(el as any).setTitle(String(section.title || ''));
						(el as any).setExpanded(section.expanded !== false);
					}
				} catch (e) { console.error('[kusto]', e); }
				continue;
			}

			if (t === 'python') {
				// Store pending code so the Lit component can pick it up during Monaco init.
				const pendingId = section.id ? String(section.id) : ('python_' + Date.now());
				try {
					pState.pendingPythonCodeByBoxId[pendingId] = String(section.code || '');
				} catch (e) { console.error('[kusto]', e); }
				const boxId = addPythonBox({ id: pendingId });
				// Set output, name, expanded, and height on the Lit element.
				try {
					const el = document.getElementById(boxId);
					if (el && typeof (el as any).setOutput === 'function') {
						(el as any).setOutput(String(section.output || ''));
					}
					if (el && typeof (el as any).setTitle === 'function' && section.name) {
						(el as any).setTitle(String(section.name));
					}
					if (el && typeof (el as any).setExpanded === 'function' && typeof section.expanded === 'boolean') {
						(el as any).setExpanded(section.expanded);
					}
					if (el && section.editorHeightPx) {
						el.setAttribute('editor-height-px', String(section.editorHeightPx));
					}
				} catch (e) { console.error('[kusto]', e); }
				continue;
			}

			if (t === 'url') {
				const boxId = addUrlBox({
					id: (section.id ? String(section.id) : undefined),
					name: String(section.name || ''),
					url: String(section.url || ''),
					expanded: !!section.expanded,
					outputHeightPx: section.outputHeightPx,
					imageSizeMode: section.imageSizeMode,
					imageAlign: section.imageAlign,
					imageOverflow: section.imageOverflow
				});
				// The Lit element handles its own state; just trigger fetch if expanded.
				try {
					const el = document.getElementById(boxId);
					if (el && typeof (el as any).triggerFetch === 'function') {
						(el as any).triggerFetch();
					}
				} catch (e) { console.error('[kusto]', e); }
				continue;
			}

			if (t === 'html') {
				const pendingId = section.id ? String(section.id) : ('html_' + Date.now());
				// Store pending code so the Lit component can pick it up during Monaco init.
				try {
					pState.pendingHtmlCodeByBoxId = pState.pendingHtmlCodeByBoxId || {};
					pState.pendingHtmlCodeByBoxId[pendingId] = String(section.code || '');
				} catch (e) { console.error('[kusto]', e); }
				const htmlOptions: any = {
					id: pendingId,
					name: String(section.name || ''),
					mode: section.mode || 'code',
					expanded: (typeof section.expanded === 'boolean') ? section.expanded : true,
					editorHeightPx: section.editorHeightPx,
					previewHeightPx: section.previewHeightPx,
					dataSourceIds: Array.isArray(section.dataSourceIds) ? section.dataSourceIds : undefined,
					pbiPublishInfo: section.pbiPublishInfo,
					powerBiUpgradeNotice: section.powerBiUpgradeNotice,
				};
				if (section.previewHeightUserSet === true) htmlOptions.previewHeightUserSet = true;
				addHtmlBox(htmlOptions);
				continue;
			}

			if (t === 'sql') {
				const pendingId = section.id ? String(section.id) : ('sql_' + Date.now());
				try {
					pState.pendingSqlQueryByBoxId = pState.pendingSqlQueryByBoxId || {};
					pState.pendingSqlQueryByBoxId[pendingId] = String(section.query || '');
				} catch (e) { console.error('[kusto]', e); }
				// Restore results visibility BEFORE creating the section.
				try {
					if (typeof section.resultsVisible === 'boolean') {
						pState.resultsVisibleByBoxId[pendingId] = !!section.resultsVisible;
					}
				} catch (e) { console.error('[kusto]', e); }
				addSqlBox({
					id: pendingId,
					name: String(section.name || ''),
					serverUrl: section.serverUrl ? String(section.serverUrl) : undefined,
					connectionIdHint: section.connectionIdHint ? String(section.connectionIdHint) : undefined,
					targetSignature: section.targetSignature ? String(section.targetSignature) : undefined,
					database: section.database ? String(section.database) : undefined,
					expanded: (typeof section.expanded === 'boolean') ? section.expanded : true,
					editorHeightPx: section.editorHeightPx,
					copilotChatVisible: section.copilotChatVisible,
					copilotChatWidthPx: section.copilotChatWidthPx,
				});
				const restoredSqlEl = __kustoGetSqlSectionElement(pendingId);
				if (typeof restoredSqlEl?.setLeaveNoTraceConnectionIds === 'function') {
					restoredSqlEl.setLeaveNoTraceConnectionIds(sqlLeaveNoTraceConnectionIds);
				}
				// Restore run mode.
				try {
					setRunMode(pendingId, String(section.runMode || 'top100'));
				} catch (e) { console.error('[kusto]', e); }
				// Restore favorites mode.
				try {
					if (typeof section.favoritesMode === 'boolean') {
						const sqlEl = __kustoGetSqlSectionElement(pendingId);
						if (sqlEl && typeof sqlEl.setFavoritesMode === 'function') {
							sqlEl.setFavoritesMode(!!section.favoritesMode);
						}
						if (typeof sqlFavoritesModeByBoxId === 'object') {
							sqlFavoritesModeByBoxId[pendingId] = !!section.favoritesMode;
						}
					}
				} catch (e) { console.error('[kusto]', e); }
				// Restore persisted query results.
				try {
					const rj = section.resultJson ? String(section.resultJson) : '';
					if (rj && __kustoIsReadOnlyBrowserViewer()) {
						__kustoSetStoredQueryResultJson(pendingId, rj);
						__kustoQueueRestoredResult({
							kind: 'sql', boxId: pendingId, resultJson: rj,
							resultArtifact: section.resultArtifact,
							resultsHeightPx: section.resultsHeightPx,
							expectedQueryText: String(section.query || ''),
							expectedResultDatabase: String(section.database || ''),
							sqlOwnerSourceBoxId: pendingId,
						});
					} else if (rj
						&& __kustoSqlOwnerMatchesPersisted(restoredSqlEl, section)
						&& (typeof restoredSqlEl?.canPersistResults !== 'function' || restoredSqlEl.canPersistResults())) {
						__kustoSetStoredQueryResultJson(pendingId, rj);
						__kustoQueueRestoredResult({
							kind: 'sql',
							boxId: pendingId,
							resultJson: rj,
							resultArtifact: section.resultArtifact,
							resultsHeightPx: section.resultsHeightPx,
							expectedQueryText: String(section.query || ''),
							expectedResultDatabase: String(section.database || ''),
							sqlOwnerSourceBoxId: pendingId,
							sqlOwnerConnectionId: String(section.connectionIdHint || '').trim(),
						});
					} else if (rj && sqlConnections.length === 0) {
						__kustoQueuePendingSqlOwnedRestore({
							kind: 'sql', boxId: pendingId, resultJson: rj, resultsHeightPx: section.resultsHeightPx,
							resultArtifact: section.resultArtifact,
							expectedQueryText: String(section.query || ''),
							expectedResultDatabase: String(section.database || ''),
							sqlOwnerSourceBoxId: pendingId,
							persistedOwner: {
								connectionIdHint: section.connectionIdHint,
								targetSignature: section.targetSignature,
								principalFingerprint: section.principalFingerprint,
								revocationGeneration: section.revocationGeneration,
							},
						});
					}
				} catch (e) { console.error('[kusto]', e); }
				continue;
			}
		}
	} finally {
		pState.restoreInProgress = false;
		__kustoPersistenceEnabled = true;
		// Do not auto-persist immediately after restore: Monaco editors may not be ready yet,
		// and persisting too early can overwrite loaded content with empty strings.
		perfMark('webview.persistence.applyState.end');
	}
}

function __kustoApplyPendingAdds() {
	const pendingAdds = (pState.queryEditorPendingAdds && typeof (pState.queryEditorPendingAdds) === 'object')
		? pState.queryEditorPendingAdds
		: { query: 0, chart: 0, transformation: 0, markdown: 0, python: 0, url: 0 };
	// Reset counts so they don't replay on reload.
	pState.queryEditorPendingAdds = { query: 0, chart: 0, transformation: 0, markdown: 0, python: 0, url: 0 };

	const pendingTotal =
		(pendingAdds.query || 0) +
		(pendingAdds.chart || 0) +
		(pendingAdds.transformation || 0) +
		(pendingAdds.markdown || 0) +
		(pendingAdds.python || 0) +
		(pendingAdds.url || 0);
	if (pendingTotal <= 0) {
		return false;
	}
	const allowed = Array.isArray(pState.allowedSectionKinds)
		? pState.allowedSectionKinds.map((v: any) => String(v))
		: ['query', 'chart', 'transformation', 'python', 'url', 'markdown'];
	if (allowed.includes('query')) {
		for (let i = 0; i < (pendingAdds.query || 0); i++) addQueryBox();
	}
	if (allowed.includes('chart')) {
		for (let i = 0; i < (pendingAdds.chart || 0); i++) addChartBox();
	}
	if (allowed.includes('transformation')) {
		for (let i = 0; i < (pendingAdds.transformation || 0); i++) addTransformationBox();
	}
	if (allowed.includes('markdown')) {
		for (let i = 0; i < (pendingAdds.markdown || 0); i++) addMarkdownBox();
	}
	if (allowed.includes('python')) {
		for (let i = 0; i < (pendingAdds.python || 0); i++) addPythonBox();
	}
	if (allowed.includes('url')) {
		for (let i = 0; i < (pendingAdds.url || 0); i++) addUrlBox();
	}
	return true;
}

function __kustoSetMalformedDocumentLock(error?: unknown): void {
	__kustoPersistenceEnabled = false;
	if (__kustoPersistTimer) {
		clearTimeout(__kustoPersistTimer);
		__kustoPersistTimer = null;
	}
	const container = document.getElementById('queries-container');
	if (container) {
		(container as HTMLElement & { inert?: boolean }).inert = true;
		container.setAttribute('aria-disabled', 'true');
	}
	let banner = document.getElementById('kusto-malformed-document-banner');
	if (!banner) {
		banner = document.createElement('div');
		banner.id = 'kusto-malformed-document-banner';
		banner.setAttribute('role', 'alert');
		banner.style.cssText = 'position:sticky;top:0;z-index:1000;padding:10px 14px;border-bottom:1px solid var(--vscode-inputValidation-errorBorder);background:var(--vscode-inputValidation-errorBackground);color:var(--vscode-inputValidation-errorForeground);';
		document.body.prepend(banner);
	}
	banner.textContent = `This file is malformed. Editing is disabled to prevent data loss. Repair it in the Text Editor, then reload.${error ? ` ${String(error)}` : ''}`;
}

function __kustoClearMalformedDocumentLock(): void {
	document.getElementById('kusto-malformed-document-banner')?.remove();
	const container = document.getElementById('queries-container');
	if (container) {
		(container as HTMLElement & { inert?: boolean }).inert = false;
		container.removeAttribute('aria-disabled');
	}
}

export function handleDocumentDataMessage(message: any) {
	__kustoDocumentDataApplyCount++;
	perfMark('webview.persistence.documentData.handle.start');
	traceFileOpen('persistence.documentData.handle.start', {
		applyCount: __kustoDocumentDataApplyCount,
		forceReload: !!(message && message.forceReload),
		documentUri: typeof message?.documentUri === 'string' ? message.documentUri : '',
	});

	// The extension host should only send documentData in response to requestDocument.
	// If we receive it more than once, re-applying causes noticeable flicker and can leave
	// Monaco editors in a bad interactive state due to teardown/recreate races.
	// So by default, only apply the first documentData payload, unless either:
	// - forceReload is requested, or
	// - the payload is for a different documentUri (preview tab reuse scenario).
	try {
		const incomingDocumentUri = (message && typeof message.documentUri === 'string') ? String(message.documentUri) : '';
		const isDifferentDocument = !!incomingDocumentUri && !!__kustoLastAppliedDocumentUri && incomingDocumentUri !== __kustoLastAppliedDocumentUri;
		if (__kustoHasAppliedDocument && !(message && message.forceReload) && !isDifferentDocument) {
			traceFileOpen('persistence.documentData.skippedAlreadyApplied', { incomingDocumentUri, lastAppliedDocumentUri: __kustoLastAppliedDocumentUri });
			return;
		}
	} catch (e) { console.error('[kusto]', e); }
	window.dispatchEvent(new Event(RESULT_ARTIFACT_CSV_RESET_EVENT));
	__kustoCloseShareModal();
	try { window.closeDiffView?.(); } catch (e) { console.error('[kusto]', e); }
	const ok = !!(message && message.ok);
	if (!ok) {
		__kustoCancelHtmlPowerBiCompatibilityCheck();
		__kustoSetMalformedDocumentLock(message?.error);
		__kustoHasAppliedDocument = true;
		if (typeof message?.documentUri === 'string') __kustoLastAppliedDocumentUri = String(message.documentUri);
		pState.documentDataApplyCount = __kustoDocumentDataApplyCount;
		perfMark('webview.persistence.documentData.handle.end');
		traceFileOpen('persistence.documentData.handle.end', { malformed: true });
		return;
	}
	__kustoClearMalformedDocumentLock();
	__kustoRequestFreshLeaveNoTracePolicy();
	const incomingEditRevision = Number(message?.editRevision);
	if (Number.isSafeInteger(incomingEditRevision) && incomingEditRevision >= 0) {
		pState.documentEditRevision = incomingEditRevision;
	}
	__kustoSetDocumentLoading(true, 'Opening notebook...');
	suppressPersistenceForTest(message?.suppressPersistenceForTest === true);
	__kustoCancelHtmlPowerBiCompatibilityCheck();
	__kustoHasAppliedDocument = true;
	try {
		if (message && typeof message.documentUri === 'string') {
			__kustoLastAppliedDocumentUri = String(message.documentUri);
		}
	} catch (e) { console.error('[kusto]', e); }

	try {
		// Some host-to-webview messages can arrive before the webview registers its message listener.
		// documentData is requested by the webview after initialization, so it is a reliable place
		// to apply compatibility mode for .kql/.csl files.
		try {
		if (typeof message.compatibilityMode === 'boolean') {
			if (typeof __kustoSetCompatibilityMode === 'function') {
				__kustoSetCompatibilityMode(!!message.compatibilityMode);
			} else {
				pState.compatibilityMode = !!message.compatibilityMode;
			}
		}
		} catch (e) { console.error('[kusto]', e); }

		// Capabilities can arrive either via persistenceMode or (for robustness) piggybacked on documentData.
		// This prevents restore issues when messages arrive out-of-order.
		try {
		if (typeof message.documentUri === 'string') {
			pState.documentUri = String(message.documentUri);
		}
		if (Array.isArray(message.allowedSectionKinds)) {
			pState.allowedSectionKinds = message.allowedSectionKinds.map((k: any) => String(k));
		}
		if (typeof message.documentKind === 'string') {
			pState.documentKind = String(message.documentKind);
			try {
				if (document && document.body && document.body.dataset) {
					document.body.dataset.kustoDocumentKind = String(message.documentKind);
				}
			} catch (e) { console.error('[kusto]', e); }
		}
		if (typeof message.defaultSectionKind === 'string') {
			pState.defaultSectionKind = String(message.defaultSectionKind);
		}
		if (typeof message.compatibilitySingleKind === 'string') {
			pState.compatibilitySingleKind = String(message.compatibilitySingleKind);
		}
		if (typeof message.upgradeRequestType === 'string') {
			pState.upgradeRequestType = String(message.upgradeRequestType);
		}
		if (typeof message.compatibilityTooltip === 'string') {
			pState.compatibilityTooltip = String(message.compatibilityTooltip);
		}
		if (typeof message.firstSectionPinned === 'boolean') {
			pState.firstSectionPinned = message.firstSectionPinned;
		}
		if (typeof message.htmlPowerBiCompatibilityCheckEnabled === 'boolean') {
			__kustoSetHtmlPowerBiCompatibilityCheckEnabled(message.htmlPowerBiCompatibilityCheckEnabled);
		}
		try {
			if (typeof __kustoApplyDocumentCapabilities === 'function') {
				__kustoApplyDocumentCapabilities();
			}
		} catch (e) { console.error('[kusto]', e); }
		} catch (e) { console.error('[kusto]', e); }

		perfMark('webview.persistence.restore.start');
		traceFileOpen('persistence.restore.start', {
			sections: Array.isArray(message?.state?.sections) ? message.state.sections.length : 0,
			documentKind: typeof message?.documentKind === 'string' ? message.documentKind : '',
		});
		applyKqlxState(message && message.state ? message.state : { sections: [] });
		if (sqlConnections.length > 0) resolvePendingSqlResultRestores();

		// If the doc is empty, initialize UX content.
		try {
		const hasAny = (queryBoxes && queryBoxes.length) || (markdownBoxes && markdownBoxes.length) || (pythonBoxes && pythonBoxes.length) || (urlBoxes && urlBoxes.length) || (htmlBoxes && htmlBoxes.length) || (sqlBoxes && sqlBoxes.length);
		if (!hasAny) {
			const applied = __kustoApplyPendingAdds();
			if (!applied) {
				const k = String(pState.defaultSectionKind || 'query');
				if (k === 'markdown') {
					addMarkdownBox();
				} else if (k === 'sql') {
					addSqlBox();
				} else {
					addQueryBox();
				}
			}
		}
		} catch (e) { console.error('[kusto]', e); }

		__kustoScheduleDeferredRestoredResults();
		__kustoSeedPersistSignatureFromCurrentState();
		if (__kustoPendingProtectedResultPurge) {
			__kustoPendingProtectedResultPurge = false;
			__kustoLastPersistSignature = '';
			schedulePersist('kusto-leave-no-trace-restore', true);
		}
		perfMark('webview.persistence.restore.end', {
			querySections: Array.isArray(queryBoxes) ? queryBoxes.length : 0,
			sqlSections: Array.isArray(sqlBoxes) ? sqlBoxes.length : 0,
		});
		traceFileOpen('persistence.restore.end', {
			querySections: Array.isArray(queryBoxes) ? queryBoxes.length : 0,
			sqlSections: Array.isArray(sqlBoxes) ? sqlBoxes.length : 0,
			markdownSections: Array.isArray(markdownBoxes) ? markdownBoxes.length : 0,
		});
	} finally {
		__kustoSetDocumentLoading(false);
		pState.documentDataApplyCount = __kustoDocumentDataApplyCount;
		perfMark('webview.persistence.documentData.handle.end');
		traceFileOpen('persistence.documentData.handle.end');
	}

	// ── Schema diagnostics: log all sections on file open ──
	try {
		const allBoxIds: string[] = Array.isArray(queryBoxes) ? queryBoxes : [];
		const sectionSummary = allBoxIds.map((bid: string) => {
			const el = document.getElementById(bid) as any;
			if (!el || typeof el.getConnectionId !== 'function') return null;
			const connId = el.getConnectionId();
			const db = el.getDatabase();
			const cluster = el.getClusterUrl ? el.getClusterUrl() : '';
			const name = el.getName ? el.getName() : bid;
			return { boxId: bid, name, cluster: cluster || '(none)', database: db || '(none)', connectionId: connId || '(none)' };
		}).filter(Boolean);
		console.log('%c[schema-diag] FILE OPENED — sections:', 'color:#0af;font-weight:bold', sectionSummary);
	} catch (e) { console.error('[schema-diag]', e); }

	// Open-time schema prewarm is local/cache-only and silent. It deliberately does not
	// use ensureSchemaForBox because that path owns visible loading state and may call
	// remote Kusto when no local cache exists.
	__kustoScheduleLocalSchemaPrewarm('document-restore');
	if (pState.htmlPowerBiCompatibilityCheckEnabled !== false) {
		__kustoScheduleHtmlPowerBiCompatibilityCheck('document-restore');
	}

	// Persistence remains enabled; edits will persist via event hooks.
}

// ======================================================================
// Window bridge: expose globals for remaining legacy callers
// ======================================================================
_win.schedulePersist = schedulePersist; // inline HTML onclick consumers

