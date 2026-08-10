// Monaco module — converted from legacy/monaco.js
// Monaco Editor configuration, completions, column inference, caret docs overlay.
// Window bridge exports at bottom for remaining legacy callers.
import { pState } from '../shared/persistence-state';
import { schedulePersist } from '../core/persistence';
import { perfMark } from '../core/perf.js';
import { traceFileOpen } from '../core/file-open-trace.js';

// Sub-modules (Phase 6 decomposition) — import ensures esbuild includes them in bundle.
import {
	__kustoToSingleLineKusto,
	__kustoExplodePipesToLines,
	__kustoSplitTopLevel,
	__kustoFindTopLevelKeyword,
	__kustoPrettifyWhereClause,
	__kustoPrettifyKusto,
	__kustoSplitKustoStatementsBySemicolon,
	__kustoPrettifyKustoTextWithSemicolonStatements,
	__kustoConvertFunctionToInline,
} from './prettify';
import { updateFunctionDetection } from '../sections/kw-query-toolbar';
import {
	isDarkTheme,
	getVSCodeEditorBackground,
	defineCustomThemes,
	applyMonacoTheme,
	startMonacoThemeObserver,
} from './theme';
import {
	__kustoNormalizeTextareasWritable,
	__kustoForceEditorWritable,
	__kustoInstallWritableGuard,
	__kustoEnsureEditorWritableSoon,
	__kustoEnsureAllEditorsWritableSoon,
	__kustoIsEditorReadOnlyByCapability,
} from './writable';
import {
	__kustoIsElementVisibleForSuggest,
	__kustoGetWordNearCursor,
	__kustoFindSuggestWidgetForEditor,
	__kustoRegisterGlobalSuggestMutationHandler,
	__kustoShouldFlushPendingSchemaAfterSuggestMutation,
	__kustoInstallSmartSuggestWidgetSizing,
} from './suggest';
import {
	__kustoGetStatementStartAtOffset,
	__kustoScanIdentifiers,
	__kustoSplitTopLevelStatements,
	__kustoSplitPipelineStagesDeep,
	__kustoScheduleKustoDiagnostics,
} from './diagnostics';
import { __kustoInitCompletionDeps } from './completions';
import {
	initCaretDocsDeps,
	getHoverInfoAt, KUSTO_FUNCTION_DOCS, KUSTO_KEYWORD_DOCS,
	findEnclosingFunctionCall, getTokenAtPosition,
	KUSTO_CONTROL_COMMAND_DOCS_BASE_URL, KUSTO_CONTROL_COMMAND_DOCS_VIEW, __kustoControlCommands,
} from './caret-docs';
import { __kustoAttachAutoResizeToContent, __kustoAutoSizeEditor } from './resize';
import { __kustoInstallEditorClickFidelityGuard } from './click-fidelity';
import { __kustoNormalizeCollapsedMonacoMarkers } from './marker-ranges';
import {
	clearAutocompleteTrace,
	compactAutocompleteTrace,
	finishAutocompleteTrace,
	getActiveAutocompleteTraceId,
	getAutocompleteTrace,
	getLastAutocompleteTraceId,
	recordAutocompleteTrace,
	startAutocompleteTrace,
} from './autocomplete-trace';
import { addPageScrollListener, escapeHtml, getScrollY, maybeAutoScrollWhileDragging } from '../core/utils';
import { registerPageScrollDismissable } from '../core/page-scroll-dismiss.js';
import { ensureSchemaForBox } from '../sections/query-connection.controller';
import { __kustoGetConnectionId, __kustoGetClusterUrl, __kustoGetDatabase, retireKustoOptimizeForQueryEdit } from '../core/query-section-accessors';
import { executeQuery } from '../sections/query-execution.controller';
import { initToolbarOverflow } from '../sections/kw-query-toolbar';
import { postMessageToHost } from '../shared/webview-messages';
import { createMonacoCursorStatusPublisher } from '../shared/editor-cursor-status';
import { decideSchemaOperation } from '../shared/schema-decision';
import { canUseKustoDatabaseContextFastPath, KustoSchemaContextIntentTracker, type KustoSchemaContextIntent } from '../shared/schema-context-intent';
import { SchemaTracker } from '../shared/schema-tracker';
import { extractCrossClusterRefs, getCrossClusterSchemaCheckDelay } from '../shared/cross-cluster-schema';
import {
	KustoSupplementalSchemaCoordinator,
	kustoSupplementalTraceId,
	supplementalStateIdentity,
	type KustoSupplementalFailureKind,
	type KustoSupplementalRequestSource,
	type KustoSupplementalSchemaState,
} from '../shared/kusto-supplemental-schema-coordinator';
import {
	applyKustoColumnPipelineStages,
	buildKustoFunctionBodyFromOutputColumns,
	enhanceKustoFunctionBodiesForSchemaChunked,
	findKustoRawSchemaEntity,
	getKustoColumnNamesFromSchemaEntity,
	inferKustoRawFunctionBodyColumns,
	prepareKustoSchemaForWorkerFast,
	prepareKustoSchemaForWorkerFull,
	resolveKustoRawSchemaEntityColumns,
	resolveKustoRawSchemaEntityColumnsDeep,
	stampKustoSchemaMajorVersion,
	syntheticKustoFunctionBodyForColumnNames,
} from '../shared/kusto-function-output-schema';
import { filterResolvableCrossClusterMarkers } from '../shared/kusto-diagnostic-marker-filter';
import { decideKustoSupplementalCompletionPolicy } from '../shared/kusto-supplemental-completion-policy';
import { kustoClusterKey, kustoDatabaseKey } from '../../shared/kustoClusterUrls.js';
import { getKustoSchemaIdentityKey, resolveKustoConnection } from '../../shared/kustoAuth.js';
import {
	connections,
	monacoReadyPromise,
	setMonacoReadyPromise,
	activeQueryEditorBoxId,
	setActiveQueryEditorBoxId,
	setActiveMonacoEditor,
	autoTriggerAutocompleteEnabled,
	copilotInlineCompletionsEnabled,
	caretDocsEnabled,
	queryEditors,
	queryBoxes,
	queryEditorBoxByModelUri,
	getKustoEditorSchema,
	schemaDiagnosticsTrustedByBoxId,
	getKustoSchemaMetadata,
	getSchemaWorkerReadyState,
	getSchemaWorkerReadyStateIds,
	clearPendingSchemaWorkerUpdate,
	getPendingSchemaWorkerUpdate,
	discardStalePendingSchemaWorkerUpdate,
	markSchemaWorkerApplyFailed,
	markSchemaWorkerApplyPending,
	markSchemaWorkerReady,
	waitForSchemaWorkerReady,
	isSchemaWorkerReady,
	getKustoPreparationState,
	getKustoPreparationToken,
	invalidateSchemaWorkerReadiness,
	invalidateSchemaWorkerReadinessForBox,
	isKustoPreparationCurrent,
	isSchemaWorkerApplyRequired,
	isSchemaEnhancementPending,
	isSchemaEnhancementReady,
	markSchemaEnhancementFailed,
	markSchemaEnhancementCanceled,
	markSchemaEnhancementPending,
	markSchemaEnhancementReady,
	registerKustoSchemaApplyRequester,
	requireSchemaWorkerApply,
	requestKustoSchemaApplyForBox,
	subscribeKustoPreparation,
	updateKustoPreparation,
	type KustoPreparationToken,
	copilotInlineCompletionRequests,
	queryEditorResizeObservers,
	queryEditorVisibilityObservers,
	queryEditorVisibilityMutationObservers,
	caretDocOverlaysByBoxId,
} from '../core/state';
import { shouldForceKustoFocusedSchemaApply } from '../shared/schema-utils.js';
import { raceSupplementalOperationLease } from '../shared/supplemental-operation-lease.js';
import {
	classifyKustoSupplementalRetryState,
	KustoAutocompleteRetryCoordinator,
	runKustoAutocompleteTriggerFrame,
	type KustoAutocompleteRetryOutcome,
	type KustoAutocompleteRetryRequest,
	waitForKustoSupplementalRetryReadiness,
} from '../shared/kusto-autocomplete-retry.js';
import { KustoWorkerMutationPort, type KustoWorkerMutationTransaction } from '../shared/kusto-worker-mutation-port.js';
import { kustoEditorSchemaCoordinator } from '../core/kusto-editor-schema-runtime.js';
import type { KustoEditorModelLease } from '../core/kusto-editor-schema-coordinator.js';
import { awaitKustoSchemaPreparation, observeKustoSchemaPreparationTimeout, shouldStopKustoSchemaApplyAfterPendingFlush } from '../shared/kusto-schema-preparation-deadline.js';

// ── Schema state singleton (the ONLY source of truth for schema tracking) ───
export const __kustoSchemaTracker = new SchemaTracker();
const __kustoSchemaContextIntents = new KustoSchemaContextIntentTracker();

const _win = window;

function __kustoGetBoxIdForEditor(ed: any): string {
	try {
		const model = ed && typeof ed.getModel === 'function' ? ed.getModel() : null;
		const modelUri = model && model.uri ? model.uri.toString() : '';
		if (modelUri && queryEditorBoxByModelUri && queryEditorBoxByModelUri[modelUri]) {
			return String(queryEditorBoxByModelUri[modelUri]);
		}
	} catch (e) { console.error('[kusto]', e); }
	try {
		for (const [boxId, editor] of Object.entries(queryEditors || {})) {
			if (editor === ed) return String(boxId);
		}
	} catch (e) { console.error('[kusto]', e); }
	return '';
}

function __kustoGetSchemaContextForBox(boxId: string): { connectionId: string; accountPartition: string; database: string; clusterUrl: string; schemaKey: string } | null {
	try {
		let ownerId = boxId;
		try {
			if (typeof (_win as any).__kustoGetSelectionOwnerBoxId === 'function') {
				ownerId = (_win as any).__kustoGetSelectionOwnerBoxId(boxId) || boxId;
			}
		} catch (e) { console.error('[kusto]', e); }
		const ids = Array.from(new Set([ownerId, boxId].map(id => String(id || '').trim()).filter(Boolean)));
		const editor = ids.map(id => queryEditors ? queryEditors[id] : null).find(Boolean) || null;
		const domNode = editor && typeof editor.getDomNode === 'function' ? editor.getDomNode() : null;
		const allSections = Array.from(document.querySelectorAll('kw-query-section')) as any[];
		const section = ids.map(id => document.getElementById(id) as any).find((el: any) => el && typeof el.getDatabase === 'function')
			|| (domNode && typeof domNode.closest === 'function' ? domNode.closest('kw-query-section') as any : null)
			|| allSections.find((el: any) => ids.includes(String(el.boxId || el.id || '')))
			|| (allSections.length === 1 ? allSections[0] : null);
		const connectionId = ids.map(id => __kustoGetConnectionId(id)).find(Boolean) || (typeof section?.getConnectionId === 'function' ? String(section.getConnectionId() || '') : '');
		const database = ids.map(id => __kustoGetDatabase(id)).find(Boolean) || (typeof section?.getDatabase === 'function' ? String(section.getDatabase() || '') : '');
		if (!database) {
			return null;
		}
		const selectedClusterUrl = ids.map(id => __kustoGetClusterUrl(id)).find(Boolean) || (typeof section?.getClusterUrl === 'function' ? String(section.getClusterUrl() || '') : '');
		const conn = Array.isArray(connections) ? connections.find(c => c && String(c.id || '') === connectionId) : null;
		const clusterUrl = selectedClusterUrl || (conn && conn.clusterUrl ? String(conn.clusterUrl) : '');
		const accountPartition = String(conn?.accountPartition || '').trim();
		if (!clusterUrl || !connectionId || !accountPartition) {
			return null;
		}
		return { connectionId, accountPartition, database, clusterUrl, schemaKey: getKustoSchemaIdentityKey(connectionId, accountPartition, clusterUrl, database) };
	} catch {
		return null;
	}
}

export type KustoAutocompleteSchemaTarget = Readonly<{
	sectionInstanceId: string;
	targetGeneration: number;
	context?: Readonly<{
		connectionId: string;
		accountPartition: string;
		database: string;
		clusterUrl: string;
		schemaKey: string;
	}>;
}>;

function __kustoCaptureAutocompleteSchemaTarget(boxId: string): KustoAutocompleteSchemaTarget | undefined {
	const context = __kustoGetSchemaContextForBox(boxId);
	const identity = kustoEditorSchemaCoordinator.getIdentity(boxId);
	if (!identity) return undefined;
	return Object.freeze({ ...identity, ...(context ? { context: Object.freeze({ ...context }) } : {}) });
}

export function __kustoAutocompleteSchemaTargetIdentityMatches(
	expected: KustoAutocompleteSchemaTarget | undefined,
	current: KustoAutocompleteSchemaTarget | undefined,
): boolean {
	if (!expected) return true;
	return !!current
		&& current.sectionInstanceId === expected.sectionInstanceId
		&& current.targetGeneration === expected.targetGeneration
		&& (!!current.context === !!expected.context)
		&& (!expected.context || current.context?.schemaKey === expected.context.schemaKey);
}

function __kustoAutocompleteSchemaTargetMatches(boxId: string, expected: KustoAutocompleteSchemaTarget | undefined): boolean {
	return __kustoAutocompleteSchemaTargetIdentityMatches(expected, __kustoCaptureAutocompleteSchemaTarget(boxId));
}

async function __kustoFlushPendingSchemaWorkerUpdateForBox(boxId: string, options: { setAsContext?: boolean; contextIntent?: KustoSchemaContextIntent } = {}): Promise<boolean> {
	let failureOwner: { token: KustoPreparationToken; schemaKey: string; schemaSignature?: string; modelUri: string } | undefined;
	try {
		const pending = getPendingSchemaWorkerUpdate(boxId);
		if (!pending || !pending.rawSchemaJson) {
			return false;
		}
		if (discardStalePendingSchemaWorkerUpdate(boxId)) {
			traceFileOpen('monaco.schema.pending.discard.stalePreparation', { boxId, schemaKey: pending.schemaKey });
			return false;
		}
		const setAsContext = options.setAsContext !== false;
		const currentContext = __kustoGetSchemaContextForBox(boxId);
		if (!currentContext || pending.schemaKey !== currentContext.schemaKey) {
			clearPendingSchemaWorkerUpdate(boxId, pending);
			return false;
		}
		const editor = queryEditors ? queryEditors[boxId] : null;
		const model = editor && typeof editor.getModel === 'function' ? editor.getModel() : null;
		const modelUri = model && model.uri ? model.uri.toString() : '';
		const modelLease = kustoEditorSchemaCoordinator.getModelLease(boxId);
		const requiresModelLease = !!pending.deliveryOwnership || !!kustoEditorSchemaCoordinator.getIdentity(boxId);
		if (!modelUri || (requiresModelLease && modelLease?.modelUri !== modelUri) || typeof _win.__kustoSetMonacoKustoSchema !== 'function') {
			return false;
		}
		const preparationToken = pending.backgroundOnly ? undefined : (pending.preparationToken || getKustoPreparationToken(boxId));
		if (preparationToken && !isKustoPreparationCurrent(preparationToken, { schemaKey: pending.schemaKey, schemaSignature: pending.schemaSignature })) {
			clearPendingSchemaWorkerUpdate(boxId, pending);
			return false;
		}
		const isPendingCurrent = () => (!pending.deliveryOwnership || kustoEditorSchemaCoordinator.isSchemaRequestCurrent(
			boxId,
			pending.deliveryOwnership.request,
			pending.deliveryOwnership.target,
			pending.deliveryOwnership.request.requestToken,
		)) && (!requiresModelLease || !!modelLease && kustoEditorSchemaCoordinator.isModelLeaseCurrent(modelLease))
			&& (!preparationToken || isKustoPreparationCurrent(preparationToken, { schemaKey: pending.schemaKey, schemaSignature: pending.schemaSignature, modelUri }));
		if (!isPendingCurrent()) {
			clearPendingSchemaWorkerUpdate(boxId, pending);
			return false;
		}
		if (!pending.backgroundOnly) markSchemaWorkerApplyPending(boxId, pending.schemaKey, pending.schemaSignature, modelUri, preparationToken);
		if (preparationToken && isKustoPreparationCurrent(preparationToken, {
			schemaKey: pending.schemaKey,
			schemaSignature: pending.schemaSignature,
			modelUri,
		})) {
			failureOwner = { token: preparationToken, schemaKey: pending.schemaKey, schemaSignature: pending.schemaSignature, modelUri };
		}
		const applied = await awaitKustoSchemaPreparation(Promise.resolve(_win.__kustoSetMonacoKustoSchema(
			pending.rawSchemaJson,
			pending.clusterUrl,
			pending.database,
			setAsContext,
			modelUri,
			!!pending.forceRefresh,
			isPendingCurrent,
			preparationToken,
			options.contextIntent,
			pending.connectionId,
			pending.accountPartition,
		)), preparationToken);
		if (!applied) {
			if (failureOwner && isKustoPreparationCurrent(failureOwner.token, {
				schemaKey: failureOwner.schemaKey,
				schemaSignature: failureOwner.schemaSignature,
				modelUri: failureOwner.modelUri,
			})) {
				markSchemaWorkerApplyFailed(boxId, failureOwner.schemaKey, failureOwner.modelUri, failureOwner.token);
			}
			return false;
		}
		try { if (setAsContext && typeof __kustoTriggerRevalidation === 'function') __kustoTriggerRevalidation(boxId); } catch (e) { console.error('[kusto]', e); }
		if (!isPendingCurrent()) return false;
		markSchemaWorkerReady(boxId, pending.schemaKey, pending.schemaSignature, modelUri, preparationToken);
		__kustoScheduleSupplementalPump(0);
		clearPendingSchemaWorkerUpdate(boxId, pending);
		return true;
	} catch (error) {
		console.error('[monaco-kusto] Failed to flush pending schema update:', error);
		try {
			if (failureOwner && isKustoPreparationCurrent(failureOwner.token, {
				schemaKey: failureOwner.schemaKey,
				schemaSignature: failureOwner.schemaSignature,
				modelUri: failureOwner.modelUri,
			})) {
				markSchemaWorkerApplyFailed(boxId, failureOwner.schemaKey, failureOwner.modelUri, failureOwner.token);
			}
		} catch (e) { console.error('[kusto]', e); }
		return false;
	}
}

const __kustoAutocompleteRetryCoordinator = new KustoAutocompleteRetryCoordinator();

function __kustoSetAutocompleteRetryPending(ed: any, pending: boolean): void {
	try {
		if (ed) ed.__kustoAutocompleteRetryQueuedForSchema = pending;
	} catch (e) { console.error('[kusto]', e); }
}

function __kustoSubscribeAutocompleteRetryCancellation(ed: any, listener: () => void): { dispose: () => void } {
	const disposables: Array<{ dispose: () => void }> = [];
	let blurTimer: number | undefined;
	const add = (disposable: any) => {
		if (disposable && typeof disposable.dispose === 'function') disposables.push(disposable);
	};
	const cancelIfUnfocused = () => {
		if (blurTimer !== undefined) window.clearTimeout(blurTimer);
		blurTimer = window.setTimeout(() => {
			blurTimer = undefined;
			const focused = !!ed?.hasTextFocus?.() || !!ed?.hasWidgetFocus?.();
			if (!focused) listener();
		}, 150);
	};
	const cancelIfHidden = () => { if (document.hidden) listener(); };
	const cancelOnWindowBlur = () => listener();
	try {
		add(ed?.onKeyDown?.((event: any) => {
			if (event?.keyCode === monaco.KeyCode.Escape || event?.browserEvent?.key === 'Escape') listener();
		}));
	} catch (e) { console.error('[kusto]', e); }
	try { add(ed?.onDidBlurEditorText?.(cancelIfUnfocused)); } catch (e) { console.error('[kusto]', e); }
	try { add(ed?.onDidBlurEditorWidget?.(cancelIfUnfocused)); } catch (e) { console.error('[kusto]', e); }
	document.addEventListener('visibilitychange', cancelIfHidden, true);
	window.addEventListener('blur', cancelOnWindowBlur, true);
	return {
		dispose: () => {
			if (blurTimer !== undefined) window.clearTimeout(blurTimer);
			for (const disposable of disposables.splice(0)) {
				try { disposable.dispose(); } catch { /* best effort */ }
			}
			document.removeEventListener('visibilitychange', cancelIfHidden, true);
			window.removeEventListener('blur', cancelOnWindowBlur, true);
		},
	};
}

function __kustoQueueAutocompleteRetryForSupplementalSchemas(request: KustoAutocompleteRetryRequest | undefined, ed: any, boxId: string, modelUri: string, missingKeys: string[]): boolean {
	try {
		if (!request || !ed || !boxId || !modelUri || missingKeys.length === 0) return false;
		const expectedReferenceGenerations = new Map<string, number>();
		for (const key of missingKeys) {
			const generation = __kustoSupplementalCoordinator.getState(modelUri, key)?.referenceGeneration;
			if (!generation) {
				__kustoAutocompleteRetryCoordinator.cancelRequest(request);
				return false;
			}
			expectedReferenceGenerations.set(key, generation);
		}
		__kustoTraceCrossCluster('autocomplete-retry-wait-start', { boxId, missingKeys });
		const ready = waitForKustoSupplementalRetryReadiness({
			keys: missingKeys,
			signal: request.signal,
			getStatus: key => {
				return classifyKustoSupplementalRetryState(
					expectedReferenceGenerations.get(key) || 0,
					__kustoSupplementalCoordinator.getState(modelUri, key),
				);
			},
			onStale: () => {
				__kustoTraceCrossCluster('autocomplete-retry-stale-reference', { boxId });
				__kustoAutocompleteRetryCoordinator.cancelRequest(request);
			},
			timeoutMs: CROSS_CLUSTER_SCHEMA_AUTOCOMPLETE_RETRY_WAIT_MS,
		});
		const queued = __kustoAutocompleteRetryCoordinator.queue(request, {
			ready,
			onSettled: (outcome: KustoAutocompleteRetryOutcome) => {
				__kustoSetAutocompleteRetryPending(ed, false);
				__kustoTraceCrossCluster('autocomplete-retry-wait-finished', {
					boxId,
					missingKeys,
					results: missingKeys.map(key => __kustoIsCrossClusterSchemaLoadedForModel(key, modelUri)),
					outcome: outcome.reason,
					hasTextFocus: typeof ed.hasTextFocus === 'function' ? ed.hasTextFocus() : null,
					hasWidgetFocus: typeof ed.hasWidgetFocus === 'function' ? ed.hasWidgetFocus() : null,
				});
			},
			trigger: () => {
				if (typeof _win.__kustoTriggerAutocompleteForBoxId !== 'function') return false;
				__kustoTraceCrossCluster('autocomplete-retry-trigger', { boxId, missingKeys });
				try { ed?.trigger?.('keyboard', 'hideSuggestWidget', {}); } catch (e) { console.error('[kusto]', e); }
				return _win.__kustoTriggerAutocompleteForBoxId(boxId);
			},
			fallback: () => ed?.trigger?.('keyboard', 'editor.action.triggerSuggest', {}),
		});
		if (queued) __kustoSetAutocompleteRetryPending(ed, true);
		return queued;
	} catch (e) { console.error('[kusto]', e); }
	return false;
}

async function __kustoPrepareSchemaForAutocomplete(ed: any, traceId?: string, request?: KustoAutocompleteRetryRequest): Promise<'ready' | 'blocked'> {
	try {
		const boxId = __kustoGetBoxIdForEditor(ed);
		if (!boxId) {
			recordAutocompleteTrace(traceId, 'schema-prepare-no-box', {});
			return 'ready';
		}
		const context = __kustoGetSchemaContextForBox(boxId);
		if (!context) {
			recordAutocompleteTrace(traceId, 'schema-prepare-no-context', { boxId });
			const queryText = __kustoExtractAutocompleteSchemaScopeText(ed);
			const refs = extractCrossClusterRefs(queryText);
			if (refs && refs.length) {
				const modelUri = __kustoGetModelUriForCrossClusterBox(boxId);
				const editorModel = ed?.getModel?.();
				const references = __kustoLimitSupplementalReferences(refs.map(ref => {
					const clusterName = String(ref?.clusterName || '').trim();
					const database = String(ref?.database || '').trim();
					return { schemaKey: __kustoGetCrossClusterSchemaKey(clusterName, database), clusterName, database };
				}).filter(ref => !!ref.schemaKey && !!ref.clusterName && !!ref.database));
				const synchronized = __kustoSupplementalCoordinator.syncReferences({
					boxId,
					modelUri,
					modelVersion: Number(editorModel?.getVersionId?.() || 0),
					references,
				});
				const synchronizedStates = [...synchronized.added, ...synchronized.retained];
				const keys: string[] = [];
				for (const ref of references) {
					const clusterName = String(ref?.clusterName || '').trim();
					const database = String(ref?.database || '').trim();
					const key = ref.schemaKey;
					if (!key || keys.includes(key)) continue;
					const state = synchronizedStates.find(candidate => candidate.schemaKey === key)
						|| __kustoSupplementalCoordinator.getState(modelUri, key);
					if (!state) continue;
					keys.push(key);
					__kustoMarkCrossClusterAutocompleteDemand(key);
					const loadedEntry = __kustoCrossClusterSchemas?.[key];
					const refreshStale = !!state?.fetchedAvailable
						&& state.status !== 'failed'
						&& loadedEntry?.deliverySource === 'disk-cache-stale';
					if (state && !refreshStale) {
						__kustoSupplementalCoordinator.escalateToAutocomplete(supplementalStateIdentity(state));
					}
					if (!__kustoIsCrossClusterSchemaLoadedForModel(key, modelUri) || refreshStale) {
						if (refreshStale && state && typeof __kustoRequestCrossClusterSchema === 'function') {
							__kustoSupplementalCoordinator.refreshWithAutocomplete(supplementalStateIdentity(state));
							__kustoRequestCrossClusterSchema(clusterName, database, boxId, 'autocomplete');
							continue;
						}
						if (__kustoIsCrossClusterSchemaLoaded(key) && loadedEntry?.rawSchemaJson && typeof _win.__kustoApplyCrossClusterSchema === 'function') {
							void _win.__kustoApplyCrossClusterSchema(clusterName, loadedEntry.clusterUrl || clusterName, database, loadedEntry.rawSchemaJson, boxId, 'autocomplete-no-context-reapply');
						} else if (typeof __kustoRequestCrossClusterSchema === 'function') {
							__kustoRequestCrossClusterSchema(clusterName, database, boxId, 'autocomplete');
						}
					}
				}
				__kustoSupplementalCoordinator.setPrimaryReady(modelUri, true);
				__kustoScheduleSupplementalPump(0);
				const missingKeys = keys.filter(key => !__kustoIsCrossClusterSchemaLoadedForModel(key, modelUri));
				recordAutocompleteTrace(traceId, 'schema-prepare-no-context-refs', { boxId, keys, missingKeys });
				if (missingKeys.length) {
					const ready = await Promise.all(missingKeys.map(key => __kustoWaitForCrossClusterSchemaReadyForModel(key, modelUri, CROSS_CLUSTER_SCHEMA_AUTOCOMPLETE_WAIT_MS, request?.signal)));
					recordAutocompleteTrace(traceId, 'schema-prepare-no-context-cross-cluster-wait', { boxId, missingKeys, results: ready });
					if (!ready.every(Boolean)) {
						__kustoQueueAutocompleteRetryForSupplementalSchemas(request, ed, boxId, modelUri, missingKeys);
						return 'ready';
					}
				}
			}
			return 'ready';
		}
		recordAutocompleteTrace(traceId, 'schema-prepare-context', { boxId, ...context });

		await __kustoFlushPendingSchemaWorkerUpdateForBox(boxId);

		const schema = getKustoEditorSchema(boxId);
		const rawSchemaJson = schema && schema.rawSchemaJson ? schema.rawSchemaJson : null;
		if (!rawSchemaJson) {
			recordAutocompleteTrace(traceId, 'schema-prepare-no-raw-schema', { boxId, hasSchema: !!schema, tables: Array.isArray(schema?.tables) ? schema.tables.length : undefined });
			if (typeof ensureSchemaForBox === 'function') {
				ensureSchemaForBox(boxId, false);
			}
			__kustoQueueAutocompleteRetryForPrimarySchema(request, ed, boxId, context.schemaKey);
			return 'blocked';
		}

		const primaryModelUri = ed?.getModel?.()?.uri?.toString?.() || '';
		if (!isSchemaWorkerReady(boxId, context.schemaKey, primaryModelUri || undefined)) {
			if (typeof __kustoUpdateSchemaForFocusedBox === 'function') {
				try { void __kustoUpdateSchemaForFocusedBox(boxId, false); } catch (e) { console.error('[kusto]', e); }
			}
			const primaryReady = await waitForSchemaWorkerReady(boxId, context.schemaKey, CROSS_CLUSTER_SCHEMA_AUTOCOMPLETE_WAIT_MS, primaryModelUri || undefined, request?.signal);
			recordAutocompleteTrace(traceId, 'schema-prepare-primary-wait', { boxId, schemaKey: context.schemaKey, ready: primaryReady });
			__kustoTraceCrossCluster('autocomplete-primary-wait-finished', { boxId, schemaKey: context.schemaKey, ready: primaryReady });
			if (!primaryReady) {
				__kustoQueueAutocompleteRetryForPrimarySchema(request, ed, boxId, context.schemaKey);
				return 'blocked';
			}
		}

		const queryText = __kustoExtractAutocompleteSchemaScopeText(ed);

		const refs = (typeof __kustoExtractCrossClusterRefs === 'function')
			? __kustoExtractCrossClusterRefs(queryText, context)
			: extractCrossClusterRefs(queryText, context);
		recordAutocompleteTrace(traceId, 'schema-prepare-refs', { boxId, scopeLength: queryText.length, refs });
		__kustoTraceCrossCluster('autocomplete-prepare-refs', { boxId, refs: (refs || []).map((ref: any) => `${ref.clusterName || '(same)'}/${ref.database}`) });
		if (!refs || refs.length === 0) {
			return 'ready';
		}

		const keys: string[] = [];
		const modelUri = __kustoGetModelUriForCrossClusterBox(boxId);
		const synchronizedStates = __kustoSyncSupplementalReferencesForBox(boxId, 'autocomplete');
		for (const ref of refs) {
			try {
				const clusterName = __kustoResolveCrossClusterNameForRef(ref, boxId, context);
				const database = String(ref?.database || '').trim();
				const key = __kustoGetCrossClusterSchemaKey(clusterName, database);
				if (!key || keys.includes(key)) {
					continue;
				}
				const state = synchronizedStates.find(candidate => candidate.schemaKey === key)
					|| __kustoSupplementalCoordinator.getState(modelUri, key);
				if (!state) continue;
				keys.push(key);
				const refreshStale = state.fetchedAvailable
					&& state.status !== 'failed'
					&& __kustoCrossClusterSchemas[key]?.deliverySource === 'disk-cache-stale';
				if (state.status === 'loaded' && !refreshStale) continue;
				__kustoMarkCrossClusterAutocompleteDemand(key);
				if (refreshStale) __kustoSupplementalCoordinator.refreshWithAutocomplete(supplementalStateIdentity(state));
				else __kustoSupplementalCoordinator.escalateToAutocomplete(supplementalStateIdentity(state));
				if (__kustoRequestCrossClusterSchema) {
					__kustoRequestCrossClusterSchema(clusterName, database, boxId, 'autocomplete');
				}
			} catch (e) { console.error('[kusto]', e); }
		}
		__kustoScheduleSupplementalPump(0);

		const missingKeys = keys.filter(key => !__kustoIsCrossClusterSchemaLoadedForModel(key, modelUri));
		recordAutocompleteTrace(traceId, 'schema-prepare-keys', { boxId, modelUri, keys, missingKeys });
		__kustoTraceCrossCluster('autocomplete-prepare-keys', { boxId, modelUri, keys, missingKeys });
		if (missingKeys.length === 0) {
			return 'ready';
		}

		const quickReadyResults = await Promise.all(missingKeys.map(key => __kustoWaitForCrossClusterSchemaReadyForModel(key, modelUri, CROSS_CLUSTER_SCHEMA_AUTOCOMPLETE_WAIT_MS, request?.signal)));
		recordAutocompleteTrace(traceId, 'schema-prepare-cross-cluster-wait', { boxId, missingKeys, results: quickReadyResults });
		__kustoTraceCrossCluster('autocomplete-short-wait-finished', { boxId, missingKeys, results: quickReadyResults });
		if (quickReadyResults.every(Boolean)) {
			return 'ready';
		}

		__kustoQueueAutocompleteRetryForSupplementalSchemas(request, ed, boxId, modelUri, missingKeys);
		return 'ready';
	} catch (error) {
		console.error('[monaco-kusto] Failed to prepare schema for autocomplete:', error);
		return 'ready';
	}
}

function __kustoExtractAutocompleteSchemaScopeTextForModelPosition(model: any, position: any): string {
	try {
		const fullText = model && typeof model.getValue === 'function' ? String(model.getValue() || '') : '';
		if (model && position && fullText) {
			const offset = typeof model.getOffsetAt === 'function'
				? model.getOffsetAt(position)
				: fullText.length;
			const statements = __kustoSplitTopLevelStatements(fullText);
			if (Array.isArray(statements) && statements.length) {
				let statementIndex = -1;
				for (let i = 0; i < statements.length; i++) {
					const statement = statements[i];
					const start = Math.max(0, Number(statement?.startOffset) || 0);
					const end = start + String(statement?.text || '').length;
					if (offset >= start && offset <= end) {
						statementIndex = i;
						break;
					}
				}
				if (statementIndex < 0) {
					for (let i = 0; i < statements.length; i++) {
						const start = Math.max(0, Number(statements[i]?.startOffset) || 0);
						if (offset < start) {
							statementIndex = Math.max(0, i - 1);
							break;
						}
					}
				}
				if (statementIndex < 0) {
					statementIndex = statements.length - 1;
				}
				let firstIndex = statementIndex;
				while (firstIndex > 0) {
					const previousText = String(statements[firstIndex - 1]?.text || '').trim();
					if (!/^let\b/i.test(previousText)) {
						break;
					}
					firstIndex--;
				}
				const scopeText = statements
					.slice(firstIndex, statementIndex + 1)
					.map(statement => String(statement?.text || '').trim())
					.filter(Boolean)
					.join(';\n');
				if (scopeText) {
					return scopeText;
				}
			}
		}
	} catch (e) { console.error('[kusto]', e); }
	return '';
}

function __kustoExtractAutocompleteSchemaScopeText(ed: any): string {
	try {
		const model = ed && typeof ed.getModel === 'function' ? ed.getModel() : null;
		const pos = ed && typeof ed.getPosition === 'function' ? ed.getPosition() : null;
		const scoped = __kustoExtractAutocompleteSchemaScopeTextForModelPosition(model, pos);
		if (scoped) return scoped;
	} catch (e) { console.error('[kusto]', e); }
	try {
		if (typeof __kustoExtractStatementTextAtCursor === 'function') {
			const statementText = __kustoExtractStatementTextAtCursor(ed);
			if (statementText) {
				return statementText;
			}
		}
	} catch (e) { console.error('[kusto]', e); }
	try {
		return typeof ed?.getValue === 'function' ? String(ed.getValue() || '') : '';
	} catch {
		return '';
	}
}

// Module-level variables for functions that span closure scopes (Scope A: require callback, Scope B: initQueryEditor callback).
// These replace _win.xxx bridge assignments for self-consumed functions.
let __kustoEnableMarkersForModel: ((modelUri: any) => void) | null = null;
let __kustoDisableMarkersForModel: ((modelUri: any) => void) | null = null;
let __kustoScheduleDisableMarkersForModel: ((modelUri: any) => void) | null = null;
let __kustoGetHoverInfoAt: ((model: any, position: any, boxId?: string, options?: { inferPipeOperatorContext?: boolean }) => any) | null = null;
const __kustoWorkerMutations = new KustoWorkerMutationPort();
let __kustoSetMonacoKustoSchemaInternal: ((...args: any[]) => Promise<any>) | null = null;
let __kustoSetDatabaseInContext: ((...args: any[]) => Promise<boolean>) | null = null;
let __kustoSchemaEnhancementToken = 0;
const __kustoSchemaEnhancementTokenByModelSchemaKey: Record<string, number> = {};
const __kustoSchemaEnhancementPendingByModelSchemaKey = new Set<string>();
const __kustoCustomColumnCompletionProviderDisabledModels = new Set<string>();
export let __kustoUpdateSchemaForFocusedBox: ((...args: any[]) => Promise<void>) | null = null;
let __kustoEnableMarkersForBox: ((boxId: any) => void) | null = null;
let __kustoTriggerRevalidation: ((boxId: any) => void) | null = null;
let __kustoExtractCrossClusterRefs: ((queryText: any, currentContext?: any) => any[]) | null = null;
let __kustoRequestCrossClusterSchema: ((clusterName: any, database: any, boxId: any, requestSource?: KustoSupplementalRequestSource) => void) | null = null;
let __kustoApplyCrossClusterSchemaInternal: ((
	clusterName: unknown,
	clusterUrl: unknown,
	database: unknown,
	rawSchemaJson: unknown,
	boxId: unknown,
	source: unknown,
	cacheAgeMs: unknown,
	modelUri: unknown,
	referenceGeneration: unknown,
	modelVersion: unknown,
	primarySchemaKey: unknown,
	brokerRevision: unknown,
	transaction: KustoWorkerMutationTransaction,
	isCurrent: () => boolean,
) => Promise<void>) | null = null;
let __kustoCheckCrossClusterRefs: ((queryText: any, boxId: any) => void) | null = null;
let __kustoTriggerAutocompleteInternal: ((ed: any) => Promise<boolean>) | null = null;
let __kustoFocusInProgress: string | null = null;
const __kustoFocusUpdateRerunByBoxId: Record<string, boolean> = {};
let __kustoStatementSeparatorMinBlankLines = 1;
let __kustoGetStatementBlocksFromModel: ((model: any) => any[]) | null = null;
let __kustoIsSeparatorBlankLine: ((model: any, lineNumber: any) => boolean) | null = null;

function __kustoClaimSchemaContextIntent(boxId: string, clusterUrl: string, database: string, modelUri: string, connectionId: string, accountPartition: string): KustoSchemaContextIntent {
	return __kustoSchemaContextIntents.claim({
		boxId: String(boxId || ''),
		schemaKey: getKustoSchemaIdentityKey(connectionId, accountPartition, clusterUrl, database),
		modelUri: String(modelUri || ''),
	});
}

function __kustoQueueDatabaseContextSwitch(clusterUrl: string, database: string, modelUri: string, contextIntent: KustoSchemaContextIntent, connectionId: string, accountPartition: string): Promise<boolean> {
	return __kustoWorkerMutations.enqueue({ kind: 'context-switch', advancesPrimaryIntent: true }, async transaction => {
		if (!__kustoSchemaContextIntents.isCurrent(contextIntent) || !__kustoSetDatabaseInContext) return false;
		return __kustoSetDatabaseInContext(
			clusterUrl,
			database,
			transaction,
			modelUri,
			() => __kustoSchemaContextIntents.isCurrent(contextIntent),
			connectionId,
			accountPartition,
		);
	}).catch((error: unknown) => {
		traceFileOpen('monaco.schema.contextSwitch.error', { clusterUrl, database, modelUri, error: error instanceof Error ? error.message : String(error) });
		return false;
	});
}

const __kustoRegisteredSchemaApplyRequester = (boxId: string, enableMarkers: boolean): boolean => {
	const updater = __kustoUpdateSchemaForFocusedBox;
	const modelUri = queryEditors?.[boxId]?.getModel?.()?.uri?.toString?.();
	if (!updater || !modelUri) return false;
	void updater(boxId, enableMarkers);
	return true;
};
registerKustoSchemaApplyRequester(__kustoRegisteredSchemaApplyRequester);

function __kustoYieldForSchemaEnhancement(): Promise<void> {
	return new Promise(resolve => {
		try {
			const ric = (window as any).requestIdleCallback;
			if (typeof ric === 'function') {
				ric(() => resolve(), { timeout: 2000 });
				return;
			}
		} catch {
			// fall back to timer below
		}
		setTimeout(resolve, 0);
	});
}

const KUSTO_SCHEMA_ENHANCEMENT_TIMEOUT_MS = 12_000;

async function __kustoRecoverPrimarySchemaAfterDetachedMutation(
	transaction: KustoWorkerMutationTransaction,
	preferredBoxId: string,
	reason: string,
): Promise<boolean> {
	const clearWorker = async (): Promise<boolean> => {
		if (!transaction.isActive() || !monaco?.languages?.kusto?.getKustoWorker) return false;
		const workerAccessor = await monaco.languages.kusto.getKustoWorker();
		if (!transaction.isActive()) return false;
		let cleared = false;
		for (const model of monaco.editor.getModels?.() || []) {
			if (!transaction.isActive()) return false;
			const worker = await workerAccessor(model.uri);
			if (!transaction.isActive()) return false;
			if (worker?.setSchema) {
				await worker.setSchema({ cluster: { connectionString: '', databases: [] } });
				if (!transaction.commit({ destructive: true })) return false;
				cleared = true;
			}
		}
		return cleared;
	};
	const deferRecovery = (physicallyCleared: boolean): void => {
		__kustoSchemaTracker.globalInitialized = false;
		__kustoSchemaTracker.loadedSchemas = {};
		for (const modelUri of Object.keys(__kustoSchemaTracker.loadedSchemasByModel)) {
			__kustoSchemaTracker.loadedSchemasByModel[modelUri] = {};
		}
		__kustoSchemaTracker.databaseInContext = null;
		for (const boxId of kustoEditorSchemaCoordinator.getSectionIds()) {
			invalidateSchemaWorkerReadinessForBox(boxId, false, false);
			requireSchemaWorkerApply(boxId);
		}
		traceFileOpen('monaco.schema.detached.recoveryDeferred', { reason, physicallyCleared });
	};
	if (document.hidden) {
		const physicallyCleared = await clearWorker();
		deferRecovery(physicallyCleared);
		return false;
	}
	const candidates = Array.from(new Set([
		String(activeQueryEditorBoxId || ''),
		String(preferredBoxId || ''),
		...kustoEditorSchemaCoordinator.getSectionIds(),
	])).filter(Boolean);
	for (const boxId of candidates) {
		const recoverActiveContext = boxId === String(activeQueryEditorBoxId || '');
		const editor = queryEditors?.[boxId];
		const modelUri = String(editor?.getModel?.()?.uri?.toString?.() || '');
		const modelLease = kustoEditorSchemaCoordinator.getModelLease(boxId);
		const identity = kustoEditorSchemaCoordinator.getIdentity(boxId);
		const target = kustoEditorSchemaCoordinator.getTarget(boxId);
		const schema = getKustoEditorSchema(boxId);
		if (!modelUri || modelLease?.modelUri !== modelUri || !identity || !target?.connectionId || !target.database || !schema?.rawSchemaJson) continue;
		const connection = connections.find(candidate => String(candidate?.id || '') === target.connectionId);
		const clusterUrl = String(__kustoGetClusterUrl(boxId) || connection?.clusterUrl || '');
		const accountPartition = String(connection?.accountPartition || '');
		if (!clusterUrl || !accountPartition || !__kustoSetMonacoKustoSchemaInternal) continue;
		const isCurrent = () => kustoEditorSchemaCoordinator.isModelLeaseCurrent(modelLease)
			&& kustoEditorSchemaCoordinator.isCurrent(boxId, identity, target)
			&& (!recoverActiveContext || activeQueryEditorBoxId === boxId);
		if (!isCurrent()) continue;
		const schemaKey = getKustoSchemaIdentityKey(target.connectionId, accountPartition, clusterUrl, target.database);
		const schemaSignature = getKustoSchemaMetadata(boxId)?.schemaSignature;
		__kustoForcePrimaryReplaceByBoxId.add(boxId);
		invalidateSchemaWorkerReadinessForBox(boxId, false, false);
		const recovered = await __kustoSetMonacoKustoSchemaInternal(
			schema.rawSchemaJson,
			clusterUrl,
			target.database,
			transaction,
			true,
			modelUri,
			true,
			isCurrent,
			undefined,
			undefined,
			target.connectionId,
			accountPartition,
		);
		if (!recovered || !transaction.isActive() || !isCurrent()) continue;
		markSchemaWorkerReady(boxId, schemaKey, schemaSignature, modelUri);
		traceFileOpen('monaco.schema.detached.recovered', { boxId, reason, modelUri });
		return true;
	}
	const physicallyCleared = await clearWorker();
	deferRecovery(physicallyCleared);
	return false;
}

function __kustoScheduleEnhancedSchemaApply(args: {
	worker: any;
	schemaObj: any;
	clusterName?: string;
	clusterUrl: string;
	database: string;
	connectionId: string;
	accountPartition: string;
	databaseInContext: string;
	schemaKey: string;
	modelKey: string;
	setAsContext: boolean;
	isCurrent?: () => boolean;
	preparationToken?: KustoPreparationToken;
	contextIntent?: KustoSchemaContextIntent;
	expectedOwnerToken?: number;
}): boolean {
	const token = ++__kustoSchemaEnhancementToken;
	const enhancementKey = `${args.modelKey}|${args.schemaKey}`;
	if (args.expectedOwnerToken !== undefined
		&& __kustoSchemaEnhancementTokenByModelSchemaKey[enhancementKey] !== args.expectedOwnerToken) {
		return false;
	}
	const preparationToken = args.preparationToken;
	const preparationState = preparationToken ? getKustoPreparationState(preparationToken.boxId) : undefined;
	const schemaSignature = preparationState?.target.schemaSignature;
	__kustoSchemaEnhancementTokenByModelSchemaKey[enhancementKey] = token;
	if (preparationToken && isKustoPreparationCurrent(preparationToken, { schemaKey: args.schemaKey, schemaSignature, modelUri: args.modelKey })) {
		markSchemaEnhancementPending(preparationToken.boxId, args.schemaKey, schemaSignature, args.modelKey, preparationToken);
	}
	__kustoSchemaEnhancementPendingByModelSchemaKey.add(enhancementKey);
	const ownsToken = () => __kustoSchemaEnhancementTokenByModelSchemaKey[enhancementKey] === token;
	const clearOwnedPending = () => {
		if (!ownsToken()) return false;
		delete __kustoSchemaEnhancementTokenByModelSchemaKey[enhancementKey];
		__kustoSchemaEnhancementPendingByModelSchemaKey.delete(enhancementKey);
		return true;
	};
	const cancelOwned = () => {
		if (!clearOwnedPending()) return;
		if (preparationToken) markSchemaEnhancementCanceled(preparationToken.boxId, args.schemaKey, schemaSignature, args.modelKey, preparationToken);
	};
	const isCurrent = () => {
		try {
			return ownsToken()
				&& (!args.contextIntent || __kustoSchemaContextIntents.isCurrent(args.contextIntent))
				&& (args.isCurrent ? args.isCurrent() : !!__kustoSchemaTracker.loadedSchemasByModel[args.modelKey]?.[args.schemaKey]);
		} catch {
			return false;
		}
	};
	const isDesiredContextCurrent = () => {
		if (!args.setAsContext) {
			return true;
		}
		try {
			const boxId = queryEditorBoxByModelUri?.[args.modelKey] || '';
			if (!boxId) {
				return false;
			}
			const context = __kustoGetSchemaContextForBox(boxId);
			return !!context && context.schemaKey === args.schemaKey;
		} catch {
			return false;
		}
	};
	traceFileOpen('monaco.schema.enhance.scheduled', { schemaId: kustoSupplementalTraceId(args.schemaKey), modelId: kustoSupplementalTraceId(args.modelKey) });
	void __kustoYieldForSchemaEnhancement().then(async () => {
		if (!isCurrent()) {
			cancelOwned();
			traceFileOpen('monaco.schema.enhance.canceledBeforeStart', { schemaKey: args.schemaKey, modelKey: args.modelKey });
			return;
		}
		traceFileOpen('monaco.schema.enhance.start', { schemaKey: args.schemaKey, modelKey: args.modelKey });
		const result = await enhanceKustoFunctionBodiesForSchemaChunked(args.schemaObj, {
			shouldContinue: isCurrent,
			maxBatchSize: 25,
			maxSliceMs: 6,
			yieldFn: __kustoYieldForSchemaEnhancement,
		});
		traceFileOpen('monaco.schema.enhance.done', { schemaKey: args.schemaKey, modelKey: args.modelKey, ...result });
		if (result.canceled || result.enhancedCount === 0 || !isCurrent()) {
			if (!result.canceled && result.enhancedCount === 0 && isCurrent() && clearOwnedPending() && preparationToken && isKustoPreparationCurrent(preparationToken)) {
				markSchemaEnhancementReady(preparationToken.boxId, args.schemaKey, schemaSignature, args.modelKey, preparationToken);
			} else {
				cancelOwned();
			}
			return;
		}
		if (!args.worker || typeof args.worker.normalizeSchema !== 'function' || typeof args.worker.addDatabaseToSchema !== 'function') {
			if (!clearOwnedPending()) return;
			traceFileOpen('monaco.schema.enhance.skip.workerMissingApis', { schemaKey: args.schemaKey, modelKey: args.modelKey });
			if (preparationToken && isKustoPreparationCurrent(preparationToken)) {
				markSchemaEnhancementFailed(preparationToken.boxId, args.schemaKey, schemaSignature, args.modelKey, preparationToken);
			}
			return;
		}
		const queuedMutation = __kustoWorkerMutations.enqueueLeased({
			request: { kind: 'enhancement' },
			timeoutMs: KUSTO_SCHEMA_ENHANCEMENT_TIMEOUT_MS,
			run: async transaction => {
			const canMutate = () => transaction.isActive() && isCurrent() && isDesiredContextCurrent();
			if (!canMutate()) {
				cancelOwned();
				traceFileOpen('monaco.schema.enhance.canceledBeforeMutation', { schemaKey: args.schemaKey, modelKey: args.modelKey });
				return false;
			}
			try {
				traceFileOpen('monaco.schema.enhance.normalize.start', { schemaKey: args.schemaKey, modelKey: args.modelKey });
				const schemaForWorker = stampKustoSchemaMajorVersion(prepareKustoSchemaForWorkerFast(args.schemaObj), transaction.id);
				const engineSchema = await args.worker.normalizeSchema(schemaForWorker, args.clusterUrl, args.databaseInContext);
				if (!canMutate()) {
					cancelOwned();
					return false;
				}
				let databaseSchema = engineSchema?.database;
				if (!databaseSchema && engineSchema?.cluster?.databases) {
					databaseSchema = engineSchema.cluster.databases.find((db: any) => db.name.toLowerCase() === args.databaseInContext.toLowerCase());
				}
				traceFileOpen('monaco.schema.enhance.normalize.done', { schemaKey: args.schemaKey, modelKey: args.modelKey, hasDatabaseSchema: !!databaseSchema });
				if (!databaseSchema || !canMutate()) {
					return false;
				}
				traceFileOpen('monaco.schema.enhance.addDatabase.start', { schemaKey: args.schemaKey, modelKey: args.modelKey });
				await args.worker.addDatabaseToSchema(args.modelKey, args.clusterUrl, databaseSchema);
				if (!canMutate()) {
					cancelOwned();
					return false;
				}
				if (!transaction.commit()) {
					cancelOwned();
					return false;
				}
				traceFileOpen('monaco.schema.enhance.addDatabase.done', { schemaKey: args.schemaKey, modelKey: args.modelKey });
				if (!canMutate()) {
					cancelOwned();
					return false;
				}
				__kustoSchemaTracker.schemaCache[args.schemaKey] = {
					rawSchemaJson: args.schemaObj,
					clusterUrl: args.clusterUrl,
					database: args.databaseInContext,
					connectionId: args.connectionId,
					accountPartition: args.accountPartition,
				};
				try {
					await __kustoAddDatabaseAliasesToWorker(args.worker, args.modelKey, args.schemaObj, args.clusterName || args.clusterUrl, args.clusterUrl, args.databaseInContext, transaction, canMutate);
					if (!canMutate()) {
						cancelOwned();
						return false;
					}
				} catch (error) {
					traceFileOpen('monaco.schema.enhance.aliasesFailed', { schemaKey: args.schemaKey, modelKey: args.modelKey, error: error instanceof Error ? error.message : String(error) });
				}
				try {
					const enhancedBoxId = queryEditorBoxByModelUri?.[args.modelKey] || '';
					if (enhancedBoxId && typeof __kustoTriggerRevalidation === 'function' && canMutate()) {
						__kustoTriggerRevalidation(enhancedBoxId);
						traceFileOpen('monaco.schema.enhance.revalidationTriggered', { schemaKey: args.schemaKey, modelKey: args.modelKey, boxId: enhancedBoxId });
					}
				} catch (error) {
					traceFileOpen('monaco.schema.enhance.revalidationFailed', { schemaKey: args.schemaKey, modelKey: args.modelKey, error: error instanceof Error ? error.message : String(error) });
				}
				return true;
			} catch (error) {
				traceFileOpen('monaco.schema.enhance.error', { schemaKey: args.schemaKey, modelKey: args.modelKey, error: error instanceof Error ? error.message : String(error) });
				return false;
			}
		},
			onTimeout: () => {
				cancelOwned();
				traceFileOpen('monaco.schema.enhance.timeout', { schemaKey: args.schemaKey, modelKey: args.modelKey });
			},
			onDetachedSettled: async recoveryTransaction => {
				const boxId = String(queryEditorBoxByModelUri?.[args.modelKey] || '');
				await __kustoRecoverPrimarySchemaAfterDetachedMutation(recoveryTransaction, boxId, 'enhancement-timeout');
				traceFileOpen('monaco.schema.enhance.detachedSettledRecovery', { schemaKey: args.schemaKey, modelKey: args.modelKey, boxId });
			},
		});
		const lease = await queuedMutation;
		const enhanced = lease.status === 'completed' && lease.value;
		const terminalIsCurrent = isCurrent() && isDesiredContextCurrent();
		if (!clearOwnedPending()) return;
		if (preparationToken && isKustoPreparationCurrent(preparationToken)) {
			if (enhanced) markSchemaEnhancementReady(preparationToken.boxId, args.schemaKey, schemaSignature, args.modelKey, preparationToken);
			else if (terminalIsCurrent) markSchemaEnhancementFailed(preparationToken.boxId, args.schemaKey, schemaSignature, args.modelKey, preparationToken);
		} else if (preparationToken) {
			markSchemaEnhancementCanceled(preparationToken.boxId, args.schemaKey, schemaSignature, args.modelKey, preparationToken);
		}
	}).catch((error: unknown) => {
		if (!clearOwnedPending()) return;
		traceFileOpen('monaco.schema.enhance.unhandledError', { schemaKey: args.schemaKey, modelKey: args.modelKey, error: error instanceof Error ? error.name : 'Error' });
		if (preparationToken && isKustoPreparationCurrent(preparationToken)) {
			markSchemaEnhancementFailed(preparationToken.boxId, args.schemaKey, schemaSignature, args.modelKey, preparationToken);
		} else if (preparationToken) {
			markSchemaEnhancementCanceled(preparationToken.boxId, args.schemaKey, schemaSignature, args.modelKey, preparationToken);
		}
	});
	return true;
}

export function __kustoRetryPrimarySchemaEnhancement(args: {
	boxId: string;
	rawSchemaJson: any;
	clusterUrl: string;
	database: string;
	connectionId: string;
	accountPartition: string;
	schemaKey: string;
	modelUri: string;
}): boolean {
	const boxId = String(args.boxId || '');
	const modelUri = String(args.modelUri || '');
	const schemaKey = String(args.schemaKey || '');
	if (!boxId || !modelUri || !schemaKey || !args.rawSchemaJson
		|| !isSchemaWorkerReady(boxId, schemaKey, modelUri)
		|| __kustoGetSchemaContextForBox(boxId)?.schemaKey !== schemaKey) {
		return false;
	}
	const enhancementKey = `${modelUri}|${schemaKey}`;
	if (__kustoSchemaEnhancementPendingByModelSchemaKey.has(enhancementKey)) return false;
	const preparationToken = getKustoPreparationToken(boxId);
	if (!preparationToken || !isKustoPreparationCurrent(preparationToken, { schemaKey, modelUri })) return false;
	const schemaSignature = getKustoPreparationState(boxId).target.schemaSignature;
	const expectedModel = __kustoSupplementalModelForUri(modelUri);
	if (!expectedModel || expectedModel.isDisposed?.()) return false;
	const acquisitionToken = ++__kustoSchemaEnhancementToken;
	__kustoSchemaEnhancementTokenByModelSchemaKey[enhancementKey] = acquisitionToken;
	__kustoSchemaEnhancementPendingByModelSchemaKey.add(enhancementKey);
	const isRetryEnvironmentCurrent = () => isKustoPreparationCurrent(preparationToken, { schemaKey, schemaSignature, modelUri })
		&& __kustoSupplementalModelForUri(modelUri) === expectedModel
		&& !expectedModel.isDisposed?.()
		&& isSchemaWorkerReady(boxId, schemaKey, modelUri)
		&& __kustoGetSchemaContextForBox(boxId)?.schemaKey === schemaKey;
	const ownsAcquisition = () => __kustoSchemaEnhancementTokenByModelSchemaKey[enhancementKey] === acquisitionToken
		&& __kustoSchemaEnhancementPendingByModelSchemaKey.has(enhancementKey)
		&& isRetryEnvironmentCurrent();
	let scheduled = false;
	void (async () => {
		try {
			if (!monaco?.languages?.kusto?.getKustoWorker || !ownsAcquisition()) return;
			const accessorLease = await raceSupplementalOperationLease(
				Promise.resolve(monaco.languages.kusto.getKustoWorker()),
				KUSTO_SCHEMA_ENHANCEMENT_TIMEOUT_MS,
			);
			if (accessorLease.status === 'timed-out' || !ownsAcquisition()) return;
			const workerLease = await raceSupplementalOperationLease(
				Promise.resolve(accessorLease.value(expectedModel.uri)),
				KUSTO_SCHEMA_ENHANCEMENT_TIMEOUT_MS,
			);
			if (workerLease.status === 'timed-out' || !workerLease.value || !ownsAcquisition()) return;
			scheduled = __kustoScheduleEnhancedSchemaApply({
				worker: workerLease.value,
				schemaObj: args.rawSchemaJson,
				clusterUrl: args.clusterUrl,
				database: args.database,
				connectionId: args.connectionId,
				accountPartition: args.accountPartition,
				databaseInContext: args.database,
				schemaKey,
				modelKey: modelUri,
				setAsContext: false,
				isCurrent: isRetryEnvironmentCurrent,
				preparationToken,
				expectedOwnerToken: acquisitionToken,
			});
			if (scheduled) traceFileOpen('monaco.schema.enhance.retryScheduled', { schemaKey, modelUri });
		} catch (error) {
			traceFileOpen('monaco.schema.enhance.retryScheduleFailed', { schemaKey, modelUri, errorType: error instanceof Error ? error.name : 'Error' });
		} finally {
			if (!scheduled && __kustoSchemaEnhancementTokenByModelSchemaKey[enhancementKey] === acquisitionToken) {
				delete __kustoSchemaEnhancementTokenByModelSchemaKey[enhancementKey];
				__kustoSchemaEnhancementPendingByModelSchemaKey.delete(enhancementKey);
				markSchemaEnhancementCanceled(boxId, schemaKey, schemaSignature, modelUri, preparationToken);
			}
		}
	})();
	return true;
}
let __kustoExtractStatementTextAtCursor: ((editor: any) => string | null) | null = null;
const KUSTO_MARKER_BLUR_CLEAR_DELAY_MS = 150;
const __kustoMarkerBlurClearTimers: Record<string, any> = {};

// Exported module-level lets for cross-module ES imports (lazily assigned inside require callback).
export let __kustoAutoFindInQueryEditor: ((boxId: any, term: any) => Promise<boolean>) | null = null;
let __kustoAutoFindStateByBoxId: Record<string, any> = {};

// Module-level state variables — converted from _win.__kusto* window bridges.
// Group A: Internal state (only used within monaco.ts)
let __kustoMarkersEnabledModels: Set<string> = new Set();
let __kustoPublishExactKustoMarkers: ((model: any, markers: any[]) => void) | null = null;
let __kustoModelClusterMap: Record<string, string> = {};
let __kustoMonacoDatabaseInContextByModel: Record<string, { clusterUrl: string; database: string; connectionId: string; accountPartition: string; schemaKey: string } | null> = {};
let __kustoMonacoInitializedByModel: Record<string, boolean> = {};
const __kustoAutocompleteTraceByModelUri: Record<string, string> = {};

function __kustoQueueAutocompleteRetryForPrimarySchema(request: KustoAutocompleteRetryRequest | undefined, ed: any, boxId: string, schemaKey: string): boolean {
	try {
		if (!request || !ed || !boxId || !schemaKey) return false;
		const modelUri = ed?.getModel?.()?.uri?.toString?.() || '';
		const queued = __kustoAutocompleteRetryCoordinator.queue(request, {
			ready: waitForSchemaWorkerReady(boxId, schemaKey, CROSS_CLUSTER_SCHEMA_AUTOCOMPLETE_RETRY_WAIT_MS, modelUri || undefined, request.signal),
			onSettled: () => __kustoSetAutocompleteRetryPending(ed, false),
			trigger: () => {
				if (typeof __kustoTriggerAutocompleteInternal !== 'function') return false;
				tryHideSuggestWidget(ed);
				return __kustoTriggerAutocompleteInternal(ed);
			},
			fallback: () => ed?.trigger?.('keyboard', 'editor.action.triggerSuggest', {}),
		});
		if (queued) __kustoSetAutocompleteRetryPending(ed, true);
		return queued;
	} catch (e) { console.error('[kusto]', e); }
	return false;
}

function tryHideSuggestWidget(ed: any): void {
	try { ed?.trigger?.('keyboard', 'hideSuggestWidget', {}); } catch (e) { console.error('[kusto]', e); }
}

function __kustoGetAutocompleteTraceIdForModel(modelUri: any): string {
	const modelKey = String(modelUri || '');
	const traceId = modelKey ? __kustoAutocompleteTraceByModelUri[modelKey] : '';
	return traceId || getActiveAutocompleteTraceId();
}

function __kustoColumnNamesFromSchemaEntity(entity: any): string[] {
	return getKustoColumnNamesFromSchemaEntity(entity);
}

function __kustoResolveRawSchemaEntityColumns(rawSchemaJson: any, database: string, entityName: string): string[] {
	return resolveKustoRawSchemaEntityColumns(rawSchemaJson, database, entityName);
}

function __kustoFindRawSchemaEntity(rawSchemaJson: any, database: string, entityName: string): any {
	return findKustoRawSchemaEntity(rawSchemaJson, database, entityName);
}

function __kustoResolveRawSchemaEntityColumnsDeep(rawSchemaJson: any, database: string, entityName: string, seen: Set<string> = new Set()): string[] {
	return resolveKustoRawSchemaEntityColumnsDeep(rawSchemaJson, database, entityName, seen);
}

function __kustoInferRawFunctionBodyColumns(rawSchemaJson: any, database: string, body: any, seen: Set<string> = new Set()): string[] {
	return inferKustoRawFunctionBodyColumns(rawSchemaJson, database, body, seen);
}

function __kustoFindLoadedRawSchemaForColumnCompletions(clusterName: string, database: string, modelUri: string): any {
	try {
		const key = __kustoGetCrossClusterSchemaKey(clusterName, database);
		const state = key ? __kustoSupplementalCoordinator.getState(modelUri, key) : undefined;
		if (key && state && state.status !== 'failed' && state.fetchedAvailable && __kustoCrossClusterSchemas?.[key]?.rawSchemaJson) {
			return __kustoCrossClusterSchemas[key].rawSchemaJson;
		}
	} catch (e) { console.error('[kusto]', e); }
	return null;
}

function __kustoSyntheticBodyForColumnNames(columns: string[]): string {
	return syntheticKustoFunctionBodyForColumnNames(columns);
}

function __kustoEnsureInferredFunctionBodiesForSchema(schemaObj: any): any {
	return prepareKustoSchemaForWorkerFull(schemaObj);
}

function __kustoPrepareSchemaForKustoWorker(schemaObj: any): any {
	return prepareKustoSchemaForWorkerFast(schemaObj);

}

function __kustoPrepareSchemaForKustoWorkerFull(schemaObj: any): any {
	return __kustoEnsureInferredFunctionBodiesForSchema(schemaObj);
}

function __kustoApplyColumnPipelineStages(columns: string[], stages: string[]): string[] {
	return applyKustoColumnPipelineStages(columns, stages);
}

function __kustoTextOffsetAtPosition(model: any, position: any): number {
	try {
		if (typeof model?.getOffsetAt === 'function') {
			return Number(model.getOffsetAt(position)) || 0;
		}
		const fullText = String(model?.getValue?.() || '');
		const lines = fullText.split(/\r?\n/);
		let offset = 0;
		for (let line = 1; line < Number(position?.lineNumber || 1); line++) {
			offset += (lines[line - 1] || '').length + 1;
		}
		return offset + Math.max(0, Number(position?.column || 1) - 1);
	} catch {
		return 0;
	}
}

function __kustoColumnCompletionsForModel(model: any, position: any): string[] {
	try {
		const modelUri = model?.uri?.toString?.() || '';
		const boxId = modelUri ? queryEditorBoxByModelUri[modelUri] : '';
		if (!boxId || !position || typeof model.getValue !== 'function') return [];
		const fullText = String(model.getValue() || '');
		const offset = __kustoTextOffsetAtPosition(model, position);
		const statementStart = __kustoGetStatementStartAtOffset(fullText, offset);
		const before = fullText.slice(statementStart, offset);
		const pipeline = __kustoGetColumnCompletionPipelineContext(before);
		const operator = pipeline?.operator || '';
		const operatorTail = pipeline?.operatorTail || '';
		if (!operator || /^(take|limit)$/.test(operator)) {
			return [];
		}
		if (operator === 'top' && !/\bby\b/i.test(operatorTail)) {
			return [];
		}
		if (!/^(where|filter|project|project-away|project-keep|project-rename|project-reorder|extend|summarize|distinct|order by|sort by|top)$/.test(operator)) {
			return [];
		}
		const sourceStage = pipeline?.sourceStage || '';
		const priorStages = pipeline?.priorStages || [];
		if (!sourceStage) return [];
		const sourceMatches = Array.from(sourceStage.matchAll(/(?:cluster\s*\(\s*(['"])(.*?)\1\s*\)\s*\.\s*)?(?:database\s*\(\s*(['"])(.*?)\3\s*\)\s*\.\s*)?([A-Za-z_][\w-]*)\s*(?:\(\s*\))?/gi));
		const sourceMatch = sourceMatches.length ? sourceMatches[sourceMatches.length - 1] : null;
		if (!sourceMatch) return [];
		const clusterName = sourceMatch[2] || '';
		const database = sourceMatch[4] || __kustoGetDatabase(boxId);
		const entityName = sourceMatch[5];
		const schema = getKustoEditorSchema(boxId);
		const context = __kustoGetSchemaContextForBox(boxId);
		let rawSchemaJson = schema?.rawSchemaJson || null;
		if (clusterName) {
			const refIsCurrent = (() => {
				try {
					const ref = extractCrossClusterRefs(`cluster('${clusterName}').database('${database}').${entityName}`, context || undefined);
					return Array.isArray(ref) && ref.length === 0;
				} catch { return false; }
			})();
			rawSchemaJson = refIsCurrent ? (schema?.rawSchemaJson || null) : __kustoFindLoadedRawSchemaForColumnCompletions(clusterName, database, modelUri);
		}
		let columns = __kustoResolveRawSchemaEntityColumns(rawSchemaJson, database, entityName);
		if (!columns.length) {
			const entity = __kustoFindRawSchemaEntity(rawSchemaJson, database, entityName);
			columns = __kustoInferRawFunctionBodyColumns(rawSchemaJson, database, entity?.Body || entity?.body || '');
		}
		recordAutocompleteTrace(__kustoGetAutocompleteTraceIdForModel(modelUri), 'supplemental-columns', {
			boxId,
			modelUri,
			schemaKey: __kustoGetCrossClusterSchemaKey(clusterName, database),
			entityName,
			hasRawSchema: !!rawSchemaJson,
			columnCount: columns.length,
		});
		return __kustoApplyColumnPipelineStages(columns, priorStages);
	} catch (e) { console.error('[kusto]', e); }
	return [];
}

export function __kustoGetColumnCompletionPipelineContext(beforeCursor: unknown): {
	operator: string;
	operatorTail: string;
	sourceStage: string;
	priorStages: string[];
} | null {
	const before = String(beforeCursor || '');
	const currentStageMatch = before.match(/\|\s*((?:order|sort)\s+by|[A-Za-z_][\w-]*)\b([^|]*)$/i);
	if (!currentStageMatch || currentStageMatch.index === undefined) return null;
	const prefix = before.slice(0, currentStageMatch.index);
	const latestAssignmentEnd = __kustoFindLatestLetAssignmentEnd(prefix);
	const pipelineStart = latestAssignmentEnd < 0 ? 0 : latestAssignmentEnd;
	const pipelineText = before.slice(pipelineStart);
	const stages = __kustoSplitPipelineStagesDeep(pipelineText)
		.map((stage: any) => String(stage || '').trim())
		.filter(Boolean);
	return {
		operator: String(currentStageMatch[1] || '').toLowerCase().replace(/\s+/g, ' '),
		operatorTail: String(currentStageMatch[2] || ''),
		sourceStage: stages[0] || '',
		priorStages: stages.slice(1, -1),
	};
}

export function __kustoFindLatestLetAssignmentEnd(value: unknown): number {
	const text = String(value || '');
	let latest = -1;
	let inLineComment = false;
	let inBlockComment = false;
	let inTripleBacktick = false;
	let currentStringQuote: "'" | '"' | undefined;
	let currentStringIsVerbatim = false;
	for (let index = 0; index < text.length; index++) {
		const char = text[index];
		const next = text[index + 1];
		if (inTripleBacktick) {
			if (text.slice(index, index + 3) === '```') { inTripleBacktick = false; index += 2; }
			continue;
		}
		if (inLineComment) {
			if (char === '\n') inLineComment = false;
			continue;
		}
		if (inBlockComment) {
			if (char === '*' && next === '/') { inBlockComment = false; index++; }
			continue;
		}
		if (currentStringQuote) {
			if (!currentStringIsVerbatim && char === '\\' && index + 1 < text.length) { index++; continue; }
			if (char === currentStringQuote) {
				if (next === currentStringQuote) { index++; continue; }
				currentStringQuote = undefined;
				currentStringIsVerbatim = false;
			}
			continue;
		}
		if (char === '/' && next === '/') { inLineComment = true; index++; continue; }
		if (char === '/' && next === '*') { inBlockComment = true; index++; continue; }
		if (text.slice(index, index + 3) === '```') { inTripleBacktick = true; index += 2; continue; }
		const stringPrefix = __kustoDetectStringPrefix(text, index);
		if (stringPrefix) {
			currentStringQuote = stringPrefix.quote;
			currentStringIsVerbatim = stringPrefix.verbatim;
			index += stringPrefix.length - 1;
			continue;
		}
		if (text.slice(index, index + 3).toLowerCase() !== 'let') continue;
		const previous = index > 0 ? text[index - 1] : '';
		const afterKeyword = text[index + 3] || '';
		if ((previous && /[A-Za-z0-9_]/.test(previous)) || !/\s/.test(afterKeyword)) continue;
		let cursor = index + 3;
		while (/\s/.test(text[cursor] || '')) cursor++;
		if (!/[A-Za-z_]/.test(text[cursor] || '')) continue;
		cursor++;
		while (/[A-Za-z0-9_-]/.test(text[cursor] || '')) cursor++;
		while (/\s/.test(text[cursor] || '')) cursor++;
		if (text[cursor] !== '=') continue;
		latest = cursor + 1;
	}
	return latest;
}

export function __kustoDetectStringPrefix(source: string, index: number): {
	quote: "'" | '"';
	length: number;
	verbatim: boolean;
} | undefined {
	const char = source[index];
	const next = source[index + 1];
	const third = source[index + 2];
	const isQuote = (value: string | undefined): value is "'" | '"' => value === "'" || value === '"';
	if (char === '@' && isQuote(next)) return { quote: next, length: 2, verbatim: true };
	if (char === 'h' || char === 'H') {
		if (next === '@' && isQuote(third)) return { quote: third, length: 3, verbatim: true };
		if (isQuote(next)) return { quote: next, length: 2, verbatim: false };
	}
	if (isQuote(char)) return { quote: char, length: 1, verbatim: false };
	return undefined;
}

export function __kustoSetCustomColumnCompletionProviderEnabledForTest(modelUri: string, enabled: boolean): boolean {
	const key = String(modelUri || '');
	if (document.body.dataset.kustoE2eEnabled !== 'true' || !key) return true;
	if (enabled) __kustoCustomColumnCompletionProviderDisabledModels.delete(key);
	else __kustoCustomColumnCompletionProviderDisabledModels.add(key);
	return !__kustoCustomColumnCompletionProviderDisabledModels.has(key);
}

function __kustoSupplementalCompletionDecisionForModel(model: any, position: any): {
	allow: boolean;
	reason: string;
	boxId: string;
	modelUri: string;
	primaryReady: boolean;
	enhancementPending: boolean;
	refsCount: number;
	missingCrossClusterCount: number;
} {
	const modelUri = model?.uri?.toString?.() || '';
	const boxId = modelUri ? String(queryEditorBoxByModelUri?.[modelUri] || '') : '';
	try {
		if (!modelUri || !boxId || !position) {
			const decision = decideKustoSupplementalCompletionPolicy({
				hasModelUri: !!modelUri,
				hasBoxId: !!boxId,
				hasPrimarySchema: false,
				primaryReady: false,
				schemaSignatureMatches: false,
				hasPendingWorkerUpdate: false,
				enhancementPending: false,
				missingCrossClusterCount: 0,
			});
			return { ...decision, boxId, modelUri, primaryReady: false, enhancementPending: false, refsCount: 0, missingCrossClusterCount: 0 };
		}
		const context = __kustoGetSchemaContextForBox(boxId);
		const schema = getKustoEditorSchema(boxId) || null;
		const schemaMeta = getKustoSchemaMetadata(boxId) || {};
		const schemaKey = context?.schemaKey || '';
		const readyState = getSchemaWorkerReadyState(boxId);
		const primaryReady = !!(schemaKey && isSchemaWorkerReady(boxId, schemaKey, modelUri));
		const schemaSignature = typeof schemaMeta.schemaSignature === 'string' ? String(schemaMeta.schemaSignature) : '';
		const schemaSignatureMatches = !schemaSignature || (readyState?.schemaSignature === schemaSignature && readyState?.schemaKey === schemaKey && readyState?.modelUri === modelUri);
		const pendingWorkerUpdate = getPendingSchemaWorkerUpdate(boxId);
		const hasPendingWorkerUpdate = !!(pendingWorkerUpdate && (!schemaKey || pendingWorkerUpdate.schemaKey === schemaKey));
		let enhancementPending = !!(schemaKey && __kustoSchemaEnhancementPendingByModelSchemaKey.has(`${modelUri}|${schemaKey}`));
		let refsCount = 0;
		let missingCrossClusterCount = 0;
		if (typeof model.getValue === 'function') {
			const queryText = __kustoExtractAutocompleteSchemaScopeTextForModelPosition(model, position);
			const refs = (typeof __kustoExtractCrossClusterRefs === 'function')
				? __kustoExtractCrossClusterRefs(queryText, context || undefined)
				: extractCrossClusterRefs(queryText, context || undefined);
			refsCount = Array.isArray(refs) ? refs.length : 0;
			const keys: string[] = [];
			for (const ref of refs || []) {
				try {
					const clusterName = __kustoResolveCrossClusterNameForRef(ref, boxId, context);
					const database = String(ref?.database || '').trim();
					const key = __kustoGetCrossClusterSchemaKey(clusterName, database);
					if (key && !keys.includes(key)) keys.push(key);
				} catch (e) { console.error('[kusto]', e); }
			}
			missingCrossClusterCount = keys.filter(key => !__kustoIsCrossClusterSchemaLoadedForModel(key, modelUri)).length;
			enhancementPending = enhancementPending || keys.some(key => __kustoSchemaEnhancementPendingByModelSchemaKey.has(`${modelUri}|${key}`));
		}
		const decision = decideKustoSupplementalCompletionPolicy({
			hasModelUri: !!modelUri,
			hasBoxId: !!boxId,
			hasPrimarySchema: !!schema?.rawSchemaJson,
			primaryReady,
			schemaSignatureMatches,
			hasPendingWorkerUpdate,
			enhancementPending,
			missingCrossClusterCount,
		});
		return { ...decision, boxId, modelUri, primaryReady, enhancementPending, refsCount, missingCrossClusterCount };
	} catch (e) {
		console.error('[kusto]', e);
		const allow = !!(modelUri && boxId);
		return { allow, reason: 'decision-error', boxId, modelUri, primaryReady: false, enhancementPending: false, refsCount: 0, missingCrossClusterCount: 0 };
	}
}

function __kustoClearAutocompleteTraceForModel(modelUri: any, traceId?: string): void {
	const modelKey = String(modelUri || '');
	if (!modelKey) return;
	if (!traceId || __kustoAutocompleteTraceByModelUri[modelKey] === traceId) {
		delete __kustoAutocompleteTraceByModelUri[modelKey];
	}
}

function __kustoClearAutocompleteTraceId(traceId: string): void {
	if (!traceId) return;
	for (const [modelUri, activeTraceId] of Object.entries(__kustoAutocompleteTraceByModelUri)) {
		if (activeTraceId === traceId) {
			delete __kustoAutocompleteTraceByModelUri[modelUri];
		}
	}
}

let __kustoMonacoModelDisposeHookInstalled = false;
let __kustoCrossClusterCheckTimeout: Record<string, any> = {};
let __kustoCrossClusterApplyTimeout: Record<string, any> = {};
const __kustoSupplementalQueuedApplyJobs = new Set<string>();
const __kustoSupplementalApplyingSchemaKeys = new Set<string>();
let __kustoLastCrossClusterInteractionAtByBoxId: Record<string, number> = {};
let __kustoCrossClusterPointerDownByBoxId: Record<string, boolean> = {};
let __kustoSupplementalDeadlineTimer: number | undefined;
let __kustoSupplementalPumpTimer: number | undefined;
let __kustoSupplementalPumpDueAt: number | undefined;
let __kustoSupplementalRevalidationSequenceByModel: Record<string, number> = {};
let __kustoSupplementalRevalidationTimeoutByModel: Record<string, number> = {};
const __kustoForcePrimaryReplaceByBoxId = new Set<string>();
let __kustoWorkerInitialized = false;
let __kustoWorkerNeedsSchemaReload = false;
let __kustoLastFocusedBoxId: string | null = null;
let __kustoCaretDocsLastHtmlByBoxId: Record<string, string> = {};
let __kustoWebviewHasFocus = true;
let __kustoWebviewFocusListenersInstalled = false;
let __kustoCaretDocsViewportListenersInstalled = false;
let __kustoLastMonacoInteractionAt = 0;
let __kustoSchemaClearGeneration = 0;
// Group B: Cross-module state (exported for consumers in other modules)
// Control command doc cache + generated functions merged: authoritative source in monaco-caret-docs.ts
export { __kustoControlCommandDocCache, __kustoControlCommandDocPending } from './caret-docs';
export { __kustoGeneratedFunctionsMerged, setGeneratedFunctionsMerged } from './caret-docs';
type KustoSupplementalBrokerEntry = {
	status: 'pending' | 'loaded' | 'error';
	requestToken?: string;
	requestSource?: KustoSupplementalRequestSource;
	deadlineAt?: number;
	revision?: number;
	workerAppliedRevision?: number;
	workerAppliedEpoch?: number;
	rawSchemaJson?: any;
	clusterUrl?: string;
	deliverySource?: string;
	cacheAgeMs?: number;
	failureKind?: KustoSupplementalFailureKind;
	error?: string;
};

export let __kustoCrossClusterSchemas: Record<string, KustoSupplementalBrokerEntry | undefined> = {};
export let __kustoMonacoInitRetryCountByBoxId: Record<string, number> = {};
const __kustoMonacoInitRetryTimerByBoxId: Record<string, ReturnType<typeof setTimeout> | undefined> = {};

export function __kustoCancelMonacoInitRetry(boxId: string): void {
	const id = String(boxId || '');
	const timer = __kustoMonacoInitRetryTimerByBoxId[id];
	if (timer !== undefined) clearTimeout(timer);
	delete __kustoMonacoInitRetryTimerByBoxId[id];
	delete __kustoMonacoInitRetryCountByBoxId[id];
}

const __kustoCrossClusterTrace: Array<Record<string, any>> = [];

const __kustoSupplementalCoordinator = new KustoSupplementalSchemaCoordinator((event) => {
	__kustoTraceCrossCluster(`supplemental.${event.event}`, event);
});
export function invalidateKustoSchemaIdentityState(): void {
	__kustoSchemaClearGeneration++;
	__kustoSchemaTracker.globalInitialized = false;
	__kustoSchemaTracker.loadedSchemas = {};
	__kustoSchemaTracker.loadedSchemasByModel = {};
	__kustoSchemaTracker.databaseInContext = null;
	__kustoSchemaTracker.schemaCache = {};
	__kustoSchemaContextIntents.clear();
	__kustoMonacoDatabaseInContextByModel = {};
	__kustoMonacoInitializedByModel = {};
	invalidateSchemaWorkerReadiness();
	for (const modelUri of new Set(__kustoSupplementalCoordinator.getAllStates().map(state => state.modelUri))) {
		__kustoSupplementalCoordinator.disposeModel(modelUri);
	}
	__kustoCrossClusterSchemas = {};
	void __kustoWorkerMutations.enqueue({ kind: 'identity-clear', advancesPrimaryIntent: true }, async transaction => {
		if (!transaction.isActive()) return;
		if (!monaco?.languages?.kusto?.getKustoWorker) return;
		const workerAccessor = await monaco.languages.kusto.getKustoWorker();
		for (const model of monaco.editor.getModels?.() || []) {
			try {
				if (!transaction.isActive()) return;
				const worker = await workerAccessor(model.uri);
				if (transaction.isActive() && worker?.setSchema) {
					await worker.setSchema({ cluster: { connectionString: '', databases: [] } });
					transaction.commit({ destructive: true });
				}
			} catch { /* best effort */ }
		}
	}).catch(() => undefined);
}

function __kustoSanitizeTraceDetail(detail: Record<string, any>): Record<string, any> {
	const out: Record<string, any> = {};
	const allowedStringKeys = new Set([
		'event', 'status', 'previousStatus', 'requestSource', 'deliverySource', 'failureKind',
		'reason', 'stage', 'source', 'modelId', 'schemaId', 'requestId', 'boxId',
	]);
	for (const [key, value] of Object.entries(detail || {})) {
		if (key === 'rawSchemaJson' || key === 'schemaObj' || key === 'queryText' || key === 'aliases' || key === 'clusterAliases') continue;
		if (key === 'requestToken' && value) {
			out.requestId = kustoSupplementalTraceId(String(value));
			continue;
		}
		if ((key === 'modelUri' || key === 'modelKey') && value) {
			out.modelId = kustoSupplementalTraceId(String(value));
			continue;
		}
		if ((key === 'boxId' || key === 'connectionId') && value) {
			out[`${key}Ref`] = kustoSupplementalTraceId(String(value));
			continue;
		}
		if ((key === 'schemaKey' || key === 'key') && value) {
			out.schemaId = kustoSupplementalTraceId(String(value));
			continue;
		}
		if ((key === 'clusterName' || key === 'clusterUrl') && value) {
			out.clusterId = kustoSupplementalTraceId(String(value));
			continue;
		}
		if (key === 'database' && value) {
			out.databaseId = kustoSupplementalTraceId(String(value));
			continue;
		}
		if (key === 'error') {
			continue;
		}
		if (Array.isArray(value)) {
			out[`${key}Count`] = value.length;
			continue;
		}
		if (typeof value === 'string') {
			if (allowedStringKeys.has(key)) out[key] = value.length > 120 ? `${value.slice(0, 117)}...` : value;
			continue;
		}
		if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) out[key] = value;
	}
	return out;
}

export function __kustoTraceCrossCluster(event: string, detail: Record<string, any> = {}): void {
	try {
		const safeDetail = __kustoSanitizeTraceDetail(detail);
		__kustoCrossClusterTrace.push({
			at: Date.now(),
			perf: typeof performance !== 'undefined' && performance.now ? Math.round(performance.now()) : 0,
			event,
			...safeDetail,
		});
		while (__kustoCrossClusterTrace.length > 400) {
			__kustoCrossClusterTrace.shift();
		}
	} catch (e) { console.error('[kusto]', e); }
}

export function __kustoGetCrossClusterTrace(): Array<Record<string, any>> {
	return __kustoCrossClusterTrace.slice();
}

export function __kustoClearCrossClusterTrace(): void {
	__kustoCrossClusterTrace.length = 0;
}

export function __kustoGetSupplementalSchemaSnapshot(modelUri?: string): Array<Record<string, unknown>> {
	const states = modelUri
		? __kustoSupplementalCoordinator.getStatesForModel(String(modelUri || ''))
		: __kustoSupplementalCoordinator.getAllStates();
	return states.map(state => ({
		modelId: kustoSupplementalTraceId(state.modelUri),
		schemaId: kustoSupplementalTraceId(state.schemaKey),
		status: state.status,
		requestSource: state.requestSource,
		failureKind: state.failureKind ?? null,
		fetchedAvailable: state.fetchedAvailable,
		referenceGeneration: state.referenceGeneration,
		modelVersion: state.modelVersion,
	}));
}

const CROSS_CLUSTER_SCHEMA_CONTENT_CHECK_DELAY_MS = 500;
const CROSS_CLUSTER_SCHEMA_FOCUS_CHECK_DELAY_MS = 1500;
const CROSS_CLUSTER_SCHEMA_MIN_IDLE_MS = 1200;
const CROSS_CLUSTER_SCHEMA_APPLY_MIN_IDLE_MS = 1200;
const CROSS_CLUSTER_SCHEMA_IDLE_RETRY_FLOOR_MS = 100;
const CROSS_CLUSTER_SCHEMA_AUTOCOMPLETE_WAIT_MS = 1200;
const CROSS_CLUSTER_SCHEMA_BACKGROUND_FETCH_TIMEOUT_MS = 15_000;
const CROSS_CLUSTER_SCHEMA_AUTOCOMPLETE_FETCH_TIMEOUT_MS = 30_000;
const CROSS_CLUSTER_SCHEMA_APPLY_TIMEOUT_MS = 12_000;
const CROSS_CLUSTER_SCHEMA_AUTOCOMPLETE_RETRY_WAIT_MS = CROSS_CLUSTER_SCHEMA_AUTOCOMPLETE_FETCH_TIMEOUT_MS
	+ CROSS_CLUSTER_SCHEMA_APPLY_TIMEOUT_MS
	+ CROSS_CLUSTER_SCHEMA_AUTOCOMPLETE_WAIT_MS;
const CROSS_CLUSTER_SCHEMA_AUTOCOMPLETE_DEMAND_MS = CROSS_CLUSTER_SCHEMA_AUTOCOMPLETE_RETRY_WAIT_MS;
const CROSS_CLUSTER_SCHEMA_MAX_REFERENCES_PER_MODEL = 16;
const CROSS_CLUSTER_SCHEMA_MAX_BACKGROUND_FETCHES = 4;

export function __kustoLimitSupplementalReferences<T>(references: readonly T[]): T[] {
	return Array.from(references || []).slice(0, CROSS_CLUSTER_SCHEMA_MAX_REFERENCES_PER_MODEL);
}

function __kustoSupplementalFailureFromUnknown(value: unknown): KustoSupplementalFailureKind {
	const normalized = String(value || '').trim();
	if (normalized === 'missing-connection' || normalized === 'auth-required' || normalized === 'not-found'
		|| normalized === 'fetch-timeout' || normalized === 'fetch-failed' || normalized === 'invalid-schema'
		|| normalized === 'apply-timeout' || normalized === 'apply-failed') {
		return normalized;
	}
	return 'fetch-failed';
}

function __kustoSupplementalModelForUri(modelUri: string): any | null {
	try {
		return monaco?.editor?.getModels?.().find((model: any) => model?.uri?.toString?.() === modelUri) || null;
	} catch {
		return null;
	}
}

function __kustoSupplementalMarkerSeverity(severity: unknown): number {
	const value = Number(severity);
	if (value === 1) return monaco.MarkerSeverity.Error;
	if (value === 2) return monaco.MarkerSeverity.Warning;
	if (value === 3) return monaco.MarkerSeverity.Info;
	if (value === 4) return monaco.MarkerSeverity.Hint;
	return monaco.MarkerSeverity.Info;
}

async function __kustoRevalidateSupplementalModel(modelUri: string, reason: string): Promise<boolean> {
	const model = __kustoSupplementalModelForUri(modelUri);
	if (!model || model.isDisposed?.() || !monaco?.languages?.kusto?.getKustoWorker) return false;
	if (!__kustoIsSupplementalPrimaryReady(modelUri)) {
		__kustoTraceCrossCluster('revalidation.deferred-primary', { modelUri, reason });
		return false;
	}
	const version = model.getVersionId?.() || 0;
	const validationIdentity = () => {
		const boxId = String(queryEditorBoxByModelUri?.[modelUri] || '');
		const context = boxId ? __kustoGetSchemaContextForBox(boxId) : null;
		const preparation = boxId ? getKustoPreparationState(boxId) : undefined;
		const stateSignature = __kustoSupplementalCoordinator.getStatesForModel(modelUri)
			.map(state => `${state.schemaKey}:${state.referenceGeneration}:${state.status}:${__kustoCrossClusterSchemas[state.schemaKey]?.revision || 0}`)
			.sort()
			.join('|');
		const primarySchemaKey = String(context?.schemaKey || '');
		const preparationIdentity = preparation
			? `${preparation.generation}:${preparation.revision}:${preparation.status}:${preparation.target.schemaKey || ''}:${preparation.target.modelUri || ''}`
			: '';
		const workerReady = !primarySchemaKey || (boxId && isSchemaWorkerReady(boxId, primarySchemaKey, modelUri));
		return `${boxId}|${primarySchemaKey}|${preparationIdentity}|${workerReady ? 1 : 0}|${__kustoWorkerMutations.getSnapshot().committedRevision}|${stateSignature}`;
	};
	const stateSignature = validationIdentity();
	const sequence = (__kustoSupplementalRevalidationSequenceByModel[modelUri] || 0) + 1;
	__kustoSupplementalRevalidationSequenceByModel[modelUri] = sequence;
	__kustoTraceCrossCluster('revalidation.start', { modelUri, reason, sequence, stateCount: __kustoSupplementalCoordinator.getStatesForModel(modelUri).length });
	try {
		const workerAccessor = await monaco.languages.kusto.getKustoWorker();
		const worker = await workerAccessor(model.uri);
		const diagnostics = await worker.doValidation(modelUri, []);
		const currentModel = __kustoSupplementalModelForUri(modelUri);
		const currentSignature = validationIdentity();
		const superseded = __kustoSupplementalRevalidationSequenceByModel[modelUri] !== sequence;
		if (!currentModel || currentModel !== model || model.isDisposed?.()
			|| model.getVersionId?.() !== version
			|| superseded
			|| !__kustoIsSupplementalPrimaryReady(modelUri)
			|| currentSignature !== stateSignature) {
			__kustoTraceCrossCluster('revalidation.stale', { modelUri, reason, sequence });
			if (!superseded && currentModel && !currentModel.isDisposed?.()) {
				__kustoScheduleSupplementalRevalidation(modelUri, 'stale-retry');
			}
			return false;
		}
		let markers = (Array.isArray(diagnostics) ? diagnostics : []).map((diagnostic: any) => ({
			severity: __kustoSupplementalMarkerSeverity(diagnostic?.severity),
			startLineNumber: Number(diagnostic?.range?.start?.line || 0) + 1,
			startColumn: Number(diagnostic?.range?.start?.character || 0) + 1,
			endLineNumber: Number(diagnostic?.range?.end?.line || 0) + 1,
			endColumn: Number(diagnostic?.range?.end?.character || 0) + 1,
			message: String(diagnostic?.message || ''),
			code: typeof diagnostic?.code === 'number' ? String(diagnostic.code) : diagnostic?.code,
			source: diagnostic?.source,
		}));
		markers = __kustoNormalizeCollapsedMonacoMarkers(model, markers);
		const boxId = String(queryEditorBoxByModelUri?.[modelUri] || '');
		const context = boxId ? __kustoGetSchemaContextForBox(boxId) : __kustoSchemaTracker.databaseInContext;
		markers = filterResolvableCrossClusterMarkers(String(model.getValue?.() || ''), markers, {
			modelUri,
			currentContext: context || undefined,
			getOffsetAt: position => typeof model.getOffsetAt === 'function' ? model.getOffsetAt(position) : 0,
			shouldSuppressDiagnostic: (schemaKey, uri) => __kustoSupplementalCoordinator.shouldSuppressDiagnostic(uri, schemaKey),
		});
		if (__kustoPublishExactKustoMarkers) __kustoPublishExactKustoMarkers(model, markers);
		else monaco.editor.setModelMarkers(model, 'kusto', markers);
		__kustoTraceCrossCluster('revalidation.done', { modelUri, reason, sequence, markerCount: markers.length });
		return true;
	} catch (error) {
		__kustoTraceCrossCluster('revalidation.error', { modelUri, reason, sequence, errorType: error instanceof Error ? error.name : 'Error' });
		return false;
	}
}

function __kustoScheduleSupplementalRevalidation(modelUri: string, reason: string, delayMs: number = 100): void {
	const uri = String(modelUri || '');
	if (!uri) return;
	const existing = __kustoSupplementalRevalidationTimeoutByModel[uri];
	if (existing !== undefined) clearTimeout(existing);
	__kustoSupplementalRevalidationTimeoutByModel[uri] = window.setTimeout(() => {
		delete __kustoSupplementalRevalidationTimeoutByModel[uri];
		if (__kustoSupplementalModelForUri(uri)) void __kustoRevalidateSupplementalModel(uri, reason);
	}, Math.max(0, delayMs));
}

function __kustoScheduleSupplementalDeadline(): void {
	try {
		if (__kustoSupplementalDeadlineTimer !== undefined) {
			clearTimeout(__kustoSupplementalDeadlineTimer);
			__kustoSupplementalDeadlineTimer = undefined;
		}
		const deadlineAt = __kustoSupplementalCoordinator.getNextDeadlineAt();
		if (!deadlineAt) return;
		__kustoSupplementalDeadlineTimer = window.setTimeout(() => {
			__kustoSupplementalDeadlineTimer = undefined;
			const expired = __kustoSupplementalCoordinator.expire(Date.now());
			for (const state of expired) void __kustoRevalidateSupplementalModel(state.modelUri, state.failureKind || 'deadline');
			__kustoRetireOrphanedSupplementalBrokers(Date.now());
			__kustoScheduleSupplementalPump(0);
		}, Math.max(0, deadlineAt - Date.now()));
	} catch (error) {
		__kustoTraceCrossCluster('deadline.schedule.error', { errorType: error instanceof Error ? error.name : 'Error' });
	}
}

function __kustoSyncSupplementalReferencesForBox(boxId: string, requestSource: KustoSupplementalRequestSource = 'background'): KustoSupplementalSchemaState[] {
	try {
		if ((_win as any).__kustoReadOnlyMode) return [];
		const id = __kustoNormalizeCrossClusterBoxId(boxId);
		const editor = id ? queryEditors?.[id] : null;
		const model = editor?.getModel?.();
		const modelUri = model?.uri?.toString?.() || '';
		const context = __kustoGetSchemaContextForBox(id);
		if (!id || !model || !modelUri || !context?.schemaKey) return [];
		const refs = __kustoLimitSupplementalReferences(extractCrossClusterRefs(String(model.getValue?.() || ''), context))
			.map(ref => {
				const clusterName = __kustoResolveCrossClusterNameForRef(ref, id, context);
				return { schemaKey: __kustoGetCrossClusterSchemaKey(clusterName, ref.database), clusterName, database: String(ref.database || '') };
			})
			.filter(ref => !!ref.schemaKey && !!ref.clusterName && !!ref.database);
		const result = __kustoSupplementalCoordinator.syncReferences({
			boxId: id,
			modelUri,
			modelVersion: Number(model.getVersionId?.() || 0),
			primarySchemaKey: context.schemaKey,
			references: refs,
		});
		for (const state of result.added) {
			if (requestSource === 'autocomplete') __kustoSupplementalCoordinator.escalateToAutocomplete(supplementalStateIdentity(state));
		}
		for (const removed of result.removed) void __kustoRevalidateSupplementalModel(removed.modelUri, 'reference-removed');
		if (result.added.length) void __kustoRevalidateSupplementalModel(modelUri, 'reference-scheduled');
		if (result.added.length > 0 || result.removed.length > 0 || requestSource === 'autocomplete') {
			__kustoTraceCrossCluster('reference.sync.complete', {
				boxId: id,
				modelUri,
				requestSource,
				referenceCount: refs.length,
				addedCount: result.added.length,
				removedCount: result.removed.length,
				retainedCount: result.retained.length,
				truncated: refs.length >= CROSS_CLUSTER_SCHEMA_MAX_REFERENCES_PER_MODEL,
			});
		}
		return [...result.added, ...result.retained];
	} catch (error) {
		__kustoTraceCrossCluster('reference.sync.error', { boxId, requestSource, errorType: error instanceof Error ? error.name : 'Error' });
		return [];
	}
}

function __kustoScheduleSupplementalPump(delayMs: number = 0): void {
	const dueAt = Date.now() + Math.max(0, delayMs);
	if (__kustoSupplementalPumpTimer !== undefined && __kustoSupplementalPumpDueAt !== undefined) {
		if (__kustoSupplementalPumpDueAt <= dueAt) return;
		clearTimeout(__kustoSupplementalPumpTimer);
	}
	__kustoSupplementalPumpDueAt = dueAt;
	__kustoSupplementalPumpTimer = window.setTimeout(() => {
		__kustoSupplementalPumpTimer = undefined;
		__kustoSupplementalPumpDueAt = undefined;
		void __kustoPumpSupplementalSchemas();
	}, Math.max(0, dueAt - Date.now()));
}

function __kustoIsSupplementalPrimaryReady(modelUri: string, expectedSchemaKey?: string): boolean {
	const model = __kustoSupplementalModelForUri(modelUri);
	const boxId = String(queryEditorBoxByModelUri?.[modelUri] || '');
	const context = boxId ? __kustoGetSchemaContextForBox(boxId) : null;
	const preparation = boxId ? getKustoPreparationState(boxId) : undefined;
	if (model && !model.isDisposed?.() && boxId && !context?.schemaKey && !expectedSchemaKey) {
		return __kustoSupplementalCoordinator.getStatesForModel(modelUri).some(state => state.requestSource === 'autocomplete');
	}
	return !!(model && !model.isDisposed?.() && boxId && context?.schemaKey
		&& (!expectedSchemaKey || context.schemaKey === expectedSchemaKey)
		&& preparation?.status === 'ready'
		&& preparation.target.modelUri === modelUri
		&& preparation.target.schemaKey === context.schemaKey
		&& isSchemaWorkerReady(boxId, context.schemaKey, modelUri));
}

function __kustoRetireOrphanedSupplementalBrokers(now: number = Date.now()): void {
	for (const [schemaKey, broker] of Object.entries(__kustoCrossClusterSchemas)) {
		if (!broker || broker.status !== 'pending') continue;
		const requestToken = String(broker.requestToken || '');
		const hasLiveSubscriber = requestToken
			&& __kustoSupplementalCoordinator.getStatesForRequest(requestToken).some(state =>
				state.status === 'fetching' && (!state.deadlineAt || state.deadlineAt > now) && !!__kustoSupplementalModelForUri(state.modelUri));
		if (hasLiveSubscriber && (!broker.deadlineAt || broker.deadlineAt > now)) continue;
		const fallbackStates = __kustoSupplementalCoordinator.getStatesForSchemaKey(schemaKey)
			.filter(state => state.fetchedAvailable && state.status !== 'failed');
		if (broker.rawSchemaJson && fallbackStates.length > 0) {
			broker.status = 'loaded';
			broker.deadlineAt = undefined;
			broker.failureKind = undefined;
			broker.error = undefined;
			__kustoSetCrossClusterSchemaEntry(schemaKey, broker);
			__kustoTraceCrossCluster('request.retired', { schemaKey, reason: 'fallback-retained' });
			continue;
		}
		__kustoSetCrossClusterSchemaEntry(schemaKey, {
			status: 'error',
			failureKind: broker.deadlineAt && broker.deadlineAt <= now ? 'fetch-timeout' : 'fetch-failed',
			error: broker.deadlineAt && broker.deadlineAt <= now ? 'fetch-timeout' : 'fetch-failed',
		});
		__kustoTraceCrossCluster('request.retired', { schemaKey, reason: hasLiveSubscriber ? 'deadline' : 'no-subscribers' });
	}
}

function __kustoCancelSupplementalApplyJobs(modelUri: string, schemaKey?: string, referenceGeneration?: number): void {
	const prefix = `${modelUri}\u0000`;
	for (const [jobKey, timer] of Object.entries(__kustoCrossClusterApplyTimeout)) {
		if (!jobKey.startsWith(prefix)) continue;
		const [, candidateSchemaKey, candidateGeneration] = jobKey.split('\u0000');
		if (schemaKey && candidateSchemaKey !== schemaKey) continue;
		if (referenceGeneration && Number(candidateGeneration) !== referenceGeneration) continue;
		try { clearTimeout(timer); } catch { /* best effort */ }
		delete __kustoCrossClusterApplyTimeout[jobKey];
		__kustoSupplementalQueuedApplyJobs.delete(jobKey);
		__kustoSupplementalApplyingSchemaKeys.delete(candidateSchemaKey);
	}
	for (const jobKey of Array.from(__kustoSupplementalQueuedApplyJobs)) {
		if (!jobKey.startsWith(prefix)) continue;
		const [, candidateSchemaKey, candidateGeneration] = jobKey.split('\u0000');
		if (schemaKey && candidateSchemaKey !== schemaKey) continue;
		if (referenceGeneration && Number(candidateGeneration) !== referenceGeneration) continue;
		__kustoSupplementalQueuedApplyJobs.delete(jobKey);
		__kustoSupplementalApplyingSchemaKeys.delete(candidateSchemaKey);
	}
}

function __kustoDisposeSupplementalModel(modelUri: string): void {
	const removed = __kustoSupplementalCoordinator.disposeModel(modelUri);
	__kustoCancelSupplementalApplyJobs(modelUri);
	const revalidationTimer = __kustoSupplementalRevalidationTimeoutByModel[modelUri];
	if (revalidationTimer !== undefined) {
		clearTimeout(revalidationTimer);
		delete __kustoSupplementalRevalidationTimeoutByModel[modelUri];
	}
	if (removed.length > 0) {
		__kustoRetireOrphanedSupplementalBrokers();
		__kustoScheduleSupplementalPump(0);
	}
}

function __kustoInvalidateSupplementalApplicationsAfterWorkerReplace(reason: string): void {
	const modelUris = new Set(__kustoSupplementalCoordinator.getAllStates().map(state => state.modelUri));
	for (const modelUri of modelUris) __kustoCancelSupplementalApplyJobs(modelUri);
	const invalidated = __kustoSupplementalCoordinator.invalidateAllApplications();
	__kustoTraceCrossCluster('supplemental.worker-replace-invalidated', {
		reason,
		modelCount: modelUris.size,
		stateCount: invalidated.length,
	});
	__kustoScheduleSupplementalPump(0);
}

async function __kustoRestoreOtherPrimaryApplicationsAfterWorkerReplace(
	worker: any,
	currentModelUri: string,
	reason: string,
	transaction: KustoWorkerMutationTransaction,
): Promise<void> {
	const currentBoxId = String(queryEditorBoxByModelUri?.[currentModelUri] || '');
	const activeAccountPartition = __kustoSchemaTracker.databaseInContext?.accountPartition || '';
	let restoredCount = 0;
	let fallbackCount = 0;
	for (const boxId of getSchemaWorkerReadyStateIds()) {
		const readyState = getSchemaWorkerReadyState(boxId);
		if (!readyState || boxId === currentBoxId || readyState.status !== 'ready' || !readyState.schemaKey || !readyState.modelUri) continue;
		const preparationToken = getKustoPreparationToken(boxId);
		const cached = __kustoSchemaTracker.schemaCache[readyState.schemaKey];
		if (!activeAccountPartition || cached?.accountPartition !== activeAccountPartition) {
			invalidateSchemaWorkerReadinessForBox(boxId);
			requireSchemaWorkerApply(boxId);
			fallbackCount++;
			continue;
		}
		markSchemaWorkerApplyPending(boxId, readyState.schemaKey, readyState.schemaSignature, readyState.modelUri, preparationToken);
		let restored = false;
		if (cached?.rawSchemaJson) {
			const restoreOperation = __kustoAddDatabaseAliasesToWorker(
				worker,
				readyState.modelUri,
				cached.rawSchemaJson,
				cached.clusterUrl,
				cached.clusterUrl,
				cached.database,
				transaction,
				() => true,
			);
			let aliasCount: number;
			try {
				aliasCount = await restoreOperation;
			} catch (error) {
				traceFileOpen('monaco.schema.primaryRestore.error', {
					boxId,
					schemaKey: readyState.schemaKey,
					errorType: error instanceof Error ? error.name : 'Error',
				});
				if (preparationToken && isKustoPreparationCurrent(preparationToken, {
					schemaKey: readyState.schemaKey,
					schemaSignature: readyState.schemaSignature,
					modelUri: readyState.modelUri,
				})) {
					markSchemaWorkerApplyFailed(boxId, readyState.schemaKey, readyState.modelUri, preparationToken);
				}
				continue;
			}
			if (!transaction.isActive()) return;
			if (preparationToken && !isKustoPreparationCurrent(preparationToken, {
				schemaKey: readyState.schemaKey,
				schemaSignature: readyState.schemaSignature,
				modelUri: readyState.modelUri,
			})) {
				continue;
			}
			restored = aliasCount > 0;
		}
		if (restored) {
			markSchemaWorkerReady(boxId, readyState.schemaKey, readyState.schemaSignature, readyState.modelUri, preparationToken);
			restoredCount++;
		} else {
			requireSchemaWorkerApply(boxId);
			requestKustoSchemaApplyForBox(boxId, false);
			fallbackCount++;
		}
	}
	traceFileOpen('monaco.schema.primaryWorkerReplaceInvalidated', {
		reason,
		currentModelId: kustoSupplementalTraceId(currentModelUri),
		restoredCount,
		fallbackCount,
	});
}

async function __kustoPumpSupplementalSchemas(): Promise<void> {
	const now = Date.now();
	for (const expired of __kustoSupplementalCoordinator.expire(now)) {
		void __kustoRevalidateSupplementalModel(expired.modelUri, expired.failureKind || 'deadline');
	}
	__kustoRetireOrphanedSupplementalBrokers(now);
	const models = new Set(__kustoSupplementalCoordinator.getAllStates().map(state => state.modelUri));
	for (const modelUri of models) {
		const primaryReady = __kustoIsSupplementalPrimaryReady(modelUri);
		__kustoSupplementalCoordinator.setPrimaryReady(modelUri, primaryReady, now);
	}
	const scheduledStates = __kustoSupplementalCoordinator.getAllStates()
		.filter(state => state.status === 'scheduled')
		.sort((left, right) => Number(right.requestSource === 'autocomplete') - Number(left.requestSource === 'autocomplete'));
	const attemptedKeys = new Set<string>();
	let backgroundFetchCount = Object.values(__kustoCrossClusterSchemas)
		.filter(entry => entry?.status === 'pending' && entry.requestSource === 'background').length;
	for (const state of scheduledStates) {
		if (attemptedKeys.has(state.schemaKey)) continue;
		attemptedKeys.add(state.schemaKey);
		const broker = __kustoCrossClusterSchemas[state.schemaKey];
		if (state.requestSource === 'background' && broker?.status !== 'pending' && broker?.status !== 'loaded'
			&& backgroundFetchCount >= CROSS_CLUSTER_SCHEMA_MAX_BACKGROUND_FETCHES) {
			__kustoTraceCrossCluster('request.deferred.concurrency', {
				schemaKey: state.schemaKey,
				requestSource: state.requestSource,
				backgroundFetchCount,
				limit: CROSS_CLUSTER_SCHEMA_MAX_BACKGROUND_FETCHES,
			});
			continue;
		}
		__kustoRequestCrossClusterSchema?.(state.clusterName, state.database, state.boxId, state.requestSource);
		if (state.requestSource === 'background' && __kustoCrossClusterSchemas[state.schemaKey]?.status === 'pending') backgroundFetchCount++;
	}
	const applyCandidates = __kustoSupplementalCoordinator.getApplyCandidates();
	const scheduledApplyKeys = new Set<string>();
	for (const state of applyCandidates) {
		if (scheduledApplyKeys.has(state.schemaKey) || __kustoSupplementalApplyingSchemaKeys.has(state.schemaKey)) continue;
		scheduledApplyKeys.add(state.schemaKey);
		const broker = __kustoCrossClusterSchemas[state.schemaKey];
		if (!broker?.rawSchemaJson) continue;
		if (broker.workerAppliedRevision === (broker.revision || 0)
			&& broker.workerAppliedEpoch === __kustoWorkerMutations.getSnapshot().destructiveEpoch) {
			let adoptedCount = 0;
			for (const candidate of applyCandidates) {
				if (candidate.schemaKey !== state.schemaKey || !__kustoIsSupplementalPrimaryReady(candidate.modelUri, candidate.primarySchemaKey)) continue;
				const adopted = __kustoSupplementalCoordinator.markLoaded(supplementalStateIdentity(candidate));
				if (!adopted) continue;
				adoptedCount++;
				void __kustoRevalidateSupplementalModel(adopted.modelUri, 'supplemental-worker-revision-adopted');
			}
			__kustoTraceCrossCluster('apply-shared-adopted', { schemaKey: state.schemaKey, brokerRevision: broker.revision || 0, adoptedCount });
			continue;
		}
		__kustoScheduleCrossClusterSchemaApply({
			clusterName: state.clusterName,
			clusterUrl: String(broker.clusterUrl || state.clusterName),
			database: state.database,
			rawSchemaJson: broker.rawSchemaJson,
			boxId: state.boxId,
			modelUri: state.modelUri,
			modelVersion: state.modelVersion,
			primarySchemaKey: state.primarySchemaKey,
			referenceGeneration: state.referenceGeneration,
			brokerRevision: broker.revision || 0,
			primaryQueueGeneration: __kustoWorkerMutations.getSnapshot().primaryIntentGeneration,
			requestSource: state.requestSource,
			deliverySource: String(broker.deliverySource || ''),
		});
	}
	__kustoScheduleSupplementalDeadline();
}

interface CrossClusterSchemaApplyArgs {
	clusterName: string;
	clusterUrl: string;
	database: string;
	rawSchemaJson: any;
	boxId?: string;
	modelUri?: string;
	modelVersion?: number;
	primarySchemaKey?: string;
	referenceGeneration?: number;
	brokerRevision?: number;
	primaryQueueGeneration?: number;
	requestSource?: KustoSupplementalRequestSource;
	deliverySource?: string;
}

function __kustoNormalizeCrossClusterBoxId(boxId: any): string {
	return String(boxId || '').trim();
}

function __kustoNormalizeCrossClusterClusterName(clusterName: any): string {
	return kustoClusterKey(clusterName);
}

function __kustoGetCrossClusterClusterAliases(clusterName: any, clusterUrl?: any): string[] {
	const candidates = [clusterName, clusterUrl].map(value => String(value || '').trim()).filter(Boolean);
	const aliases: string[] = [];
	const addAlias = (value: string, keepScheme = false) => {
		const raw = String(value || '').trim().replace(/\/+$/g, '');
		const trimmed = keepScheme ? raw : raw.replace(/^https?:\/\//i, '');
		if (!trimmed) return;
		const lower = trimmed.toLowerCase();
		if (!aliases.some(alias => alias.toLowerCase() === lower)) {
			aliases.push(trimmed);
		}
	};
	for (const candidate of candidates) {
		addAlias(candidate);
		if (!/^https?:\/\//i.test(candidate)) {
			addAlias(`https://${candidate}`, true);
		} else {
			addAlias(candidate, true);
		}
		try {
			const canonical = __kustoNormalizeCrossClusterClusterName(candidate);
			addAlias(canonical);
			addAlias(`https://${canonical}`, true);
			if (canonical.toLowerCase().endsWith('.kusto.windows.net')) {
				addAlias(canonical.slice(0, -'.kusto.windows.net'.length));
				addAlias(`https://${canonical.slice(0, -'.kusto.windows.net'.length)}`, true);
			}
		} catch {
			// ignore non-public/custom endpoints
		}
	}
	return aliases;
}

async function __kustoAddDatabaseAliasesToWorker(
	worker: any,
	modelUri: string,
	schemaObj: any,
	clusterName: any,
	clusterUrl: any,
	database: any,
	transaction: KustoWorkerMutationTransaction,
	isCurrent: () => boolean = () => true,
): Promise<number> {
	try {
		const canMutate = () => transaction.isActive() && isCurrent();
		if (!worker || typeof worker.addDatabaseToSchema !== 'function' || !modelUri || !schemaObj || !database || !canMutate()) {
			return 0;
		}
		recordAutocompleteTrace(__kustoGetAutocompleteTraceIdForModel(modelUri), 'worker-add-aliases-start', {
			modelUri,
			schemaKey: __kustoGetCrossClusterSchemaKey(clusterName, database),
		});
		schemaObj = stampKustoSchemaMajorVersion(__kustoPrepareSchemaForKustoWorker(schemaObj), transaction.id);
		const toInputParameter = ([paramName, param]: [string, any]) => ({
			name: param?.Name || param?.name || paramName,
			type: param?.CslType || param?.cslType || param?.Type || param?.type || 'string',
			cslType: param?.CslType || param?.cslType || param?.Type || param?.type || 'string',
			columns: Object.entries(param?.Columns || param?.columns || param?.OrderedColumns || param?.orderedColumns || {}).map(([colName, col]: [string, any]) => ({
				name: col?.Name || col?.name || colName,
				type: col?.CslType || col?.cslType || col?.Type || col?.type || 'string',
				cslType: col?.CslType || col?.cslType || col?.Type || col?.type || 'string'
			}))
		});
		const toOutputColumn = ([colName, col]: [string, any]) => ({
			name: col?.Name || col?.name || colName,
			type: col?.CslType || col?.cslType || col?.Type || col?.type || 'string',
			cslType: col?.CslType || col?.cslType || col?.Type || col?.type || 'string',
			docstring: col?.Docstring || col?.DocString || col?.docstring || ''
		});
		const buildFunctionBody = (fn: any, outputColumns: any[]) => outputColumns.length ? buildKustoFunctionBodyFromOutputColumns(fn) : (fn?.Body || fn?.body || '');
		const rawDbSchema = schemaObj.Databases?.[database]
			|| Object.entries(schemaObj.Databases || {}).find(([name]) => name.toLowerCase() === String(database).toLowerCase())?.[1];
		let databaseSchema: any = null;
		if (typeof worker.normalizeSchema === 'function') {
			try {
				if (!canMutate()) return 0;
				const engineSchema = await worker.normalizeSchema(schemaObj, clusterUrl, database);
				if (!canMutate()) return 0;
				databaseSchema = engineSchema?.database;
				if (!databaseSchema && engineSchema?.cluster?.databases) {
					databaseSchema = engineSchema.cluster.databases.find((db: any) => db.name.toLowerCase() === String(database).toLowerCase());
				}
			} catch (e) { console.error('[kusto] normalizeSchema failed while adding aliases:', e); }
		}
		if (databaseSchema && rawDbSchema && typeof rawDbSchema === 'object') {
			const rawFunctions = Object.entries((rawDbSchema as any).Functions || {});
			if (rawFunctions.length > 0) {
				const existingByLower = new Map((Array.isArray(databaseSchema.functions) ? databaseSchema.functions : [])
					.map((fn: any) => [String(fn?.name || '').toLowerCase(), fn]));
				for (const [name, rawFn] of rawFunctions) {
					const functionName = String((rawFn as any).Name || (rawFn as any).name || name);
					const outputColumnsSource = (rawFn as any).OutputColumns || (rawFn as any).outputColumns || (rawFn as any).OrderedColumns || (rawFn as any).orderedColumns || (rawFn as any).Columns || (rawFn as any).columns || {};
					const outputColumns = Array.isArray(outputColumnsSource)
						? outputColumnsSource.map((col: any, index: number) => toOutputColumn([col?.Name || col?.name || `Column${index + 1}`, col]))
						: Object.entries(outputColumnsSource).map(toOutputColumn);
					const existing: any = existingByLower.get(functionName.toLowerCase()) || {};
					if (outputColumns.length > 0) {
						existing.outputColumns = outputColumns;
					}
					existing.body = buildFunctionBody(rawFn, outputColumns);
					if (!Array.isArray(existing.inputParameters) || existing.inputParameters.length === 0) {
						const inputParametersSource = (rawFn as any).InputParameters || (rawFn as any).inputParameters || {};
						existing.inputParameters = Array.isArray(inputParametersSource)
							? inputParametersSource.map((param: any, index: number) => toInputParameter([param?.Name || param?.name || `arg${index + 1}`, param]))
							: Object.entries(inputParametersSource).map(toInputParameter);
					}
					existing.name = existing.name || functionName;
					existing.docstring = existing.docstring || (rawFn as any).Docstring || (rawFn as any).DocString || '';
					existing.folder = existing.folder || (rawFn as any).Folder || '';
					existingByLower.set(functionName.toLowerCase(), existing);
				}
				databaseSchema.functions = Array.from(existingByLower.values());
			}
		}
		if (!databaseSchema) {
			const dbSchema = rawDbSchema;
			if (dbSchema) {
				databaseSchema = {
					name: database,
					tables: Object.entries((dbSchema as any).Tables || {}).map(([name, table]) => ({
						name,
						entityType: (table as any).EntityType || 'Table',
						columns: Object.entries((table as any).OrderedColumns || {}).map(([colName, col]) => ({
							name: (col as any).Name || colName,
							type: (col as any).CslType || (col as any).Type || 'string',
							docstring: (col as any).Docstring || ''
						})),
						docstring: (table as any).Docstring || ''
					})),
					functions: Object.entries((dbSchema as any).Functions || {}).map(([name, fn]) => {
						const outputColumnsSource = (fn as any).OutputColumns || (fn as any).OrderedColumns || (fn as any).Columns || {};
						const inputParametersSource = (fn as any).InputParameters || {};
						const outputColumns = Array.isArray(outputColumnsSource)
							? outputColumnsSource.map((col: any, index: number) => toOutputColumn([col?.Name || `Column${index + 1}`, col]))
							: Object.entries(outputColumnsSource).map(toOutputColumn);
						const body = buildFunctionBody(fn, outputColumns);
						return {
							name: (fn as any).Name || name,
							inputParameters: Array.isArray(inputParametersSource)
								? inputParametersSource.map((param: any, index: number) => toInputParameter([param?.Name || `arg${index + 1}`, param]))
								: Object.entries(inputParametersSource).map(toInputParameter),
							outputColumns,
							body,
							docstring: (fn as any).Docstring || (fn as any).DocString || '',
							folder: (fn as any).Folder || ''
						};
					}),
					graphs: [],
					entityGroups: [],
					majorVersion: 1,
					minorVersion: 0,
				};
			}
		}
		if (!databaseSchema) {
			return 0;
		}
		let count = 0;
		for (const alias of __kustoGetCrossClusterClusterAliases(clusterName, clusterUrl)) {
			if (!canMutate()) return 0;
			await worker.addDatabaseToSchema(modelUri, alias, databaseSchema);
			if (!transaction.commit()) return 0;
			if (!canMutate()) return 0;
			count++;
		}
		recordAutocompleteTrace(__kustoGetAutocompleteTraceIdForModel(modelUri), 'worker-add-aliases-finish', {
			modelUri,
			schemaKey: __kustoGetCrossClusterSchemaKey(clusterName, database),
			aliasCount: count,
			tables: Array.isArray(databaseSchema.tables) ? databaseSchema.tables.length : undefined,
			functions: Array.isArray(databaseSchema.functions) ? databaseSchema.functions.length : undefined,
		});
		return count;
	} catch (e) {
		console.error('[kusto] Failed to add database aliases:', e);
		recordAutocompleteTrace(__kustoGetAutocompleteTraceIdForModel(modelUri), 'worker-add-aliases-error', {
			modelUri,
			schemaKey: __kustoGetCrossClusterSchemaKey(clusterName, database),
			errorType: e instanceof Error ? e.name : 'Error',
		});
		return 0;
	}
}

function __kustoGetCrossClusterSchemaKey(clusterName: any, database: any): string {
	try {
		const resolution = resolveKustoConnection(connections || [], { clusterUrl: clusterName });
		if (resolution.kind !== 'matched') return '';
		const accountPartition = String((resolution.connection as any).accountPartition || '').trim();
		return getKustoSchemaIdentityKey(resolution.connection.id, accountPartition, resolution.connection.clusterUrl, database);
	} catch {
		return '';
	}
}

export function __kustoIsCurrentCrossClusterRequest(boxId: any, clusterName: any, database: any, requestToken: any): boolean {
	const token = String(requestToken || '').trim();
	const key = __kustoGetCrossClusterSchemaKey(clusterName, database);
	const expected = key ? __kustoCrossClusterSchemas[key]?.requestToken : undefined;
	return !!token && !!expected && expected === token;
}

function __kustoHasCurrentCrossClusterRequestForKey(schemaKey: string): boolean {
	try {
		if (!schemaKey) {
			return false;
		}
		return __kustoCrossClusterSchemas[schemaKey]?.status === 'pending';
	} catch {
		return false;
	}
}

export function __kustoReleaseStaleCrossClusterResponse(clusterName: any, database: any, error: any): void {
	try {
		const key = __kustoGetCrossClusterSchemaKey(clusterName, database);
		if (!key) {
			return;
		}
		const current = __kustoCrossClusterSchemas[key];
		if (!current || current.status !== 'pending' || __kustoHasCurrentCrossClusterRequestForKey(key)) {
			return;
		}
		__kustoSetCrossClusterSchemaEntry(key, { status: 'error', error });
	} catch (e) { console.error('[kusto]', e); }
}

function __kustoResolveCrossClusterNameForRef(ref: any, boxId: any, currentContext?: any): string {
	try {
		if (ref && ref.clusterName !== null && ref.clusterName !== undefined && String(ref.clusterName || '').trim()) {
			return String(ref.clusterName).trim();
		}
		const context = currentContext || __kustoGetSchemaContextForBox(__kustoNormalizeCrossClusterBoxId(boxId)) || __kustoSchemaTracker.databaseInContext;
		return String(context?.clusterUrl || '').trim();
	} catch {
		return '';
	}
}

function __kustoIsCrossClusterSchemaLoaded(key: string): boolean {
	try {
		return !!(key && __kustoCrossClusterSchemas?.[key]?.status === 'loaded');
	} catch {
		return false;
	}
}

function __kustoGetModelUriForCrossClusterBox(boxId: any): string {
	try {
		const editor = boxId ? queryEditors?.[__kustoNormalizeCrossClusterBoxId(boxId)] : null;
		const model = editor && typeof editor.getModel === 'function' ? editor.getModel() : null;
		return model && model.uri ? String(model.uri.toString()) : '';
	} catch {
		return '';
	}
}

function __kustoIsCrossClusterSchemaLoadedForModel(key: string, modelUri: string): boolean {
	try {
		return __kustoSupplementalCoordinator.getState(modelUri, key)?.status === 'loaded';
	} catch {
		return false;
	}
}

function __kustoForgetAllSchemaWorkerReady(resetPreparation: boolean = true): void {
	try {
		if (resetPreparation) {
			invalidateSchemaWorkerReadiness();
			return;
		}
		for (const boxId of getSchemaWorkerReadyStateIds()) {
			invalidateSchemaWorkerReadinessForBox(boxId, false, false);
		}
	} catch (e) { console.error('[kusto]', e); }
}

let __kustoCrossClusterSchemaWaitersByKey: Record<string, Array<(loaded: boolean) => void>> = {};
let __kustoCrossClusterAutocompleteDemandUntilByKey: Record<string, number> = {};
const __kustoDelayedSupplementalSchemasForTest: Record<string, {
	clusterName: string;
	clusterUrl: string;
	database: string;
	boxId: string;
	connectionId: string;
	accountPartition: string;
	rawSchemaJson: any;
	delayMs: number;
}> = {};

function __kustoResolveCrossClusterSchemaWaiters(key: string, loaded: boolean): void {
	try {
		const waiters = key ? __kustoCrossClusterSchemaWaitersByKey[key] : null;
		if (!waiters || waiters.length === 0) {
			return;
		}
		delete __kustoCrossClusterSchemaWaitersByKey[key];
		for (const resolve of waiters) {
			try { resolve(loaded); } catch (e) { console.error('[kusto]', e); }
		}
	} catch (e) { console.error('[kusto]', e); }
}

function __kustoSetCrossClusterSchemaEntry(key: string, entry: any): void {
	try {
		if (!key) {
			return;
		}
		__kustoCrossClusterSchemas[key] = entry;
		const status = entry && entry.status;
		__kustoTraceCrossCluster('schema-status', { key, status, error: entry?.error });
		if (status === 'loaded') {
			try { delete __kustoCrossClusterAutocompleteDemandUntilByKey[key]; } catch (e) { console.error('[kusto]', e); }
			__kustoResolveCrossClusterSchemaWaiters(key, true);
		} else if (status === 'error') {
			try { delete __kustoCrossClusterAutocompleteDemandUntilByKey[key]; } catch (e) { console.error('[kusto]', e); }
			__kustoResolveCrossClusterSchemaWaiters(key, false);
		}
	} catch (e) { console.error('[kusto]', e); }
}

export function __kustoMarkCrossClusterSchemaError(clusterName: any, database: any, error: any): void {
	const key = __kustoGetCrossClusterSchemaKey(clusterName, database);
	const broker = key ? __kustoCrossClusterSchemas[key] : undefined;
	const requestToken = String(broker?.requestToken || '');
	const failureKind = __kustoSupplementalFailureFromUnknown(error);
	if (broker) {
		broker.status = 'error';
		broker.failureKind = failureKind;
		broker.error = failureKind;
	}
	for (const state of __kustoSupplementalCoordinator.markRequestFailed(requestToken, failureKind)) {
		void __kustoRevalidateSupplementalModel(state.modelUri, failureKind);
	}
	__kustoSetCrossClusterSchemaEntry(key, { status: 'error', failureKind, error: failureKind });
	__kustoScheduleSupplementalDeadline();
	__kustoScheduleSupplementalPump(0);
}

export function __kustoHandleCrossClusterSchemaData(message: {
	clusterName: string;
	clusterUrl: string;
	connectionId: string;
	accountPartition: string;
	database: string;
	boxId: string;
	requestToken: string;
	requestSource?: KustoSupplementalRequestSource;
	deliverySource?: string;
	cacheAgeMs?: number;
	rawSchemaJson: any;
}): boolean {
	const key = __kustoGetCrossClusterSchemaKey(message.clusterName, message.database);
	const responseKey = getKustoSchemaIdentityKey(message.connectionId, message.accountPartition, message.clusterUrl, message.database);
	const broker = key ? __kustoCrossClusterSchemas[key] : undefined;
	if (!key || responseKey !== key || !message.requestToken || !broker || broker.requestToken !== message.requestToken) return false;
	broker.status = 'loaded';
	broker.deadlineAt = undefined;
	broker.revision = (broker.revision || 0) + 1;
	broker.requestSource = message.requestSource || broker.requestSource;
	broker.rawSchemaJson = message.rawSchemaJson;
	broker.clusterUrl = message.clusterUrl;
	broker.deliverySource = message.deliverySource || '';
	broker.cacheAgeMs = message.cacheAgeMs;
	const fetchedStates = __kustoSupplementalCoordinator.markFetchedByRequest(message.requestToken);
	const refreshedStates = message.deliverySource === 'fresh-after-stale-cache' || message.deliverySource === 'client-cache-after-stale-cache'
		? __kustoSupplementalCoordinator.markSchemaRefreshed(key)
		: [];
	const changedStates = new Map([...fetchedStates, ...refreshedStates]
		.map(state => [`${state.modelUri}\u0000${state.schemaKey}`, state]));
	for (const state of changedStates.values()) {
		void __kustoRevalidateSupplementalModel(state.modelUri, 'supplemental-fetched');
	}
	__kustoTraceCrossCluster('response.accepted', {
		key,
		boxId: message.boxId,
		requestToken: message.requestToken,
		requestSource: message.requestSource,
		deliverySource: message.deliverySource,
		cacheAgeMs: message.cacheAgeMs,
	});
	__kustoScheduleSupplementalPump(0);
	return true;
}

export function __kustoHandleCrossClusterSchemaError(message: {
	clusterName: string;
	database: string;
	boxId: string;
	requestToken: string;
	requestSource?: KustoSupplementalRequestSource;
	failureKind?: KustoSupplementalFailureKind;
}): boolean {
	const key = __kustoGetCrossClusterSchemaKey(message.clusterName, message.database);
	const broker = key ? __kustoCrossClusterSchemas[key] : undefined;
	if (!key || !message.requestToken || !broker || broker.requestToken !== message.requestToken) return false;
	const failureKind = __kustoSupplementalFailureFromUnknown(message.failureKind);
	const failedStates = __kustoSupplementalCoordinator.markRequestFailed(message.requestToken, failureKind);
	const fallbackRetained = !!broker.rawSchemaJson && failedStates.some(state => state.fetchedAvailable && state.status !== 'failed');
	broker.status = fallbackRetained ? 'loaded' : 'error';
	broker.deadlineAt = undefined;
	broker.failureKind = fallbackRetained ? undefined : failureKind;
	broker.error = fallbackRetained ? undefined : failureKind;
	__kustoSetCrossClusterSchemaEntry(key, broker);
	for (const state of failedStates) {
		void __kustoRevalidateSupplementalModel(state.modelUri, failureKind);
	}
	__kustoTraceCrossCluster('response.error.accepted', {
		key,
		boxId: message.boxId,
		requestToken: message.requestToken,
		requestSource: message.requestSource,
		failureKind,
		fallbackRetained,
	});
	__kustoScheduleSupplementalDeadline();
	__kustoScheduleSupplementalPump(0);
	return true;
}

export function __kustoInjectSupplementalSchemaForTest(args: {
	clusterName: string;
	clusterUrl: string;
	database: string;
	boxId: string;
	rawSchemaJson: any;
}): boolean {
	const boxId = __kustoNormalizeCrossClusterBoxId(args.boxId);
	const resolution = resolveKustoConnection(connections || [], { clusterUrl: args.clusterName });
	if (resolution.kind !== 'matched') return false;
	const connectionId = String(resolution.connection.id || '');
	const accountPartition = String((resolution.connection as any).accountPartition || '');
	const schemaKey = __kustoGetCrossClusterSchemaKey(args.clusterName, args.database);
	if (!boxId || !schemaKey || !connectionId || !accountPartition || !args.rawSchemaJson) return false;
	const states = __kustoSyncSupplementalReferencesForBox(boxId, 'background')
		.filter(state => state.schemaKey === schemaKey);
	if (states.length === 0) return false;
	const requestToken = `e2e-supplemental-${Date.now()}-${Math.random().toString(16).slice(2)}`;
	const deadlineAt = Date.now() + CROSS_CLUSTER_SCHEMA_BACKGROUND_FETCH_TIMEOUT_MS;
	const existing = __kustoCrossClusterSchemas[schemaKey];
	__kustoSetCrossClusterSchemaEntry(schemaKey, {
		status: 'pending',
		requestToken,
		requestSource: 'background',
		deadlineAt,
		revision: (existing?.revision || 0) + 1,
	});
	const subscribers = __kustoSupplementalCoordinator.bindSchemaRequest(schemaKey, {
		requestToken,
		requestSource: 'background',
		deadlineAt,
		includeFetching: true,
	});
	__kustoTraceCrossCluster('request-posted', {
		schemaKey,
		boxId,
		requestSource: 'background',
		requestToken,
		subscriberCount: subscribers.length,
	});
	__kustoTraceCrossCluster('response-received', {
		clusterName: args.clusterName,
		clusterUrl: args.clusterUrl,
		connectionId,
		accountPartition,
		database: args.database,
		boxId,
		requestToken,
		requestSource: 'background',
		deliverySource: 'e2e-fixture',
	});
	return __kustoHandleCrossClusterSchemaData({
		clusterName: args.clusterName,
		clusterUrl: args.clusterUrl,
		connectionId,
		accountPartition,
		database: args.database,
		boxId,
		requestToken,
		requestSource: 'background',
		deliverySource: 'e2e-fixture',
		rawSchemaJson: args.rawSchemaJson,
	});
}

export function __kustoScheduleSupplementalSchemaForTest(args: {
	clusterName: string;
	clusterUrl: string;
	database: string;
	boxId: string;
	rawSchemaJson: any;
	delayMs: number;
}): boolean {
	if (document.body.dataset.kustoE2eEnabled !== 'true') return false;
	const boxId = __kustoNormalizeCrossClusterBoxId(args.boxId);
	const resolution = resolveKustoConnection(connections || [], { clusterUrl: args.clusterName });
	if (resolution.kind !== 'matched') return false;
	const connectionId = String(resolution.connection.id || '');
	const accountPartition = String((resolution.connection as any).accountPartition || '');
	const schemaKey = __kustoGetCrossClusterSchemaKey(args.clusterName, args.database);
	if (!boxId || !schemaKey || !connectionId || !accountPartition || !args.rawSchemaJson) return false;
	__kustoDelayedSupplementalSchemasForTest[schemaKey] = {
		clusterName: args.clusterName,
		clusterUrl: args.clusterUrl,
		database: args.database,
		boxId,
		connectionId,
		accountPartition,
		rawSchemaJson: args.rawSchemaJson,
		delayMs: Math.max(0, Number(args.delayMs) || 0),
	};
	return true;
}

function __kustoWaitForCrossClusterSchemaReady(key: string, timeoutMs: number): Promise<boolean> {
	if (!key) {
		return Promise.resolve(false);
	}
	if (__kustoIsCrossClusterSchemaLoaded(key)) {
		return Promise.resolve(true);
	}
	return new Promise(resolve => {
		let settled = false;
		let timeoutId: number | undefined;
		const finish = (loaded: boolean) => {
			if (settled) return;
			settled = true;
			if (timeoutId !== undefined) {
				try { clearTimeout(timeoutId); } catch (e) { console.error('[kusto]', e); }
			}
			resolve(loaded || __kustoIsCrossClusterSchemaLoaded(key));
		};
		try {
			(__kustoCrossClusterSchemaWaitersByKey[key] = __kustoCrossClusterSchemaWaitersByKey[key] || []).push(finish);
			timeoutId = window.setTimeout(() => {
				try {
					const waiters = __kustoCrossClusterSchemaWaitersByKey[key] || [];
					__kustoCrossClusterSchemaWaitersByKey[key] = waiters.filter(waiter => waiter !== finish);
					if (__kustoCrossClusterSchemaWaitersByKey[key].length === 0) {
						delete __kustoCrossClusterSchemaWaitersByKey[key];
					}
				} catch (e) { console.error('[kusto]', e); }
				finish(__kustoIsCrossClusterSchemaLoaded(key));
			}, Math.max(0, timeoutMs));
		} catch {
			finish(false);
		}
	});
}

function __kustoWaitForCrossClusterSchemaReadyForModel(key: string, modelUri: string, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
	if (!key || signal?.aborted) {
		return Promise.resolve(false);
	}
	if (__kustoIsCrossClusterSchemaLoadedForModel(key, modelUri)) {
		return Promise.resolve(true);
	}
	return new Promise(resolve => {
		const started = Date.now();
		const timeout = Math.max(0, Number(timeoutMs) || 0);
		let settled = false;
		let timer: number | undefined;
		const finish = (ready: boolean) => {
			if (settled) return;
			settled = true;
			if (timer !== undefined) clearTimeout(timer);
			try { signal?.removeEventListener('abort', abort); } catch { /* best effort */ }
			resolve(ready);
		};
		const abort = () => finish(false);
		const check = () => {
			try {
				if (signal?.aborted) {
					finish(false);
					return;
				}
				if (__kustoIsCrossClusterSchemaLoadedForModel(key, modelUri)) {
					finish(true);
					return;
				}
				if (timeout <= 0 || Date.now() - started >= timeout) {
					finish(false);
					return;
				}
				timer = window.setTimeout(check, 50);
			} catch {
				finish(false);
			}
		};
		signal?.addEventListener('abort', abort, { once: true });
		check();
	});
}

function __kustoMarkCrossClusterAutocompleteDemand(key: string): void {
	try {
		if (!key) return;
		__kustoCrossClusterAutocompleteDemandUntilByKey[key] = Date.now() + CROSS_CLUSTER_SCHEMA_AUTOCOMPLETE_DEMAND_MS;
	} catch (e) { console.error('[kusto]', e); }
}

function __kustoIsCrossClusterSchemaDemandedForAutocomplete(key: string): boolean {
	try {
		const until = key ? (__kustoCrossClusterAutocompleteDemandUntilByKey[key] || 0) : 0;
		if (!until) return false;
		if (until < Date.now()) {
			delete __kustoCrossClusterAutocompleteDemandUntilByKey[key];
			return false;
		}
		return true;
	} catch {
		return false;
	}
}

function __kustoNoteCrossClusterInteraction(boxId?: any): void {
	const now = Date.now();
	__kustoLastMonacoInteractionAt = now;
	const id = __kustoNormalizeCrossClusterBoxId(boxId);
	if (id) {
		__kustoLastCrossClusterInteractionAtByBoxId[id] = now;
	}
}

function __kustoSetCrossClusterPointerDown(boxId: any, isDown: boolean): void {
	__kustoNoteCrossClusterInteraction(boxId);
	const id = __kustoNormalizeCrossClusterBoxId(boxId);
	if (!id) {
		return;
	}
	if (isDown) {
		__kustoCrossClusterPointerDownByBoxId[id] = true;
	} else {
		delete __kustoCrossClusterPointerDownByBoxId[id];
	}
}

function __kustoIsCrossClusterPointerDown(boxId?: any): boolean {
	const id = __kustoNormalizeCrossClusterBoxId(boxId);
	if (id) {
		return !!__kustoCrossClusterPointerDownByBoxId[id];
	}
	return Object.values(__kustoCrossClusterPointerDownByBoxId).some(Boolean);
}

function __kustoGetCrossClusterIdleDelay(boxId: string | undefined, minIdleMs: number): number {
	if (__kustoIsCrossClusterPointerDown(boxId)) {
		return Math.max(minIdleMs, CROSS_CLUSTER_SCHEMA_IDLE_RETRY_FLOOR_MS);
	}
	const id = __kustoNormalizeCrossClusterBoxId(boxId);
	const lastForBox = id ? (__kustoLastCrossClusterInteractionAtByBoxId[id] || 0) : 0;
	return getCrossClusterSchemaCheckDelay(Date.now(), Math.max(__kustoLastMonacoInteractionAt || 0, lastForBox), minIdleMs);
}

function __kustoEditorHasCrossClusterFocus(editor: any): boolean {
	try {
		const hasWidgetFocus = typeof editor?.hasWidgetFocus === 'function' ? editor.hasWidgetFocus() : false;
		const hasTextFocus = typeof editor?.hasTextFocus === 'function' ? editor.hasTextFocus() : false;
		return hasWidgetFocus || hasTextFocus;
	} catch {
		return false;
	}
}

function __kustoIsCurrentCrossClusterEditor(editor: any, boxId: string): boolean {
	return !!boxId && activeQueryEditorBoxId === boxId && queryEditors?.[boxId] === editor && __kustoEditorHasCrossClusterFocus(editor);
}

function __kustoClearCrossClusterCheckTimer(boxId: string): void {
	try {
		if (__kustoCrossClusterCheckTimeout?.[boxId]) {
			clearTimeout(__kustoCrossClusterCheckTimeout[boxId]);
			delete __kustoCrossClusterCheckTimeout[boxId];
		}
	} catch (e) { console.error('[kusto]', e); }
}

function __kustoRemoveCrossClusterInterestForBox(boxId: any): void {
	const id = __kustoNormalizeCrossClusterBoxId(boxId);
	if (!id) {
		return;
	}
	const modelUri = __kustoGetModelUriForCrossClusterBox(id);
	if (modelUri) __kustoDisposeSupplementalModel(modelUri);
}

function __kustoHasLiveCrossClusterInterest(key: string): boolean {
	return __kustoSupplementalCoordinator.getStatesForSchemaKey(key).some(state => !!__kustoSupplementalModelForUri(state.modelUri));
}

function __kustoIsSoleQuerySectionBox(boxId: string): boolean {
	try {
		const id = String(boxId || '');
		const queryBoxIds = Array.isArray(queryBoxes) ? queryBoxes.map(candidate => String(candidate || '')).filter(Boolean) : [];
		return !!id && queryBoxIds.length === 1 && queryBoxIds[0] === id;
	} catch {
		return false;
	}
}

function __kustoIsCrossClusterFreshAfterStaleSource(source: any): boolean {
	const value = String(source || '').trim().toLowerCase();
	return value === 'fresh-after-stale-cache' || value === 'client-cache-after-stale-cache';
}

function __kustoCanSkipLoadedCrossClusterApply(source: any): boolean {
	const value = String(source || '').trim().toLowerCase();
	if (__kustoIsCrossClusterFreshAfterStaleSource(value)) {
		return false;
	}
	return !value
		|| value === 'disk-cache-fresh'
		|| value === 'disk-cache-stale'
		|| value === 'client-cache'
		|| value.includes('reapply');
}

function __kustoShouldNotifyCrossClusterSchemaReady(source: any, requestedUri: string, requestedWasLoadedBefore: boolean, appliedToRequestedModel: boolean): boolean {
	if (!requestedUri || requestedWasLoadedBefore || !appliedToRequestedModel) {
		return false;
	}
	return !__kustoIsCrossClusterFreshAfterStaleSource(source);
}

function __kustoScheduleCrossClusterRefCheck(editor: any, boxId: any, initialDelayMs: number): void {
	const id = __kustoNormalizeCrossClusterBoxId(boxId);
	if (!id || !editor) {
		return;
	}
	__kustoTraceCrossCluster('ref-check-scheduled', { boxId: id, initialDelayMs });
	if (!__kustoCrossClusterCheckTimeout) {
		__kustoCrossClusterCheckTimeout = {};
	}
	__kustoClearCrossClusterCheckTimer(id);

	const run = () => {
		try { delete __kustoCrossClusterCheckTimeout[id]; } catch (e) { console.error('[kusto]', e); }
		try {
			const idleDelay = __kustoGetCrossClusterIdleDelay(id, CROSS_CLUSTER_SCHEMA_MIN_IDLE_MS);
			if (idleDelay > 0) {
				__kustoTraceCrossCluster('ref-check-idle-delay', { boxId: id, idleDelay });
				__kustoCrossClusterCheckTimeout[id] = setTimeout(run, Math.max(idleDelay, CROSS_CLUSTER_SCHEMA_IDLE_RETRY_FLOOR_MS));
				return;
			}
			if (!__kustoIsCurrentCrossClusterEditor(editor, id)) {
				__kustoTraceCrossCluster('ref-check-skipped-not-current', { boxId: id, activeQueryEditorBoxId });
				return;
			}
			if (__kustoCheckCrossClusterRefs !== null) {
				__kustoTraceCrossCluster('ref-check-running', { boxId: id });
				__kustoCheckCrossClusterRefs(editor.getValue(), id);
			}
		} catch (e) { console.error('[kusto]', e); }
	};

	__kustoCrossClusterCheckTimeout[id] = setTimeout(run, Math.max(0, initialDelayMs));
}

function __kustoScheduleCrossClusterSchemaApply(args: CrossClusterSchemaApplyArgs): void {
	const key = __kustoGetCrossClusterSchemaKey(args.clusterName, args.database);
	const modelUri = String(args.modelUri || '');
	const referenceGeneration = Number(args.referenceGeneration || 0);
	if (!key || key === '|' || !modelUri || !referenceGeneration) {
		return;
	}
	if (__kustoSupplementalApplyingSchemaKeys.has(key)) return;
	const jobKey = `${modelUri}\u0000${key}\u0000${referenceGeneration}\u0000${args.brokerRevision || 0}`;
	if (__kustoCrossClusterApplyTimeout[jobKey] || __kustoSupplementalQueuedApplyJobs.has(jobKey)) return;
	__kustoSupplementalQueuedApplyJobs.add(jobKey);
	__kustoSupplementalApplyingSchemaKeys.add(key);
	const expectedModel = __kustoSupplementalModelForUri(modelUri);
	const isCandidateCurrent = () => {
		const state = __kustoSupplementalCoordinator.getState(modelUri, key);
		const broker = __kustoCrossClusterSchemas[key];
		const model = __kustoSupplementalModelForUri(modelUri);
		return !!(state && state.referenceGeneration === referenceGeneration
			&& (state.status === 'fetched' || state.status === 'waiting-primary' || state.status === 'applying')
			&& state.modelVersion === args.modelVersion && state.primarySchemaKey === args.primarySchemaKey
			&& model && model === expectedModel && !model.isDisposed?.() && model.getVersionId?.() === args.modelVersion
			&& broker?.rawSchemaJson && (broker.revision || 0) === (args.brokerRevision || 0)
			&& args.primaryQueueGeneration !== undefined
			&& __kustoWorkerMutations.isPrimaryIntentCurrent(args.primaryQueueGeneration)
			&& __kustoIsSupplementalPrimaryReady(modelUri, args.primarySchemaKey));
	};
	const isCurrent = () => isCandidateCurrent()
		&& __kustoSupplementalCoordinator.getState(modelUri, key)?.status === 'applying';
	let activeApplyDeadlineAt: number | undefined;
	const ownsActiveApply = (state: KustoSupplementalSchemaState | undefined): state is KustoSupplementalSchemaState => !!(
		state
		&& state.referenceGeneration === referenceGeneration
		&& state.status === 'applying'
		&& activeApplyDeadlineAt !== undefined
		&& state.deadlineAt === activeApplyDeadlineAt
	);
	const finishJob = () => {
		__kustoSupplementalQueuedApplyJobs.delete(jobKey);
		__kustoSupplementalApplyingSchemaKeys.delete(key);
		try {
			if (__kustoCrossClusterApplyTimeout[jobKey]) clearTimeout(__kustoCrossClusterApplyTimeout[jobKey]);
		} catch { /* best effort */ }
		delete __kustoCrossClusterApplyTimeout[jobKey];
	};
	const resetStale = (reason: string) => {
		const state = __kustoSupplementalCoordinator.getState(modelUri, key);
		if (ownsActiveApply(state)) {
			__kustoSupplementalCoordinator.markFetched(supplementalStateIdentity(state));
			__kustoScheduleSupplementalPump(0);
		}
		__kustoTraceCrossCluster('apply-stale', { schemaKey: key, modelUri, reason });
	};
	__kustoTraceCrossCluster('apply-scheduled', { key, boxId: args.boxId, demanded: __kustoIsCrossClusterSchemaDemandedForAutocomplete(key), requestSource: args.requestSource, deliverySource: args.deliverySource || '', cacheAgeMs: (args as any).cacheAgeMs });
	const shouldSkipDisposedBox = () => {
		const id = __kustoNormalizeCrossClusterBoxId(args.boxId);
		return !expectedModel || expectedModel.isDisposed?.() || (id && !queryEditors?.[id]);
	};

	const run = () => {
		try { delete __kustoCrossClusterApplyTimeout[jobKey]; } catch (e) { console.error('[kusto]', e); }
		try {
			if (shouldSkipDisposedBox() || !isCandidateCurrent()) {
				__kustoTraceCrossCluster('apply-skipped-disposed', { key, boxId: args.boxId });
				finishJob();
				__kustoScheduleSupplementalPump(0);
				return;
			}
			const idleDelay = __kustoIsCrossClusterSchemaDemandedForAutocomplete(key)
				? 0
				: __kustoGetCrossClusterIdleDelay(args.boxId, CROSS_CLUSTER_SCHEMA_APPLY_MIN_IDLE_MS);
			if (idleDelay > 0) {
				__kustoTraceCrossCluster('apply-idle-delay', { key, boxId: args.boxId, idleDelay });
				__kustoCrossClusterApplyTimeout[jobKey] = setTimeout(run, Math.max(idleDelay, CROSS_CLUSTER_SCHEMA_IDLE_RETRY_FLOOR_MS));
				return;
			}

			let leaseActive = true;
			const operationPromise = __kustoWorkerMutations.enqueueLeased({
				request: { kind: 'supplemental-apply' },
				timeoutMs: CROSS_CLUSTER_SCHEMA_APPLY_TIMEOUT_MS,
				run: async transaction => {
				if (shouldSkipDisposedBox() || !isCandidateCurrent()) {
					__kustoTraceCrossCluster('apply-queued-skipped-disposed', { key, boxId: args.boxId });
					finishJob();
					__kustoScheduleSupplementalPump(0);
					return false;
				}
				const queuedIdleDelay = __kustoIsCrossClusterSchemaDemandedForAutocomplete(key)
					? 0
					: __kustoGetCrossClusterIdleDelay(args.boxId, CROSS_CLUSTER_SCHEMA_APPLY_MIN_IDLE_MS);
				if (queuedIdleDelay > 0) {
					__kustoTraceCrossCluster('apply-queued-idle-delay', { key, boxId: args.boxId, queuedIdleDelay });
					finishJob();
					__kustoScheduleSupplementalPump(queuedIdleDelay);
					return false;
				}
				activeApplyDeadlineAt = Date.now() + CROSS_CLUSTER_SCHEMA_APPLY_TIMEOUT_MS;
				const applying = __kustoSupplementalCoordinator.markApplying(
					{ modelUri, schemaKey: key, referenceGeneration },
					activeApplyDeadlineAt,
				);
				if (!applying || applying.status !== 'applying' || !isCurrent()) {
					finishJob();
					__kustoScheduleSupplementalPump(0);
					return false;
				}
				__kustoScheduleSupplementalDeadline();
				__kustoTraceCrossCluster('apply-start', { key, boxId: args.boxId, requestSource: args.requestSource, deliverySource: args.deliverySource || '', cacheAgeMs: (args as any).cacheAgeMs });
				return __kustoApplyCrossClusterSchemaInternal!(
					args.clusterName,
					args.clusterUrl,
					args.database,
					args.rawSchemaJson,
					args.boxId,
					args.deliverySource || '',
					(args as any).cacheAgeMs,
					args.modelUri || '',
					args.referenceGeneration || 0,
					args.modelVersion || 0,
					args.primarySchemaKey || '',
					args.brokerRevision || 0,
					transaction,
					() => leaseActive && isCurrent(),
				);
			},
			onTimeout: () => {
					leaseActive = false;
					const timedOutState = __kustoSupplementalCoordinator.getState(modelUri, key);
					if (ownsActiveApply(timedOutState)) {
						const failed = __kustoSupplementalCoordinator.markFailed(supplementalStateIdentity(timedOutState), 'apply-timeout');
						if (failed) void __kustoRevalidateSupplementalModel(modelUri, 'apply-timeout');
					}
					finishJob();
					__kustoTraceCrossCluster('apply-lease-timeout', { schemaKey: key, modelUri });
			},
			onDetachedSettled: async recoveryTransaction => {
				const boxId = String(queryEditorBoxByModelUri?.[modelUri] || args.boxId || '');
				await __kustoRecoverPrimarySchemaAfterDetachedMutation(recoveryTransaction, boxId, 'supplemental-timeout');
				__kustoTraceCrossCluster('apply-detached-settled-recovery', { schemaKey: key, modelUri, boxId });
			},
		}).then(lease => {
				if (lease.status === 'timed-out') return false;
				const terminalState = __kustoSupplementalCoordinator.getState(modelUri, key);
				if (ownsActiveApply(terminalState) && !isCurrent()) {
					resetStale('stale-after-worker-await');
				}
				finishJob();
				return lease.value;
			}).catch((e: any) => {
				console.error('[monaco-kusto] Cross-cluster schema operation failed:', e);
				finishJob();
				const state = __kustoSupplementalCoordinator.getState(modelUri, key);
				if (ownsActiveApply(state)) {
					const failed = __kustoSupplementalCoordinator.markFailed(supplementalStateIdentity(state), 'apply-failed');
					if (failed) void __kustoRevalidateSupplementalModel(modelUri, 'apply-failed');
				}
			});
		} catch (e) { console.error('[kusto]', e); }
	};

	__kustoCrossClusterApplyTimeout[jobKey] = setTimeout(run, 0);
}

// AMD globals loaded by require() — not available at module scope
// but referenced inside the require() callback and other functions.
declare const monaco: any;
declare const require: any;

// Derive `columnsByTable` from `columnTypesByTable` to avoid storing duplicate column lists.
// Falls back to legacy `columnsByTable` if present (older cached schema entries).
const __kustoColumnsByTableCache = (typeof WeakMap !== 'undefined') ? new WeakMap() : null;
export function __kustoGetColumnsByTable(schema: any) {
	try {
		if (!schema || typeof schema !== 'object') return null;
		if (schema.columnsByTable && typeof schema.columnsByTable === 'object') return schema.columnsByTable;
		const types = schema.columnTypesByTable;
		if (!types || typeof types !== 'object') return null;
		if (__kustoColumnsByTableCache) {
			const cached = __kustoColumnsByTableCache.get(schema);
			if (cached) return cached;
		}
		const out: any = {};
		for (const t of Object.keys(types)) {
			const m = types[t];
			if (!m || typeof m !== 'object') continue;
			out[t] = Object.keys(m).map((c) => String(c)).sort((a, b) => a.localeCompare(b));
		}
		if (__kustoColumnsByTableCache) {
			__kustoColumnsByTableCache.set(schema, out);
		}
		return out;
	} catch {
		return null;
	}
}

export function __kustoDisableMonacoKustoWorkerHover(monacoApi: any): boolean {
	try {
		const defaults = monacoApi?.languages?.kusto?.kustoDefaults;
		if (!defaults || typeof defaults.setLanguageSettings !== 'function') {
			return false;
		}
		const currentSettings = defaults.languageSettings;
		if (!currentSettings || typeof currentSettings !== 'object') {
			return false;
		}
		if (currentSettings.enableHover === false) {
			return true;
		}
		defaults.setLanguageSettings({
			...currentSettings,
			enableHover: false,
		});
		return true;
	} catch (e) {
		console.error('[kusto]', e);
		return false;
	}
}

function __kustoNormalizeMarkerValue(value: any): any {
	if (value === null || value === undefined) {
		return null;
	}
	if (Array.isArray(value)) {
		return value.map((item) => __kustoNormalizeMarkerValue(item));
	}
	if (typeof value !== 'object') {
		return value;
	}
	try {
		const proto = Object.getPrototypeOf(value);
		if (proto && proto !== Object.prototype && typeof value.toString === 'function') {
			const text = value.toString();
			if (text && text !== '[object Object]') {
				return text;
			}
		}
	} catch (e) { console.error('[kusto]', e); }
	const out: Record<string, any> = {};
	for (const key of Object.keys(value).sort()) {
		const next = value[key];
		if (typeof next === 'function') {
			continue;
		}
		out[key] = __kustoNormalizeMarkerValue(next);
	}
	return out;
}

function __kustoNormalizeMonacoMarker(marker: any): any {
	const rangeNumber = (value: any) => (typeof value === 'number' && Number.isFinite(value)) ? value : null;
	return {
		severity: marker?.severity ?? null,
		message: marker?.message ?? '',
		source: marker?.source ?? null,
		code: __kustoNormalizeMarkerValue(marker?.code),
		startLineNumber: rangeNumber(marker?.startLineNumber),
		startColumn: rangeNumber(marker?.startColumn),
		endLineNumber: rangeNumber(marker?.endLineNumber),
		endColumn: rangeNumber(marker?.endColumn),
		tags: __kustoNormalizeMarkerValue(marker?.tags),
		relatedInformation: __kustoNormalizeMarkerValue(marker?.relatedInformation),
	};
}

export function __kustoAreEquivalentMonacoMarkers(currentMarkers: any, nextMarkers: any): boolean {
	try {
		if (!Array.isArray(currentMarkers) || !Array.isArray(nextMarkers)) {
			return false;
		}
		if (currentMarkers.length !== nextMarkers.length) {
			return false;
		}
		const current = currentMarkers.map((marker) => JSON.stringify(__kustoNormalizeMonacoMarker(marker))).sort();
		const next = nextMarkers.map((marker) => JSON.stringify(__kustoNormalizeMonacoMarker(marker))).sort();
		for (let index = 0; index < current.length; index++) {
			if (current[index] !== next[index]) {
				return false;
			}
		}
		return true;
	} catch (e) {
		console.error('[kusto]', e);
		return false;
	}
}

function ensureMonaco() {
	if (monacoReadyPromise) {
		traceFileOpen('monaco.ensure.reuseExistingPromise');
		return monacoReadyPromise;
	}
	traceFileOpen('monaco.ensure.start');

	const waitForAmdLoader = () => {
		return new Promise((resolve, reject) => {
			let attempts = 0;
			const tick = () => {
				attempts++;
				try {
					const req = (typeof require !== 'undefined') ? require : (window && window.require ? window.require : undefined);
					if (typeof req === 'function' && typeof req.config === 'function') {
						traceFileOpen('monaco.amdLoader.ready', { attempts });
						resolve(req);
						return;
					}
				} catch (e) { console.error('[kusto]', e); }
				if (attempts >= 60) {
					traceFileOpen('monaco.amdLoader.timeout', { attempts });
					reject(new Error('Monaco AMD loader (require.js) not available in webview.'));
					return;
				}
				setTimeout(tick, 50);
			};
			tick();
		});
	};

	setMonacoReadyPromise(new Promise((resolve, reject) => {
		try {
			traceFileOpen('monaco.waitForAmdLoader.start');
			waitForAmdLoader().then((req) => {
				// Monaco workers run via AMD (workerMain.js → importScripts kustoWorker.js).
				// MonacoEnvironment.getWorkerUrl is configured in queryEditor.html
				// (blob URL workaround for VS Code webview cross-origin restrictions).

				try {
					(req as any).config({ paths: { vs: _win.__kustoQueryEditorConfig!.monacoVsUri } });
					traceFileOpen('monaco.require.configured');
				} catch (e) {
					reject(e);
					return;
				}

				// Load Monaco editor first, then monaco-kusto contribution module
				// (monaco-kusto depends on Monaco's Emitter and other core classes being available)
				// NOTE: monaco-kusto requires 'vs/editor/editor.main' - not the hashed API file
				traceFileOpen('monaco.editorMain.load.start');
				(req as any)(
					['vs/editor/editor.main'],
					() => {
						try {
							traceFileOpen('monaco.editorMain.load.done');
							if (typeof monaco === 'undefined' || !monaco || !monaco.editor) {
								throw new Error('Monaco loaded but global `monaco` API is missing.');
							}

							// ========================================================================
							// LAZY DIAGNOSTICS: Intercept setModelMarkers to suppress red squiggles
							// until the user focuses a query box and schema is loaded.
							// This prevents "phantom" errors appearing before we have schema context.
							// Also suppresses markers for models whose cluster doesn't match current context.
							// ========================================================================
							try {
								const originalSetModelMarkers = monaco.editor.setModelMarkers;
								__kustoPublishExactKustoMarkers = (model: any, markers: any[]) => {
									originalSetModelMarkers.call(monaco.editor, model, 'kusto', markers);
								};
								
								// Track which model URIs should have kusto markers enabled
								__kustoMarkersEnabledModels = new Set();
								
								// Track model URI -> normalized cluster URL mapping
								// This allows us to suppress markers for models that don't match the current context
								__kustoModelClusterMap = {};
								
								monaco.editor.setModelMarkers = function(model: any, owner: any, markers: any) {
									let normalizedMarkers = markers;
									// Only intercept kusto markers
									if (owner === 'kusto') {
										const uri = model && model.uri ? model.uri.toString() : '';
										const boxId = uri ? String(queryEditorBoxByModelUri?.[uri] || '') : '';
										if (boxId && schemaDiagnosticsTrustedByBoxId[boxId] === false) {
											return originalSetModelMarkers.call(this, model, owner, []);
										}
										if (!__kustoMarkersEnabledModels.has(uri)) {
											// Suppress markers for models that haven't been focused yet
											return;
										}
										// CRITICAL: Suppress markers for models whose cluster doesn't match current context
										// monaco-kusto validates ALL models when schema changes, but we only want errors
										// for models that match the current schema context
										const modelCluster = __kustoModelClusterMap[uri];
										const currentCluster = __kustoSchemaTracker.databaseInContext?.clusterUrl;
										if (modelCluster && currentCluster) {
											const modelClusterNorm = kustoClusterKey(modelCluster);
											const currentClusterNorm = kustoClusterKey(currentCluster);
											if (modelClusterNorm !== currentClusterNorm) {
												// This model belongs to a different cluster - suppress markers
												return;
											}
										}
										normalizedMarkers = Array.isArray(markers)
											? __kustoNormalizeCollapsedMonacoMarkers(model, markers)
											: markers;
										if (Array.isArray(normalizedMarkers) && uri) {
											const context = boxId ? __kustoGetSchemaContextForBox(boxId) : __kustoSchemaTracker.databaseInContext;
											normalizedMarkers = filterResolvableCrossClusterMarkers(
												typeof model.getValue === 'function' ? String(model.getValue() || '') : '',
												normalizedMarkers,
												{
													modelUri: uri,
													currentContext: context || undefined,
													getOffsetAt: (position) => typeof model.getOffsetAt === 'function' ? model.getOffsetAt(position) : 0,
													shouldSuppressDiagnostic: (schemaKey, modelUri) => __kustoSupplementalCoordinator.shouldSuppressDiagnostic(modelUri, schemaKey),
													trace: (event) => traceFileOpen('diagnostics.marker.suppressed', {
														code: event.code,
														schemaId: kustoSupplementalTraceId(event.schemaKey),
													}),
												}
											);
										}
										try {
											if (model && model.uri && Array.isArray(normalizedMarkers) && typeof monaco.editor.getModelMarkers === 'function') {
												const currentMarkers = monaco.editor.getModelMarkers({ owner: 'kusto', resource: model.uri });
												if (normalizedMarkers.length === 0 && __kustoAreEquivalentMonacoMarkers(currentMarkers, normalizedMarkers)) {
													return;
												}
											}
										} catch (e) { console.error('[kusto]', e); }
									}
									return originalSetModelMarkers.call(this, model, owner, normalizedMarkers);
								};
								
								// Function to enable markers for a specific model (called on focus AFTER schema context is set)
__kustoEnableMarkersForModel = function(modelUri: any) {
									if (!modelUri) return;
									const uri = typeof modelUri === 'string' ? modelUri : modelUri.toString();
									try {
										if (__kustoMarkerBlurClearTimers[uri]) {
											clearTimeout(__kustoMarkerBlurClearTimers[uri]);
											delete __kustoMarkerBlurClearTimers[uri];
										}
									} catch (e) { console.error('[kusto]', e); }
									if (!__kustoMarkersEnabledModels.has(uri)) {
										__kustoMarkersEnabledModels.add(uri);
									}
								};

__kustoScheduleDisableMarkersForModel = function(modelUri: any) {
									if (!modelUri || __kustoDisableMarkersForModel === null) return;
									const uri = typeof modelUri === 'string' ? modelUri : modelUri.toString();
									try {
										if (__kustoMarkerBlurClearTimers[uri]) {
											clearTimeout(__kustoMarkerBlurClearTimers[uri]);
										}
										__kustoMarkerBlurClearTimers[uri] = setTimeout(() => {
											try { delete __kustoMarkerBlurClearTimers[uri]; } catch (e) { console.error('[kusto]', e); }
											try { __kustoDisableMarkersForModel!(uri); } catch (e) { console.error('[kusto]', e); }
										}, KUSTO_MARKER_BLUR_CLEAR_DELAY_MS);
									} catch (e) { console.error('[kusto]', e); }
								};
								
								// Function to disable markers for a specific model (called on blur)
								// This removes the model from the enabled set and clears existing markers
__kustoDisableMarkersForModel = function(modelUri: any) {
									if (!modelUri) return;
									const uri = typeof modelUri === 'string' ? modelUri : modelUri.toString();
									try {
										if (__kustoMarkerBlurClearTimers[uri]) {
											clearTimeout(__kustoMarkerBlurClearTimers[uri]);
											delete __kustoMarkerBlurClearTimers[uri];
										}
									} catch (e) { console.error('[kusto]', e); }
									__kustoMarkersEnabledModels.delete(uri);
									// Also clear any existing markers for this model
									try {
										const model = monaco.editor.getModels().find((m: any) => m.uri && m.uri.toString() === uri);
										if (model) {
											originalSetModelMarkers.call(monaco.editor, model, 'kusto', []);
										}
									} catch (e) { console.error('[kusto]', e); }
								};
							} catch (e) { console.error('[kusto]', e); }

							// Now load monaco-kusto after Monaco is fully initialized
							traceFileOpen('monaco.kustoContribution.load.start');
							(req as any)(['vs/language/kusto/monaco.contribution'], () => {
								try {
									traceFileOpen('monaco.kustoContribution.load.done');
					__kustoDisableMonacoKustoWorkerHover(monaco);
					// monaco.languages.register({ id: 'kusto' });

					// ── Caret docs loaded from monaco-caret-docs.ts ──
					initCaretDocsDeps(monaco);

					monaco.languages.setMonarchTokensProvider('kusto', {
						keywords: [
							'and', 'as', 'by', 'case', 'contains', 'count', 'dcount', 'distinct', 'extend', 'externaldata',
							'false', 'from', 'has', 'has_any', 'has_all', 'in', 'invoke', 'join', 'kind', 'let', 'limit',
							'mv-expand', 'not', 'null', 'on', 'or', 'order', 'project', 'project-away', 'project-keep',
							'project-rename', 'render', 'sample', 'search', 'serialize', 'sort', 'summarize', 'take',
							'top', 'toscalar', 'true', 'union', 'where'
						],
						tokenizer: {
							root: [
								[/\/\*.*?\*\//, 'comment'],
								[/\/\/.*$/, 'comment'],
								[/'.*?'/, 'string'],
								[/"([^"\\]|\\.)*"/, 'string'],
								[/\b\d+(\.\d+)?\b/, 'number'],
								[/\|/, 'delimiter'],
								[/[=><!~]+/, 'operator'],
								[/\.[a-zA-Z_][\w\-]*/, 'keyword'],
								[/[a-zA-Z_][\w\-]*/, {
									cases: {
										'@keywords': 'keyword',
										'@default': 'identifier'
									}
								}],
								[/[{}()\[\]]/, '@brackets'],
								[/[,;.]/, 'delimiter']
							]
						}
					});
					monaco.languages.setLanguageConfiguration('kusto', {
						comments: { lineComment: '//', blockComment: ['/*', '*/'] },
						brackets: [['{', '}'], ['[', ']'], ['(', ')']],
						autoClosingPairs: [
							{ open: '{', close: '}' },
							{ open: '[', close: ']' },
							{ open: '(', close: ')' },
							{ open: "'", close: "'" },
							{ open: '"', close: '"' }
						],
						surroundingPairs: [
							{ open: '{', close: '}' },
							{ open: '[', close: ']' },
							{ open: '(', close: ')' },
							{ open: "'", close: "'" },
							{ open: '"', close: '"' }
						]
					});

					// Basic formatter so users can format the whole query.
					const formatKusto = (input: any) => {
						const raw = String(input || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
						const lines = raw.split('\n');
						const out = [];
						let blankRun = 0;
						for (let line of lines) {
							line = String(line).replace(/[ \t]+$/g, '');
							if (!line.trim()) {
								blankRun++;
								if (blankRun <= 2) {
									out.push('');
								}
								continue;
							}
							blankRun = 0;
							// Normalize leading whitespace.
							line = line.replace(/^\s+/g, '');
							// Normalize pipe operator lines: "| foo".
							if (/^\|/.test(line)) {
								line = '| ' + line.slice(1).replace(/^\s+/g, '');
							}
							out.push(line);
						}
						// Trim leading/trailing blank lines.
						while (out.length && !out[0].trim()) out.shift();
						while (out.length && !out[out.length - 1].trim()) out.pop();
						return out.join('\n');
					};

					monaco.languages.registerDocumentFormattingEditProvider('kusto', {
						provideDocumentFormattingEdits(model: any) {
							try {
								const original = model.getValue();
								const formatted = formatKusto(original);
								if (formatted === original) {
									return [];
								}
								return [{ range: model.getFullModelRange(), text: formatted }];
							} catch {
								return [];
							}
						}
					});

					// Text-based rename: finds all exact-match occurrences of the word under cursor.
					monaco.languages.registerRenameProvider('kusto', {
						provideRenameEdits(model: any, position: any, newName: string) {
							try {
								const wordAtPos = model.getWordAtPosition(position);
								if (!wordAtPos) return { edits: [] };
								const oldName = wordAtPos.word;
								if (oldName === newName) return { edits: [] };
								const matches = model.findMatches(oldName, true, false, true, `\`~!@#$%^&*()-=+[{]}\\|;:'",.<>/?`, true);
								const edits = matches.map((m: any) => ({
									resource: model.uri,
									versionId: model.getVersionId(),
									textEdit: { range: m.range, text: newName },
								}));
								return { edits };
							} catch {
								return { edits: [] };
							}
						},
						resolveRenameLocation(model: any, position: any) {
							const wordAtPos = model.getWordAtPosition(position);
							if (!wordAtPos) return { text: '', range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column), rejectReason: 'No symbol at this position' };
							return {
								text: wordAtPos.word,
								range: new monaco.Range(position.lineNumber, wordAtPos.startColumn, position.lineNumber, wordAtPos.endColumn),
							};
						},
					});

								// Use custom themes that match VS Code's editor background
								applyMonacoTheme(monaco);
					// Autocomplete: pipe operators + (optionally) schema tables/columns.
					// Keep a reference to our completion provider so diagnostics can be filtered
					// using the exact same suggestion logic ("if it's in autocomplete, it must not squiggle").
					// Completion provider and diagnostics extracted to monaco-completions.ts / monaco-diagnostics.ts.
					// Inject dependencies from this AMD callback scope into the completion provider module.
					__kustoInitCompletionDeps({
						KUSTO_FUNCTION_DOCS,
						KUSTO_KEYWORD_DOCS,
						KUSTO_CONTROL_COMMAND_DOCS_BASE_URL,
						KUSTO_CONTROL_COMMAND_DOCS_VIEW,
						__kustoControlCommands,
						findEnclosingFunctionCall,
						getTokenAtPosition,
						__kustoGetStatementStartAtOffset,
						__kustoScanIdentifiers,
						__kustoSplitTopLevelStatements,
						__kustoSplitPipelineStagesDeep,
						__kustoGetColumnsByTable,
						ensureSchemaForBox,
					});


					// Hover docs for keywords/functions, including argument tracking for function calls.
					monaco.languages.registerHoverProvider('kusto', {
						provideHover: function (model: any, position: any) {
							try {
								const modelUri = model.uri ? model.uri.toString() : '';
								const bId = queryEditorBoxByModelUri[modelUri] || '';
								const info = getHoverInfoAt(model, position, bId);
								if (!info) {
									return null;
								}
								// Strip custom {{sig}}...{{/sig}} markers and render as styled HTML.
								// Monaco's DOMPurify allows <span style="color:..."> when isTrusted + supportHtml.
								// Only color, background-color, border-radius are whitelisted (each must end with ;).
								const sigColor = 'var(--vscode-symbolIcon-functionForeground)';
								const activeColor = 'var(--vscode-editorInfo-foreground)';
								const cleaned = String(info.markdown || '')
									.replace(/\{\{sig\}\}([\s\S]*?)\{\{\/sig\}\}/g, (_: any, inner: any) => {
										const withActive = String(inner).replace(/\*\*([^*]+)\*\*/g,
											'<span style="color:' + activeColor + ';">' + '**$1**' + '</span>');
										return '<span style="color:' + sigColor + ';">' + withActive + '</span>';
									});
								// Split signature and description into separate content blocks
								// so Monaco renders them with a visual separator between them.
								const parts = cleaned.split(/\n\n/);
								const contents = parts.filter(Boolean).map((p: string) => ({
									value: p,
									supportHtml: true,
									isTrusted: true,
								} as any));
								return {
									range: info.range || undefined,
									contents
								};
							} catch {
								return null;
							}
						}
					});

					// Expose a helper so the editor instance can decide whether to auto-show hover.
					__kustoGetHoverInfoAt = getHoverInfoAt;

					// --- monaco-kusto integration ---
					// Track which schemas have been loaded into the monaco-kusto worker
					// Key: "clusterUrl|database" -> true
					// This is separate from our UI schema cache - this tracks what's IN the worker
					// IMPORTANT: monaco-kusto keeps schema state per Monaco model URI (workerAccessor(modelUri)).
					// If we always target models[0], schema/context updates apply to the wrong query box.
					__kustoSchemaTracker.globalInitialized = false; // legacy/global (kept for logs)
					// Track the current database in context: { clusterUrl, database }
					__kustoSchemaTracker.databaseInContext = null; // legacy/global (current focused model)
					__kustoSchemaContextIntents.clear();
					
					// Cache all raw schema data we receive, so we can re-add them after cluster switches
					// Key: `${clusterUrl}|${database}`, Value: { rawSchemaJson, clusterUrl, database }
					__kustoSchemaTracker.schemaCache = {};
					
					// Mutex to serialize schema operations - prevents race conditions during parallel loads
					
					// Function to set/add schema in monaco-kusto worker for full IntelliSense support
					// Uses aggregate approach: first schema uses setSchemaFromShowSchema, 
					// subsequent schemas use addDatabaseToSchema to ADD without replacing
					_win.__kustoSetMonacoKustoSchema = async function (rawSchemaJson: any, clusterUrl: any, database: any, setAsContext = false, modelUri: any = null, forceRefresh = false, guard?: () => boolean, preparationToken?: KustoPreparationToken, contextIntent?: KustoSchemaContextIntent, connectionId = '', accountPartition = '') {
						const schemaKey = getKustoSchemaIdentityKey(connectionId, accountPartition, clusterUrl, database);
						if (!schemaKey) return false;
						// Serialize schema operations to prevent race conditions
						traceFileOpen('monaco.schema.queue.requested', { clusterUrl, database, setAsContext, modelUri, forceRefresh });
						const requestedModelKey = modelUri ? (typeof modelUri === 'string' ? modelUri : modelUri.toString()) : '';
						const claimedContextIntent = setAsContext
							? (contextIntent || __kustoClaimSchemaContextIntent(
								String(preparationToken?.boxId || queryEditorBoxByModelUri?.[requestedModelKey] || activeQueryEditorBoxId || ''),
								String(clusterUrl || ''),
								String(database || ''),
								requestedModelKey,
								String(connectionId || ''),
								String(accountPartition || ''),
							))
							: undefined;
						const operationPromise = __kustoWorkerMutations.enqueue({ kind: 'primary-apply', advancesPrimaryIntent: true }, async transaction => {
							if (guard && !guard()) {
								traceFileOpen('monaco.schema.queue.skip.stalePreparation', { clusterUrl, database, modelUri });
								return false;
							}
							const effectiveSetAsContext = setAsContext && (!claimedContextIntent || __kustoSchemaContextIntents.isCurrent(claimedContextIntent));
							traceFileOpen('monaco.schema.queue.start', { clusterUrl, database, setAsContext: effectiveSetAsContext, requestedSetAsContext: setAsContext, modelUri, forceRefresh });
							const result = await __kustoSetMonacoKustoSchemaInternal!(rawSchemaJson, clusterUrl, database, transaction, effectiveSetAsContext, modelUri, forceRefresh, guard, preparationToken, claimedContextIntent, connectionId, accountPartition);
							traceFileOpen('monaco.schema.queue.done', { clusterUrl, database, result });
							return result;
						}).catch((e: any) => {
							console.error('[monaco-kusto] Queued operation failed:', e);
							traceFileOpen('monaco.schema.queue.error', { clusterUrl, database, error: e instanceof Error ? e.message : String(e) });
							return false;
						});
						return operationPromise;
					};
					
					// Internal implementation - called through the queue
__kustoSetMonacoKustoSchemaInternal = async function (rawSchemaJson: any, clusterUrl: any, database: any, transaction: KustoWorkerMutationTransaction, setAsContext = false, modelUri: any = null, forceRefresh = false, guard?: () => boolean, preparationToken?: KustoPreparationToken, contextIntent?: KustoSchemaContextIntent, connectionId = '', accountPartition = '') {
						const isOperationCurrent = () => transaction.isActive() && (!guard || guard());
						const isContextIntentCurrent = () => !contextIntent || __kustoSchemaContextIntents.isCurrent(contextIntent);
						if (!isOperationCurrent()) return false;
						// Resolve which Monaco model this operation applies to
						const models = monaco?.editor?.getModels ? monaco.editor.getModels() : [];
						traceFileOpen('monaco.schema.internal.start', { clusterUrl, database, setAsContext, modelUri, forceRefresh, modelCount: models?.length || 0, rawKind: typeof rawSchemaJson });
						if (!models || models.length === 0) {
							traceFileOpen('monaco.schema.internal.skip.noModels', { clusterUrl, database });
							return false;
						}
						// Install model-dispose hook (once) to clean up per-model caches.
						try {
							if (!__kustoMonacoModelDisposeHookInstalled && monaco?.editor?.onWillDisposeModel) {
								__kustoMonacoModelDisposeHookInstalled = true;
								monaco.editor.onWillDisposeModel((model: any) => {
									try {
										const uriKey = model?.uri ? model.uri.toString() : null;
										if (!uriKey) return;
										__kustoSchemaTracker.disposeModel(uriKey);
										try { delete __kustoMonacoDatabaseInContextByModel[uriKey]; } catch (e) { console.error('[kusto]', e); }
										try { delete __kustoMonacoInitializedByModel[uriKey]; } catch (e) { console.error('[kusto]', e); }
										try { delete __kustoModelClusterMap[uriKey]; } catch (e) { console.error('[kusto]', e); }
										try { __kustoCustomColumnCompletionProviderDisabledModels.delete(uriKey); } catch (e) { console.error('[kusto]', e); }
										try { __kustoClearAutocompleteTraceForModel(uriKey); } catch (e) { console.error('[kusto]', e); }
										try { __kustoDisposeSupplementalModel(uriKey); } catch (e) { console.error('[kusto]', e); }
									} catch (e) { console.error('[kusto]', e); }
								});
							}
						} catch (e) { console.error('[kusto]', e); }

						const modelKey = modelUri ? (typeof modelUri === 'string' ? modelUri : modelUri.toString()) : models[0].uri.toString();
						if (!isOperationCurrent()) return false;
						const preparationBoxId = String(queryEditorBoxByModelUri?.[modelKey] || preparationToken?.boxId || '');
						__kustoMonacoDatabaseInContextByModel[modelKey] = __kustoMonacoDatabaseInContextByModel[modelKey] || null;
						__kustoMonacoInitializedByModel[modelKey] = !!__kustoMonacoInitializedByModel[modelKey];

						const schemaKey = getKustoSchemaIdentityKey(connectionId, accountPartition, clusterUrl, database);
						if (!schemaKey) return false;
						traceFileOpen('monaco.schema.internal.modelResolved', { schemaKey, modelKey });
						
						// Normalize cluster URLs for comparison (used for marker clearing)
						const normalizeClusterUrl = (url: any) => kustoClusterKey(url);

						// ── Decision: delegated to the tested SchemaTracker ──
						const forcePrimaryReplace = !!preparationBoxId && __kustoForcePrimaryReplaceByBoxId.delete(preparationBoxId);
						const decision = __kustoSchemaTracker.decide(modelKey, clusterUrl, database, connectionId, accountPartition, setAsContext, forceRefresh);
						const operation = forcePrimaryReplace && __kustoSchemaTracker.globalInitialized
							? { action: 'replace' as const, reason: 'supplemental-timeout-recovery' }
							: decision.operation;
						const alreadyLoaded = decision.alreadyLoaded;
						traceFileOpen('monaco.schema.decision', { schemaKey, modelKey, action: operation.action, alreadyLoaded, setAsContext, forceRefresh });

						// ── Schema diagnostics: decision ──
						console.log(
							'%c[schema-diag] DECISION: %s | schema: %s | model: %s | setAsContext: %s | forceRefresh: %s | perModelLoaded: %s | globalInit: %s | ctx: %s/%s',
							'color:#ff0;font-weight:bold',
							operation.action + ('reason' in operation ? ` (${(operation as any).reason})` : ''),
							schemaKey, modelKey.replace(/.*\//, ''),
							setAsContext, forceRefresh, alreadyLoaded, __kustoSchemaTracker.globalInitialized,
							__kustoSchemaTracker.databaseInContext?.clusterUrl || '(none)', __kustoSchemaTracker.databaseInContext?.database || '(none)'
						);
						recordAutocompleteTrace(__kustoGetAutocompleteTraceIdForModel(modelKey), 'worker-schema-decision', {
							operation,
							schemaKey,
							modelKey,
							setAsContext,
							forceRefresh,
							alreadyLoaded,
							globalInitialized: __kustoSchemaTracker.globalInitialized,
							currentContext: __kustoSchemaTracker.databaseInContext,
						});

						if (operation.action === 'skip') {
							traceFileOpen('monaco.schema.internal.skip.decision', { schemaKey, modelKey });
							return true;
						}
						// If the decision says we need to act but the schema was "already loaded",
						// clear the per-model tracking so the load/replace can proceed.
						if (alreadyLoaded) {
							const perModel = __kustoSchemaTracker.loadedSchemasByModel[modelKey];
							if (perModel) delete perModel[schemaKey];
						}
						
						try {
							let applied = false;
							if (!rawSchemaJson || !clusterUrl || !database) {
								traceFileOpen('monaco.schema.internal.skip.missingInput', { hasRawSchemaJson: !!rawSchemaJson, hasClusterUrl: !!clusterUrl, hasDatabase: !!database });
								return false;
							}
							
							// Normalize the schema JSON
							let schemaObj = rawSchemaJson;
							if (typeof rawSchemaJson === 'string') {
								traceFileOpen('monaco.schema.parse.start', { schemaKey });
								try { schemaObj = JSON.parse(rawSchemaJson); } catch (e) { console.error('[monaco-kusto] Failed to parse schema JSON:', e); return false; }
								traceFileOpen('monaco.schema.parse.done', { schemaKey });
							}
							if (schemaObj && schemaObj.Databases && !schemaObj.Plugins) {
								schemaObj = { Plugins: [], ...schemaObj };
							}
							schemaObj = stampKustoSchemaMajorVersion(__kustoPrepareSchemaForKustoWorker(schemaObj), transaction.id);
							traceFileOpen('monaco.schema.prepare.done', { schemaKey, databaseCount: schemaObj?.Databases ? Object.keys(schemaObj.Databases).length : undefined });
							
							// Get the kusto worker
							if (monaco && monaco.languages && monaco.languages.kusto && typeof monaco.languages.kusto.getKustoWorker === 'function') {
								const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout getting kusto worker')), 10000));
								traceFileOpen('monaco.schema.workerAccessor.start', { schemaKey });
								const workerAccessor = await Promise.race([monaco.languages.kusto.getKustoWorker(), timeoutPromise]);
								traceFileOpen('monaco.schema.workerAccessor.done', { schemaKey });
								
								if (modelKey) {
									traceFileOpen('monaco.schema.workerProxy.start', { schemaKey, modelKey });
									const worker = await Promise.race([
										workerAccessor(monaco.Uri.parse(modelKey)),
										new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout getting worker proxy')), 10000))
									]);
									traceFileOpen('monaco.schema.workerProxy.done', { schemaKey, hasWorker: !!worker });
									if (!worker) return false;
									
									// Resolve database name case from schema
									let databaseInContext = database;
									if (schemaObj?.Databases) {
										const dbKeys = Object.keys(schemaObj.Databases);
										if (!dbKeys.includes(database)) {
											const matchedKey = dbKeys.find((k: string) => k.toLowerCase() === database.toLowerCase());
											if (matchedKey) databaseInContext = matchedKey;
										}
									}
									
									// ── FIRST-LOAD ──────────────────────────────────────────
									if (operation.action === 'first-load') {
										if (typeof worker.setSchemaFromShowSchema === 'function') {
											try {
												if (!isOperationCurrent()) return false;
												if (setAsContext && !isContextIntentCurrent()) return false;
												traceFileOpen('monaco.schema.worker.setSchemaFromShowSchema.start', { schemaKey, action: operation.action });
												await worker.setSchemaFromShowSchema(schemaObj, clusterUrl, databaseInContext);
												if (!transaction.commit({ destructive: true })) return false;
												invalidateSchemaWorkerReadiness(preparationBoxId);
												__kustoInvalidateSupplementalApplicationsAfterWorkerReplace('primary-first-load');
												if (!isOperationCurrent()) return false;
												traceFileOpen('monaco.schema.worker.setSchemaFromShowSchema.done', { schemaKey, action: operation.action });
												recordAutocompleteTrace(__kustoGetAutocompleteTraceIdForModel(modelKey), 'worker-schema-first-load', { modelKey, clusterUrl, database: databaseInContext });
												await __kustoAddDatabaseAliasesToWorker(worker, modelKey, schemaObj, clusterUrl, clusterUrl, databaseInContext, transaction, isOperationCurrent);
												if (!isOperationCurrent()) return false;
												__kustoSchemaTracker.recordFirstLoad(modelKey, schemaKey, clusterUrl, databaseInContext, connectionId, accountPartition, schemaObj);
												__kustoMonacoInitializedByModel[modelKey] = true;
												__kustoMonacoDatabaseInContextByModel[modelKey] = { clusterUrl, database: databaseInContext, connectionId, accountPartition, schemaKey };
												applied = true;
											} catch (schemaError) {
												console.error('[monaco-kusto] setSchemaFromShowSchema failed:', schemaError);
											}
										}
									// ── REPLACE ──────────────────────────────────────────────
									} else if (operation.action === 'replace') {
										if (typeof worker.setSchemaFromShowSchema === 'function') {
											try {
												if (!isOperationCurrent()) return false;
												if (setAsContext && !isContextIntentCurrent()) return false;
												traceFileOpen('monaco.schema.worker.setSchemaFromShowSchema.start', { schemaKey, action: operation.action });
												await worker.setSchemaFromShowSchema(schemaObj, clusterUrl, databaseInContext);
												if (!transaction.commit({ destructive: true })) return false;
												invalidateSchemaWorkerReadiness(preparationBoxId);
												__kustoInvalidateSupplementalApplicationsAfterWorkerReplace('primary-replace');
												if (!isOperationCurrent()) return false;
												traceFileOpen('monaco.schema.worker.setSchemaFromShowSchema.done', { schemaKey, action: operation.action });
												recordAutocompleteTrace(__kustoGetAutocompleteTraceIdForModel(modelKey), 'worker-schema-replace', { modelKey, clusterUrl, database: databaseInContext });
												await __kustoAddDatabaseAliasesToWorker(worker, modelKey, schemaObj, clusterUrl, clusterUrl, databaseInContext, transaction, isOperationCurrent);
												if (!isOperationCurrent()) return false;
												const otherKeys = __kustoSchemaTracker.recordReplace(modelKey, schemaKey, clusterUrl, databaseInContext, connectionId, accountPartition, schemaObj);
												__kustoMonacoInitializedByModel[modelKey] = true;
												__kustoMonacoDatabaseInContextByModel[modelKey] = { clusterUrl, database: databaseInContext, connectionId, accountPartition, schemaKey };
												applied = true;

												// ── Schema diagnostics: replace completed ──
												console.log(
													'%c[schema-diag] REPLACE done → new context: %s/%s | re-adding %d other schemas: %s',
													'color:#0f0',
													clusterUrl, databaseInContext,
													otherKeys.length,
													otherKeys.join(', ') || '(none)'
												);
												
												// Re-add all other cached schemas
												traceFileOpen('monaco.schema.readdCached.start', { schemaKey, count: otherKeys.length });
												for (const otherKey of otherKeys) {
													const cached = __kustoSchemaTracker.schemaCache[otherKey];
													if (cached?.rawSchemaJson) {
														try {
															if (!isOperationCurrent()) return false;
															const cachedSchemaForWorker = stampKustoSchemaMajorVersion(__kustoPrepareSchemaForKustoWorker(cached.rawSchemaJson), transaction.id);
															const engineSchema = await worker.normalizeSchema(cachedSchemaForWorker, cached.clusterUrl, cached.database);
															if (!isOperationCurrent()) return false;
															let databaseSchema = engineSchema?.database;
															if (!databaseSchema && engineSchema?.cluster?.databases) {
																databaseSchema = engineSchema.cluster.databases.find((db: any) => db.name.toLowerCase() === cached.database.toLowerCase());
															}
															if (databaseSchema) {
																if (!isOperationCurrent()) return false;
																await worker.addDatabaseToSchema(modelKey, cached.clusterUrl, databaseSchema);
																if (!transaction.commit()) return false;
															}
														} catch (readdError) { console.error('[kusto]', readdError); }
													}
												}
												traceFileOpen('monaco.schema.readdCached.done', { schemaKey, count: otherKeys.length });

												// Clear markers for boxes that don't match the new context
												const newClusterNorm = normalizeClusterUrl(clusterUrl);
												const allQueryBoxes = document.querySelectorAll('kw-query-section.query-box[box-id]');
												allQueryBoxes.forEach(box => {
													const otherBoxId = box.getAttribute('box-id');
													const boxEditor = queryEditors?.[otherBoxId as string];
													if (boxEditor) {
														const boxCluster = typeof (box as any).getClusterUrl === 'function' ? (box as any).getClusterUrl() : '';
														const boxClusterNorm = boxCluster ? normalizeClusterUrl(boxCluster) : null;
														if (boxClusterNorm && boxClusterNorm !== newClusterNorm) {
															const boxModel = boxEditor.getModel();
															if (boxModel) monaco.editor.setModelMarkers(boxModel, 'kusto', []);
														}
													}
												});
											} catch (schemaError) {
												console.error('[monaco-kusto] REPLACE: setSchemaFromShowSchema failed:', schemaError);
											}
										}
										traceFileOpen('monaco.schema.readdCrossCluster.done', { schemaKey, count: __kustoSupplementalCoordinator.getStatesForModel(modelKey).length });
									// ── ADD ──────────────────────────────────────────────────
									} else if (operation.action === 'add') {
										let alreadyLoadedGlobally = !forceRefresh && __kustoSchemaTracker.isLoadedGlobally(schemaKey);
										if (alreadyLoadedGlobally) {
											if (!isOperationCurrent()) return false;
											__kustoSchemaTracker.recordAdoptGlobal(modelKey, schemaKey, clusterUrl, databaseInContext, connectionId, accountPartition, schemaObj);
											applied = true;
											if (setAsContext) {
												if (isContextIntentCurrent()) {
													if (!isOperationCurrent()) return false;
													const switched = await __kustoSetDatabaseInContext!(clusterUrl, databaseInContext, transaction, modelKey, isContextIntentCurrent, connectionId, accountPartition);
													applied = switched || !isContextIntentCurrent();
												}
												if (!applied) {
													__kustoSchemaTracker.invalidateGlobal(schemaKey, modelKey);
													alreadyLoadedGlobally = false;
												}
											}
										}
										if (!alreadyLoadedGlobally && typeof worker.normalizeSchema === 'function' && typeof worker.addDatabaseToSchema === 'function') {
											try {
												traceFileOpen('monaco.schema.worker.normalizeSchema.start', { schemaKey });
												const engineSchema = await worker.normalizeSchema(__kustoPrepareSchemaForKustoWorker(schemaObj), clusterUrl, databaseInContext);
												traceFileOpen('monaco.schema.worker.normalizeSchema.done', { schemaKey });
												let databaseSchema = engineSchema?.database;
												if (!databaseSchema && engineSchema?.cluster?.databases) {
													databaseSchema = engineSchema.cluster.databases.find((db: any) => db.name.toLowerCase() === databaseInContext.toLowerCase());
												}
												if (databaseSchema) {
													if (!isOperationCurrent()) return false;
													traceFileOpen('monaco.schema.worker.addDatabaseToSchema.start', { schemaKey });
													await worker.addDatabaseToSchema(modelKey, clusterUrl, databaseSchema);
													if (!transaction.commit()) return false;
													if (!isOperationCurrent()) return false;
													traceFileOpen('monaco.schema.worker.addDatabaseToSchema.done', { schemaKey });
													recordAutocompleteTrace(__kustoGetAutocompleteTraceIdForModel(modelKey), 'worker-schema-add', { modelKey, clusterUrl, database: databaseInContext });
													await __kustoAddDatabaseAliasesToWorker(worker, modelKey, schemaObj, clusterUrl, clusterUrl, databaseInContext, transaction, isOperationCurrent);
													if (!isOperationCurrent()) return false;
													__kustoSchemaTracker.recordAdd(modelKey, schemaKey, clusterUrl, databaseInContext, connectionId, accountPartition, schemaObj, false);
													applied = true;
													// For setAsContext, also try getSchema/setSchema for reliable context switch
													if (setAsContext && isContextIntentCurrent() && isOperationCurrent()) {
														try {
															if (typeof worker.getSchema === 'function' && typeof worker.setSchema === 'function') {
																const currentSchema = await worker.getSchema();
																const currentDatabases = currentSchema?.cluster?.databases || [];
																const existingDb = currentDatabases.find((db: any) => db?.name?.toLowerCase?.() === databaseSchema.name.toLowerCase());
																const nextDatabases = existingDb
																	? currentDatabases.map((db: any) => db?.name?.toLowerCase?.() === databaseSchema.name.toLowerCase() ? databaseSchema : db)
																	: [...currentDatabases, databaseSchema];
																if (!isOperationCurrent()) return false;
																if (isContextIntentCurrent()) {
																	await worker.setSchema({ ...currentSchema, cluster: { ...(currentSchema?.cluster || {}), databases: nextDatabases }, database: databaseSchema });
																	if (!transaction.commit({ destructive: true })) return false;
																	__kustoInvalidateSupplementalApplicationsAfterWorkerReplace('primary-add-context');
																	await __kustoRestoreOtherPrimaryApplicationsAfterWorkerReplace(worker, modelKey, 'primary-add-context', transaction);
																	if (isContextIntentCurrent() && isOperationCurrent()) {
																		__kustoSchemaTracker.recordAdd(modelKey, schemaKey, clusterUrl, databaseInContext, connectionId, accountPartition, schemaObj, true);
																		__kustoMonacoDatabaseInContextByModel[modelKey] = { clusterUrl, database: databaseInContext, connectionId, accountPartition, schemaKey };
																	}
																}
															}
														} catch { /* best effort */ }
													}
												}
											} catch (addError) {
												console.error('[monaco-kusto] ADD: addDatabaseToSchema failed:', addError);
											}
										} else if (!alreadyLoadedGlobally && setAsContext && isContextIntentCurrent()) {
											// Fallback: setSchemaFromShowSchema (will replace, but better than nothing)
											if (typeof worker.setSchemaFromShowSchema === 'function') {
												try {
													if (!isOperationCurrent()) return false;
													await worker.setSchemaFromShowSchema(__kustoPrepareSchemaForKustoWorker(schemaObj), clusterUrl, databaseInContext);
													if (!transaction.commit({ destructive: true })) return false;
													invalidateSchemaWorkerReadiness(preparationBoxId);
													__kustoInvalidateSupplementalApplicationsAfterWorkerReplace('primary-fallback');
													if (!isOperationCurrent()) return false;
													recordAutocompleteTrace(__kustoGetAutocompleteTraceIdForModel(modelKey), 'worker-schema-fallback-first-load', { modelKey, clusterUrl, database: databaseInContext });
													await __kustoAddDatabaseAliasesToWorker(worker, modelKey, schemaObj, clusterUrl, clusterUrl, databaseInContext, transaction, isOperationCurrent);
													if (!isOperationCurrent()) return false;
													__kustoSchemaTracker.recordFirstLoad(modelKey, schemaKey, clusterUrl, databaseInContext, connectionId, accountPartition, schemaObj);
													__kustoMonacoInitializedByModel[modelKey] = true;
													__kustoMonacoDatabaseInContextByModel[modelKey] = { clusterUrl, database: databaseInContext, connectionId, accountPartition, schemaKey };
													applied = true;
												} catch (e) {
													console.error('[monaco-kusto] Fallback setSchemaFromShowSchema failed:', e);
												}
											}
										}
									}
									if (applied) {
										__kustoScheduleEnhancedSchemaApply({
											worker,
											schemaObj,
											clusterUrl,
											database,
											connectionId,
											accountPartition,
											databaseInContext,
											schemaKey,
											modelKey,
											setAsContext,
											preparationToken,
											contextIntent,
										});
									}
								}
							}
							return applied;
						} catch (e) {
							console.error('[monaco-kusto] Failed to set schema:', e);
							return false;
						}
					};
					
					// Function to switch the "database in context" without reloading schemas
					// This allows unqualified table names to resolve to the correct database
					// Returns true if context switch succeeded, false otherwise
__kustoSetDatabaseInContext = async function (clusterUrl: any, database: any, transaction: KustoWorkerMutationTransaction, modelUri = null, guard?: () => boolean, connectionId = '', accountPartition = '') {
						// Normalize cluster URLs for comparison
						const normalizeClusterUrl = (url: any) => kustoClusterKey(url);
						const isCurrent = () => transaction.isActive() && (!guard || guard());
						if (!isCurrent()) return false;
						
						const models = monaco?.editor?.getModels ? monaco.editor.getModels() : [];
						if (!models || models.length === 0) {
							return false;
						}
						const modelKey = modelUri ? (typeof modelUri === 'string' ? modelUri : (modelUri as any).toString()) : models[0].uri.toString();
						const currentContext = __kustoSchemaTracker.databaseInContext;
						const targetSchemaKey = getKustoSchemaIdentityKey(connectionId, accountPartition, clusterUrl, database);
						if (!targetSchemaKey || currentContext?.accountPartition !== accountPartition) return false;
						
						// Check if already in this context (use normalized comparison for cluster URL)
						const currentClusterNorm = normalizeClusterUrl(currentContext?.clusterUrl);
						const newClusterNorm = normalizeClusterUrl(clusterUrl);
						if (currentContext && 
							currentClusterNorm === newClusterNorm && 
							currentContext.database?.toLowerCase() === database?.toLowerCase()) {
							return true;
						}
						
						try {
							if (!monaco?.languages?.kusto?.getKustoWorker) {
								return false;
							}
							
							const workerAccessor = await monaco.languages.kusto.getKustoWorker();
							const worker = await workerAccessor(monaco.Uri.parse(modelKey));
							if (!isCurrent()) return false;
							
							if (!worker || typeof worker.getSchema !== 'function' || typeof worker.setSchema !== 'function') {
								return false;
							}
							
							// Get the current aggregated schema
							const currentSchema = await worker.getSchema();
							if (!isCurrent()) return false;

							if (!currentSchema || currentSchema.clusterType !== 'Engine') {
								return false;
							}
							const workerClusterUrl = String(
								currentSchema.cluster?.connectionString
								|| currentSchema.cluster?.dataSource
								|| currentSchema.cluster?.uri
								|| '',
							);
							if (!canUseKustoDatabaseContextFastPath({
								targetClusterUrl: String(clusterUrl || ''),
								trackedClusterUrl: currentContext?.clusterUrl,
								workerClusterUrl,
							})) {
								return false;
							}
							
							const databases = currentSchema.cluster?.databases || [];
							
							// Find the database to set as context
							const targetDatabase = databases.find((db: any) => 
								db.name.toLowerCase() === database.toLowerCase()
							);
							
							if (!targetDatabase) {
								// Database not found in primary cluster's databases.
								// This can happen when the database was added via addDatabaseToSchema for a different cluster.
								// Returning false signals the caller to do a full schema reload.
								return false;
							}
							
							// Create updated schema with new database in context
							const updatedSchema = {
								...currentSchema,
								database: targetDatabase
							};
							if (!isCurrent()) return false;
							await worker.setSchema(updatedSchema);
							if (!transaction.commit({ destructive: true })) return false;
							__kustoInvalidateSupplementalApplicationsAfterWorkerReplace('primary-context-switch');
							await __kustoRestoreOtherPrimaryApplicationsAfterWorkerReplace(worker, modelKey, 'primary-context-switch', transaction);
							if (!isCurrent()) return false;
							__kustoMonacoDatabaseInContextByModel[modelKey] = { clusterUrl, database: targetDatabase.name, connectionId, accountPartition, schemaKey: targetSchemaKey };
							__kustoSchemaTracker.databaseInContext = __kustoMonacoDatabaseInContextByModel[modelKey];
							return true;
							
						} catch (e) {
							console.error('[monaco-kusto] Error setting database in context:', e);
							return false;
						}
					};

					// Function to update monaco-kusto schema when the user focuses a different query box
					// This ensures the schema is loaded AND switches the "database in context"
					// so unqualified table names resolve correctly for the focused query box
					// enableMarkers: if true (default), enables red squiggles for this box; set to false
					//                when just making a section visible without giving it focus
__kustoUpdateSchemaForFocusedBox = async function (boxId: any, enableMarkers = true) {
						let failureOwner: { token: KustoPreparationToken; schemaKey: string; schemaSignature?: string; modelUri: string } | undefined;
						try {
							if (!boxId) return;
							
							// Debounce: skip if we're already processing this exact box
							if (__kustoFocusInProgress === boxId) {
								__kustoFocusUpdateRerunByBoxId[String(boxId)] = true;
								return;
							}
							
							__kustoFocusInProgress = boxId;
							
							// Mark worker as initialized once a query box gets focus
							__kustoWorkerInitialized = true;
							
							// If we need to reload schemas after tab became visible, do it now
							if (__kustoWorkerNeedsSchemaReload) {
								__kustoWorkerNeedsSchemaReload = false;
							}
							
							// ── Schema diagnostics: focus switch ──
							try {
								const diagEl = document.getElementById(boxId) as any;
								const diagName = diagEl?.getName ? diagEl.getName() : boxId;
								const diagCluster = diagEl?.getClusterUrl ? diagEl.getClusterUrl() : '(none)';
								const diagDb = diagEl?.getDatabase ? diagEl.getDatabase() : '(none)';
								const diagCtx = __kustoSchemaTracker.databaseInContext;
								console.log(
									'%c[schema-diag] FOCUS → section: %s | cluster: %s | database: %s | current-context: %s/%s',
									'color:#0f0;font-weight:bold',
									diagName, diagCluster, diagDb,
									diagCtx?.clusterUrl || '(none)', diagCtx?.database || '(none)'
								);
							} catch (e) { /* ignore diag errors */ }
							
							// Get the connection and database for this box
							let ownerId = boxId;
							try {
								if (typeof _win.__kustoGetSelectionOwnerBoxId === 'function') {
									ownerId = _win.__kustoGetSelectionOwnerBoxId(boxId) || boxId;
								}
							} catch (e) { console.error('[kusto]', e); }
							
const connectionId = __kustoGetConnectionId(ownerId);
									const database = __kustoGetDatabase(ownerId);
							
							// Only enable markers (red squiggles) if both cluster and database are selected.
							// Without a full connection context, diagnostics would show false positives.
							if (!connectionId || !database) {
								return;
							}
							if (enableMarkers && schemaDiagnosticsTrustedByBoxId[boxId] === false) {
								return;
							}
							
							// Get the cluster URL for this section's current selection.
							const selectedClusterUrl = __kustoGetClusterUrl(ownerId);
							const conn = Array.isArray(connections) ? connections.find(c => c && String(c.id || '') === connectionId) : null;
							const clusterUrl = selectedClusterUrl || (conn && conn.clusterUrl ? String(conn.clusterUrl) : '');
							const accountPartition = String(conn?.accountPartition || '').trim();
							
							if (!clusterUrl || !accountPartition) {
								return;
							}
							
							let focusedModelUri: string | null = null;
							// Register model→cluster mapping for marker suppression
							try {
								const editor = typeof queryEditors !== 'undefined' ? queryEditors[boxId] : null;
								if (editor && typeof editor.getModel === 'function') {
									const model = editor.getModel();
									if (model && model.uri) {
										focusedModelUri = model.uri.toString();
										__kustoModelClusterMap[focusedModelUri!] = clusterUrl;
									}
								}
							} catch (e) { console.error('[kusto]', e); }
							
							if (!focusedModelUri) {
								return;
							}

							const setAsContext = boxId === activeQueryEditorBoxId
								|| (!activeQueryEditorBoxId && __kustoIsSoleQuerySectionBox(String(boxId)))
								|| (!activeQueryEditorBoxId && isSchemaWorkerApplyRequired(String(boxId)));
							const allowSchemaApply = setAsContext || isSchemaWorkerApplyRequired(String(boxId));
							if (!allowSchemaApply) {
								traceFileOpen('monaco.schema.focusedBox.skip.contextSwitchNotAllowed', { boxId, activeQueryEditorBoxId, enableMarkers });
								return;
							}
							if (enableMarkers && setAsContext) {
								__kustoEnableMarkersForBox!(boxId);
							}

							const expectedSchemaKey = getKustoSchemaIdentityKey(connectionId, accountPartition, clusterUrl, database);
							const contextIntent = setAsContext
								? __kustoClaimSchemaContextIntent(String(boxId), clusterUrl, database, focusedModelUri, connectionId, accountPartition)
								: undefined;
							let pendingSchemaApplied = false;
							try { pendingSchemaApplied = await __kustoFlushPendingSchemaWorkerUpdateForBox(boxId, { setAsContext, contextIntent }); } catch (e) { console.error('[kusto]', e); }
							if (shouldStopKustoSchemaApplyAfterPendingFlush(pendingSchemaApplied, getKustoPreparationState(boxId).status)) {
								traceFileOpen('monaco.schema.focusedBox.stop.terminalPendingFailure', { boxId, expectedSchemaKey });
								return;
							}
							const currentContextAfterFlush = __kustoGetSchemaContextForBox(boxId);
							if (!currentContextAfterFlush || currentContextAfterFlush.schemaKey !== expectedSchemaKey) {
								__kustoFocusUpdateRerunByBoxId[String(boxId)] = true;
								traceFileOpen('monaco.schema.focusedBox.retry.contextChanged', {
									boxId,
									expectedSchemaKey,
									currentSchemaKey: currentContextAfterFlush?.schemaKey || '',
								});
								return;
							}
							
							// Get rawSchemaJson from the coordinator-owned editor catalog.
							const schema = getKustoEditorSchema(boxId);
							const rawSchemaJson = schema && schema.rawSchemaJson ? schema.rawSchemaJson : null;
							const schemaKey = expectedSchemaKey;
							const schemaSignature = getKustoSchemaMetadata(boxId)?.schemaSignature;
							const preparationToken = getKustoPreparationToken(boxId);
							let preparationDeadlineOwner: KustoPreparationToken | undefined;
							if (preparationToken) {
								const preparationState = getKustoPreparationState(boxId);
								if (preparationState.status === 'preparing') preparationDeadlineOwner = preparationToken;
								if (preparationState.status === 'preparing'
									&& preparationState.target.database === database
									&& (!preparationState.target.schemaKey || preparationState.target.schemaKey === schemaKey)
									&& (!preparationState.target.modelUri || preparationState.target.modelUri === focusedModelUri)) {
									updateKustoPreparation(preparationToken, {
										target: { schemaKey, schemaSignature, modelUri: focusedModelUri },
									});
								}
							}
							const baseWorkerReady = isSchemaWorkerReady(boxId, schemaKey, focusedModelUri);
							const enhancementReady = isSchemaEnhancementReady(boxId, schemaKey, schemaSignature, focusedModelUri);
							const enhancementPending = isSchemaEnhancementPending(boxId, schemaKey, schemaSignature, focusedModelUri);
							const workerApplyRequired = isSchemaWorkerApplyRequired(boxId);
							let workerContextMatches = !setAsContext || __kustoSchemaTracker.databaseInContext?.schemaKey === schemaKey;
							if (!workerApplyRequired && baseWorkerReady && setAsContext && !workerContextMatches && contextIntent) {
								if (preparationToken && getKustoPreparationState(boxId).status === 'preparing'
									&& isKustoPreparationCurrent(preparationToken, { schemaKey, schemaSignature, modelUri: focusedModelUri })) {
									failureOwner = { token: preparationToken, schemaKey, schemaSignature, modelUri: focusedModelUri };
								}
								workerContextMatches = await awaitKustoSchemaPreparation(
									__kustoQueueDatabaseContextSwitch(clusterUrl, database, focusedModelUri, contextIntent, connectionId, accountPartition),
									preparationDeadlineOwner,
								);
								traceFileOpen('monaco.schema.focusedBox.contextSwitch', { boxId, schemaKey, switched: workerContextMatches });
							}
							if (!workerApplyRequired && baseWorkerReady && workerContextMatches) {
								if (preparationToken) updateKustoPreparation(preparationToken, { removeBlockers: ['schema', 'worker', 'enhancement'] });
								if (!enhancementReady && !enhancementPending) {
									const enhancementSchema = rawSchemaJson || __kustoSchemaTracker.schemaCache[schemaKey]?.rawSchemaJson;
									if (enhancementSchema) {
										__kustoRetryPrimarySchemaEnhancement({
											boxId: String(boxId),
											rawSchemaJson: enhancementSchema,
											clusterUrl,
											database,
											connectionId,
											accountPartition,
											schemaKey,
											modelUri: focusedModelUri,
										});
									}
								}
								if (enhancementReady) __kustoTriggerRevalidation!(boxId);
								return;
							}
							const forceEnhancementRetry = shouldForceKustoFocusedSchemaApply({
								workerApplyRequired,
								baseWorkerReady,
								workerContextMatches,
							});
							
							if (rawSchemaJson) {
								// Delegate to the queued schema loader. An explicit inactive-section
								// apply loads its schema without replacing the focused context.
								// This ensures all schema operations are serialized and tracking
								// state (global + per-model) is properly updated. The queued
								// function handles first-load vs add vs replace logic correctly,
								// including the "already loaded, just switch context" optimization.
								markSchemaWorkerApplyPending(boxId, schemaKey, schemaSignature, focusedModelUri, preparationToken);
								if (preparationToken && isKustoPreparationCurrent(preparationToken, { schemaKey, schemaSignature, modelUri: focusedModelUri })) {
									failureOwner = { token: preparationToken, schemaKey, schemaSignature, modelUri: focusedModelUri };
								}
								const applied = await awaitKustoSchemaPreparation(Promise.resolve(_win.__kustoSetMonacoKustoSchema(
									rawSchemaJson,
									clusterUrl,
									database,
									setAsContext,
									focusedModelUri,
									forceEnhancementRetry,
									() => !preparationToken || isKustoPreparationCurrent(preparationToken, { schemaKey, schemaSignature, modelUri: focusedModelUri! }),
									preparationToken,
									contextIntent,
									connectionId,
									accountPartition,
								)), preparationToken);
								if (!applied) {
									if (preparationToken && !isKustoPreparationCurrent(preparationToken)) return;
									markSchemaWorkerApplyFailed(boxId, schemaKey, focusedModelUri, preparationToken);
									return;
								}
								markSchemaWorkerReady(boxId, schemaKey, schemaSignature, focusedModelUri, preparationToken);
								__kustoScheduleSupplementalPump(0);
								
								if (setAsContext) __kustoTriggerRevalidation!(boxId);
							} else {
								// No rawSchemaJson in the editor catalog yet. Check if the schema
								// was previously loaded and cached in __kustoSchemaTracker.schemaCache.
								const cachedSchema = __kustoSchemaTracker.schemaCache[schemaKey];
								if (cachedSchema && cachedSchema.rawSchemaJson) {
									markSchemaWorkerApplyPending(boxId, schemaKey, schemaSignature, focusedModelUri, preparationToken);
									if (preparationToken && isKustoPreparationCurrent(preparationToken, { schemaKey, schemaSignature, modelUri: focusedModelUri })) {
										failureOwner = { token: preparationToken, schemaKey, schemaSignature, modelUri: focusedModelUri };
									}
									const applied = await awaitKustoSchemaPreparation(Promise.resolve(_win.__kustoSetMonacoKustoSchema(
										cachedSchema.rawSchemaJson,
										clusterUrl,
										database,
										setAsContext,
										focusedModelUri,
										forceEnhancementRetry,
										() => !preparationToken || isKustoPreparationCurrent(preparationToken, { schemaKey, schemaSignature, modelUri: focusedModelUri! }),
										preparationToken,
										contextIntent,
										connectionId,
										accountPartition,
									)), preparationToken);
									if (!applied) {
										if (preparationToken && !isKustoPreparationCurrent(preparationToken)) return;
										markSchemaWorkerApplyFailed(boxId, schemaKey, focusedModelUri, preparationToken);
										return;
									}
									markSchemaWorkerReady(boxId, schemaKey, schemaSignature, focusedModelUri, preparationToken);
									__kustoScheduleSupplementalPump(0);
									if (setAsContext) __kustoTriggerRevalidation!(boxId);
								} else {
									// No cached schema anywhere in the worker — trigger cache-first schema fetch.
									// When the schema arrives via 'schemaData' message, the handler
									// will call __kustoSetMonacoKustoSchema.
									if (typeof ensureSchemaForBox === 'function') {
										ensureSchemaForBox(boxId, false);
									}
								}
							}
						} catch (e) {
							console.error('[monaco-kusto] Error updating schema for focused box:', e);
							try {
								if (failureOwner && isKustoPreparationCurrent(failureOwner.token, {
									schemaKey: failureOwner.schemaKey,
									schemaSignature: failureOwner.schemaSignature,
									modelUri: failureOwner.modelUri,
								})) {
									markSchemaWorkerApplyFailed(boxId, failureOwner.schemaKey, failureOwner.modelUri, failureOwner.token);
								}
							} catch (inner) { console.error('[kusto]', inner); }
						} finally {
							if (__kustoFocusInProgress === boxId) {
								__kustoFocusInProgress = null;
							}
							if (__kustoFocusUpdateRerunByBoxId[String(boxId)]) {
								try { delete __kustoFocusUpdateRerunByBoxId[String(boxId)]; } catch (e) { console.error('[kusto]', e); }
								setTimeout(() => { try { void __kustoUpdateSchemaForFocusedBox?.(boxId, enableMarkers); } catch (e) { console.error('[kusto]', e); } }, 0);
							}
						}
					};
					registerKustoSchemaApplyRequester(__kustoRegisteredSchemaApplyRequester);
					
					// Helper to enable markers for a specific box's editor
__kustoEnableMarkersForBox = function(boxId: any) {
						try {
							const editor = typeof queryEditors !== 'undefined' ? queryEditors[boxId] : null;
							if (editor && typeof editor.getModel === 'function') {
								const model = editor.getModel();
								if (model && model.uri) {
									if (__kustoEnableMarkersForModel !== null) {
										__kustoEnableMarkersForModel!(model.uri);
									}
								}
							}
						} catch (e) { console.error('[kusto]', e); }
					};
					
					// Helper to trigger re-validation for a specific box's editor
					// This is needed after context switch since monaco-kusto doesn't auto-revalidate
__kustoTriggerRevalidation = function(boxId: any) {
						try {
							const editor = typeof queryEditors !== 'undefined' ? queryEditors[boxId] : null;
							if (editor && typeof editor.getModel === 'function') {
								const model = editor.getModel();
								if (model) {
									try {
										// Clear existing markers first
										monaco.editor.setModelMarkers(model, 'kusto', []);
									} catch (e) { console.error('[kusto]', e); }
								}
							}
						} catch (e) { console.error('[kusto]', e); }
					};

					// Track which cross-cluster schemas have been loaded or requested
					// Key: "clusterName|database" -> { status: 'pending'|'loaded'|'error', rawSchemaJson?: object }
					__kustoCrossClusterSchemas = {};
					__kustoCrossClusterSchemaWaitersByKey = {};
					__kustoCrossClusterAutocompleteDemandUntilByKey = {};

					// Parse query text to extract cluster() and database() references
					// Returns array of { clusterName, database } objects
__kustoExtractCrossClusterRefs = function (queryText: any, currentContext: any = null) {
						return extractCrossClusterRefs(queryText, currentContext || __kustoSchemaTracker.databaseInContext);
					};

					// Request schema for a cross-cluster reference
__kustoRequestCrossClusterSchema = function (clusterName: any, database: any, boxId: any, requestSource: KustoSupplementalRequestSource = 'background') {
						// If clusterName is null, resolve it from current context
						let resolvedClusterName = clusterName;
						if (clusterName === null) {
							const currentContext = __kustoGetSchemaContextForBox(__kustoNormalizeCrossClusterBoxId(boxId)) || __kustoSchemaTracker.databaseInContext;
							if (currentContext?.clusterUrl) {
								resolvedClusterName = currentContext.clusterUrl;
							} else {
								return;
							}
						}
						
						const key = __kustoGetCrossClusterSchemaKey(resolvedClusterName, database);
						if (!key) {
							return;
						}
						const subscribers = __kustoSupplementalCoordinator.getStatesForSchemaKey(key)
							.filter(state => state.status === 'scheduled' && !!__kustoSupplementalModelForUri(state.modelUri));
						if (subscribers.length === 0) return;
						const existing = __kustoCrossClusterSchemas[key];
						const refreshingStaleFallback = requestSource === 'autocomplete'
							&& existing?.status === 'loaded'
							&& existing.deliverySource === 'disk-cache-stale'
							&& !!existing.rawSchemaJson;
						if (existing?.status === 'loaded' && existing.rawSchemaJson && !refreshingStaleFallback) {
							for (const subscriber of subscribers) {
								if (existing.requestToken) {
									const adopted = __kustoSupplementalCoordinator.markFetching(supplementalStateIdentity(subscriber), {
										requestToken: existing.requestToken,
										requestSource: existing.requestSource || requestSource,
										deadlineAt: existing.deadlineAt || Date.now() + CROSS_CLUSTER_SCHEMA_BACKGROUND_FETCH_TIMEOUT_MS,
									});
									if (adopted?.status === 'scheduled' && adopted.requestSource === 'autocomplete') {
										__kustoSupplementalCoordinator.markFetched(supplementalStateIdentity(adopted));
									} else {
										__kustoSupplementalCoordinator.markFetchedByRequest(existing.requestToken);
									}
								} else {
									__kustoSupplementalCoordinator.markFetched(supplementalStateIdentity(subscriber));
								}
							}
							__kustoTraceCrossCluster('request-skipped-raw-cache', { key, boxId, requestSource, subscriberCount: subscribers.length });
							__kustoScheduleSupplementalPump(0);
							return;
						}
						if (existing?.status === 'pending') {
							if (existing.requestSource === 'autocomplete' || requestSource === 'background') {
								const preserveFetchedAvailable = !!existing.rawSchemaJson
									&& existing.deliverySource === 'disk-cache-stale';
								const joined = __kustoSupplementalCoordinator.bindSchemaRequest(key, {
									requestToken: String(existing.requestToken || ''),
									requestSource: existing.requestSource || requestSource,
									deadlineAt: existing.deadlineAt || Date.now() + (requestSource === 'autocomplete' ? CROSS_CLUSTER_SCHEMA_AUTOCOMPLETE_FETCH_TIMEOUT_MS : CROSS_CLUSTER_SCHEMA_BACKGROUND_FETCH_TIMEOUT_MS),
									preserveFetchedAvailable,
								});
								__kustoTraceCrossCluster('request-joined-existing', { key, boxId, requestSource, brokerSource: existing.requestSource, subscriberCount: joined.length });
								__kustoScheduleSupplementalDeadline();
								return;
							}
							// Autocomplete is stronger than a silent request. Rebind every live
							// subscriber before replacing the broker token.
							__kustoTraceCrossCluster('request-escalated', { key, boxId, requestSource, brokerSource: existing.requestSource });
						}

						const requestToken = 'crosscluster_' + Date.now() + '_' + Math.random().toString(16).slice(2);
						const traceId = 'supplemental_' + Math.random().toString(16).slice(2);
						const deadlineAt = Date.now() + (requestSource === 'autocomplete' ? CROSS_CLUSTER_SCHEMA_AUTOCOMPLETE_FETCH_TIMEOUT_MS : CROSS_CLUSTER_SCHEMA_BACKGROUND_FETCH_TIMEOUT_MS);
						__kustoSetCrossClusterSchemaEntry(key, {
							status: 'pending',
							requestToken,
							requestSource,
							deadlineAt,
							revision: (existing?.revision || 0) + 1,
							...(refreshingStaleFallback ? {
								rawSchemaJson: existing?.rawSchemaJson,
								clusterUrl: existing?.clusterUrl,
								deliverySource: existing?.deliverySource,
								cacheAgeMs: existing?.cacheAgeMs,
							} : {}),
						});
						const requestSubscribers = __kustoSupplementalCoordinator.bindSchemaRequest(key, {
							requestToken,
							requestSource,
							deadlineAt,
							preserveFetchedAvailable: refreshingStaleFallback,
							includeFetching: existing?.status === 'pending' && requestSource === 'autocomplete',
						});
						__kustoTraceCrossCluster('request-posted', { key, boxId, requestSource, requestToken, subscriberCount: requestSubscribers.length });
						const delayedFixture = document.body.dataset.kustoE2eEnabled === 'true'
							? __kustoDelayedSupplementalSchemasForTest[key]
							: undefined;
						if (delayedFixture && delayedFixture.boxId === __kustoNormalizeCrossClusterBoxId(boxId)) {
							window.setTimeout(() => {
								const delivered = __kustoHandleCrossClusterSchemaData({
									clusterName: delayedFixture.clusterName,
									clusterUrl: delayedFixture.clusterUrl,
									connectionId: delayedFixture.connectionId,
									accountPartition: delayedFixture.accountPartition,
									database: delayedFixture.database,
									boxId: delayedFixture.boxId,
									requestToken,
									requestSource,
									deliverySource: 'e2e-delayed-fixture',
									rawSchemaJson: delayedFixture.rawSchemaJson,
								});
								if (delivered && __kustoDelayedSupplementalSchemasForTest[key] === delayedFixture) {
									delete __kustoDelayedSupplementalSchemasForTest[key];
								}
							}, delayedFixture.delayMs);
						} else {
							postMessageToHost({
								type: 'requestCrossClusterSchema',
								clusterName: resolvedClusterName,
								database,
								boxId: boxId || '',
								requestToken,
								requestSource,
								traceId,
							});
						}
						__kustoScheduleSupplementalDeadline();
					};

					// Apply a cross-cluster schema to monaco-kusto
					// This is serialized through the same queue as __kustoSetMonacoKustoSchema to prevent races
					_win.__kustoApplyCrossClusterSchema = async function (clusterName: any, clusterUrl: any, database: any, rawSchemaJson: any, boxId: any = '', source: any = '', cacheAgeMs: any = undefined) {
						const key = __kustoGetCrossClusterSchemaKey(clusterName, database);
						const broker = key ? __kustoCrossClusterSchemas[key] : undefined;
						if (broker) {
							broker.rawSchemaJson = rawSchemaJson;
							broker.clusterUrl = String(clusterUrl || clusterName || '');
							broker.deliverySource = String(source || '');
							broker.cacheAgeMs = typeof cacheAgeMs === 'number' ? cacheAgeMs : undefined;
							broker.status = 'loaded';
						}
						__kustoScheduleSupplementalPump(0);
					};
					
					// Internal implementation - called through the queue
__kustoApplyCrossClusterSchemaInternal = async function (
	clusterName: any,
	clusterUrl: any,
	database: any,
	rawSchemaJson: any,
	boxId: any = '',
	source: any = '',
	cacheAgeMs: any = undefined,
	modelUri: any = '',
	referenceGeneration: any = 0,
	modelVersion: any = 0,
	_primarySchemaKey: any = '',
	brokerRevision: any = 0,
	transaction: KustoWorkerMutationTransaction,
	isCurrent: () => boolean = () => true,
) {
						const key = __kustoGetCrossClusterSchemaKey(clusterName, database);
						const sourceText = String(source || '');
						const normalizedBoxId = __kustoNormalizeCrossClusterBoxId(boxId);
						const requestedUri = String(modelUri || __kustoGetModelUriForCrossClusterBox(normalizedBoxId));
						const requestedReferenceGeneration = Number(referenceGeneration || 0);
						const requestedModel = __kustoSupplementalModelForUri(requestedUri);
						const requestedWasLoadedBefore = !!requestedUri && __kustoIsCrossClusterSchemaLoadedForModel(key, requestedUri);
						const failRequested = (failureKind: KustoSupplementalFailureKind, brokerFailure: boolean = false) => {
							const failed = requestedUri && requestedReferenceGeneration
								? __kustoSupplementalCoordinator.markFailed({ modelUri: requestedUri, schemaKey: key, referenceGeneration: requestedReferenceGeneration }, failureKind)
								: undefined;
							if (failed) void __kustoRevalidateSupplementalModel(requestedUri, failureKind);
							if (brokerFailure) {
								const broker = __kustoCrossClusterSchemas[key];
								if (broker) {
									broker.status = 'error';
									broker.failureKind = failureKind;
									broker.error = failureKind;
									__kustoSetCrossClusterSchemaEntry(key, broker);
								}
							}
						};
						
						try {
							if (!isCurrent()) return;
							const clusterAliases = __kustoGetCrossClusterClusterAliases(clusterName, clusterUrl);
							__kustoTraceCrossCluster('apply-internal-start', { key, boxId, clusterName, clusterUrl, database, aliases: clusterAliases, source: sourceText, cacheAgeMs, modelUri: requestedUri, requestedWasLoadedBefore });
							// Parse the raw schema JSON
							let schemaObj;
							if (typeof rawSchemaJson === 'string') {
								try {
									schemaObj = JSON.parse(rawSchemaJson);
								} catch (e) {
									console.error('[monaco-kusto] Failed to parse cross-cluster schema JSON:', e);
									failRequested('invalid-schema', true);
									return;
								}
							} else {
								schemaObj = rawSchemaJson;
							}
							schemaObj = stampKustoSchemaMajorVersion(schemaObj, transaction.id);

							const exactDatabaseKey = schemaObj?.Databases
								? Object.keys(schemaObj.Databases).find(candidate => candidate.toLowerCase() === String(database).toLowerCase())
								: '';
							if (!schemaObj || !schemaObj.Databases || !exactDatabaseKey) {
								failRequested('invalid-schema', true);
								return;
							}

							// Get the kusto worker
							if (monaco && monaco.languages && monaco.languages.kusto && typeof monaco.languages.kusto.getKustoWorker === 'function') {
								if (!isCurrent()) return;
								const workerAccessor = await monaco.languages.kusto.getKustoWorker();
								if (!isCurrent()) return;
								const models = monaco.editor.getModels();
								
								if (!models || models.length === 0 || !requestedModel || requestedModel.isDisposed?.()
									|| requestedModel.getVersionId?.() !== Number(modelVersion || 0)) {
									failRequested('apply-failed');
									return;
								}

									let appliedCount = 0;
									let appliedToRequestedModel = false;
									const appliedModelUris: string[] = [];
									const skippedLoadedModelUris: string[] = [];
									let schemaWorkerProxy: any = null;
									try {
										const modelCandidates: any[] = requestedModel ? [requestedModel] : [];
										const schemaModel = requestedModel;
										if (!isCurrent()) return;
										schemaWorkerProxy = await workerAccessor(schemaModel.uri);
										if (!isCurrent()) return;
										if (schemaWorkerProxy && typeof schemaWorkerProxy.addDatabaseToSchema === 'function') {
											for (const model of modelCandidates) {
												try {
													if (!model || !model.uri) continue;
													const modelUri = model.uri.toString();
													const wasLoadedForModel = __kustoIsCrossClusterSchemaLoadedForModel(key, modelUri);
													if (wasLoadedForModel && __kustoCanSkipLoadedCrossClusterApply(sourceText)) {
														if (!skippedLoadedModelUris.includes(modelUri)) {
															skippedLoadedModelUris.push(modelUri);
														}
														if (requestedUri && modelUri === requestedUri) {
															appliedToRequestedModel = true;
														}
														continue;
													}
													const count = await __kustoAddDatabaseAliasesToWorker(schemaWorkerProxy, modelUri, schemaObj, clusterName, clusterUrl, database, transaction, isCurrent);
													if (!isCurrent()) return;
													appliedCount += count;
													if (count > 0 && !appliedModelUris.includes(modelUri)) {
														appliedModelUris.push(modelUri);
													}
													if (count > 0 && requestedUri && modelUri === requestedUri) {
														appliedToRequestedModel = true;
													}
												} catch (e) { console.error('[kusto]', e); }
											}
											if (appliedCount === 0) {
												if (skippedLoadedModelUris.length > 0) {
													__kustoTraceCrossCluster('apply-internal-noop.alreadyLoadedModels', { key, boxId, requestedUri, skippedLoadedModelUris, source: sourceText, cacheAgeMs });
													return;
												}
												failRequested('invalid-schema', true);
											}
										}
									} catch (e) { console.error('[kusto]', e); }
									// NOTE: Do NOT update __kustoSchemaTracker.loadedSchemas or
									// __kustoSchemaTracker.loadedSchemasByModel here. Cross-cluster/
									// cross-database schemas added via addDatabaseToSchema are
									// supplementary references only — they must NOT interfere
									// with the primary schema tracking used by needsReplace and
									// the alreadyLoaded logic. If we mark them as loaded, the
									// next focus-switch incorrectly thinks the primary schema
									// is already set and skips the context switch.
												
									if (appliedCount > 0 && requestedUri && appliedToRequestedModel) {
										if (!transaction.isActive() || !isCurrent()) return;
										const loadedState = requestedReferenceGeneration
											? __kustoSupplementalCoordinator.markLoaded({ modelUri: requestedUri, schemaKey: key, referenceGeneration: requestedReferenceGeneration })
											: undefined;
										if (!loadedState) return;
										const adoptedStates: KustoSupplementalSchemaState[] = [];
										for (const candidate of __kustoSupplementalCoordinator.getApplyCandidates(key)) {
											if (candidate.modelUri === requestedUri || !__kustoIsSupplementalPrimaryReady(candidate.modelUri, candidate.primarySchemaKey)) continue;
											const adopted = __kustoSupplementalCoordinator.markLoaded(supplementalStateIdentity(candidate));
											if (adopted) adoptedStates.push(adopted);
										}
										const shouldNotify = __kustoShouldNotifyCrossClusterSchemaReady(sourceText, requestedUri, requestedWasLoadedBefore, appliedToRequestedModel);
										__kustoTraceCrossCluster('apply-internal-success', { key, boxId, appliedCount, appliedToRequestedModel, modelUri: requestedUri, appliedModelUris, skippedLoadedModelUris, source: sourceText, cacheAgeMs, requestedWasLoadedBefore, notificationShown: shouldNotify });
										for (const adopted of adoptedStates) void __kustoRevalidateSupplementalModel(adopted.modelUri, 'supplemental-shared-loaded');
										const broker = __kustoCrossClusterSchemas[key];
										if (broker && (broker.revision || 0) === Number(brokerRevision || 0)) {
											broker.status = 'loaded';
											broker.rawSchemaJson = schemaObj;
											broker.clusterUrl = clusterUrl;
											broker.deliverySource = sourceText;
											broker.workerAppliedRevision = Number(brokerRevision || 0);
											broker.workerAppliedEpoch = __kustoWorkerMutations.getSnapshot().destructiveEpoch;
											__kustoSetCrossClusterSchemaEntry(key, broker);
										}
										void __kustoRevalidateSupplementalModel(requestedUri, 'supplemental-loaded');
										if (shouldNotify) {
											try {
												postMessageToHost({
													type: 'showInfo',
													message: `Autocomplete ready for cluster('${clusterName}').database('${database}').`
												});
											} catch (e) { console.error('[kusto]', e); }
										}
									} else if (!__kustoCrossClusterSchemas[key] || __kustoCrossClusterSchemas[key]?.status !== 'error') {
										__kustoTraceCrossCluster('apply-internal-failed', { key, boxId, appliedCount, appliedToRequestedModel, requestedUri });
										failRequested('apply-failed');
									}
							} else {
								failRequested('apply-failed');
							}
						} catch (e) {
							console.error('[monaco-kusto] Failed to apply cross-cluster schema:', e);
							failRequested('apply-failed');
						}
					};

					// Check for cross-cluster references in a query and request schemas
__kustoCheckCrossClusterRefs = function (queryText: any, boxId: any) {
						const states = __kustoSyncSupplementalReferencesForBox(__kustoNormalizeCrossClusterBoxId(boxId), 'background');
						const currentContext = __kustoGetSchemaContextForBox(__kustoNormalizeCrossClusterBoxId(boxId)) || __kustoSchemaTracker.databaseInContext;
						const refs = __kustoExtractCrossClusterRefs!(queryText, currentContext);
						__kustoTraceCrossCluster('reference.check.complete', { boxId, referenceCount: refs.length, stateCount: states.length });
						__kustoScheduleSupplementalPump(0);
					};

					// --- Copilot inline completions Provider ---
					// Uses an async provider that awaits the LLM response. The provider
					// intentionally does NOT hook token.onCancellationRequested — Monaco
					// aggressively cancels manual triggers, which would kill the pending
					// request before the response arrives. Instead we let the promise
					// resolve naturally and Monaco renders the items if it's still interested.

					let __kustoInlineCompletionRequestId = 0;
					// Content widget for the inline completion spinner.
					const __kustoInlineSpinnerWidgets: Record<string, any> = {};

					// CSS for the spinner — inject once.
					try {
						const spinnerStyle = document.createElement('style');
						spinnerStyle.textContent = `
							@keyframes kusto-inline-ghost-pulse { 0%, 100% { opacity: 0.45; } 50% { opacity: 0.9; } }
							.kusto-inline-spinner-widget {
								display: inline-flex;
								align-items: center;
								gap: 4px;
								pointer-events: none;
								z-index: 1;
								padding: 0 4px;
								animation: kusto-inline-ghost-pulse 1.2s ease-in-out infinite;
							}
							.kusto-inline-spinner-icon {
								display: inline-block;
								width: 14px;
								height: 14px;
								color: var(--vscode-editorGhostText-foreground, rgba(128,128,128,0.7));
							}
							.kusto-inline-spinner-icon svg {
								width: 100%;
								height: 100%;
							}
							.kusto-inline-spinner-label {
								font-size: 11px;
								color: var(--vscode-editorGhostText-foreground, rgba(128,128,128,0.7));
								font-style: italic;
								white-space: nowrap;
							}
						`;
						document.head.appendChild(spinnerStyle);
					} catch { /* ignore */ }

					const __kustoShowInlineSpinner = (editor: any, boxId: string, lineNumber: number, column: number) => {
						try {
							__kustoHideInlineSpinner(editor, boxId);
							const domNode = document.createElement('div');
							domNode.className = 'kusto-inline-spinner-widget';
							domNode.innerHTML = '<span class="kusto-inline-spinner-icon"><svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M8 1C5.2 1 3 3.2 3 6v6c0 .3.1.6.4.8.2.2.5.2.8.1l1.3-.7 1.3.7c.3.2.7.2 1 0L8 12.2l.2.7c.3.2.7.2 1 0l1.3-.7 1.3.7c.3.1.6.1.8-.1.3-.2.4-.5.4-.8V6c0-2.8-2.2-5-5-5zm-2 6.5c-.6 0-1-.4-1-1s.4-1 1-1 1 .4 1 1-.4 1-1 1zm4 0c-.6 0-1-.4-1-1s.4-1 1-1 1 .4 1 1-.4 1-1 1z"/></svg></span>';
							const widget = {
								getId: () => 'kusto-inline-spinner-' + boxId,
								getDomNode: () => domNode,
								getPosition: () => ({
									position: { lineNumber, column },
									preference: [2, 1]
								}),
							};
							editor.addContentWidget(widget);
							__kustoInlineSpinnerWidgets[boxId] = widget;
						} catch { /* ignore */ }
					};
					const __kustoHideInlineSpinner = (editor: any, boxId: string) => {
						try {
							const existing = __kustoInlineSpinnerWidgets[boxId];
							if (existing) {
								editor.removeContentWidget(existing);
								delete __kustoInlineSpinnerWidgets[boxId];
							}
						} catch { /* ignore */ }
					};

					// The result handler is still needed for main.ts message dispatch.
					// It resolves the pending promise.
					_win.__kustoHandleInlineCompletionResult = (requestId: string, completions: any[]) => {
						const pending = copilotInlineCompletionRequests[requestId];
						if (!pending || typeof pending.resolve !== 'function') return;
						delete copilotInlineCompletionRequests[requestId];
						pending.resolve(completions || []);
					};

					// Factory for inline completion providers — registers one per language.
					const __kustoCreateInlineCompletionProvider = (flavor: 'kusto' | 'sql', commentMarker: string) => ({
						provideInlineCompletions: async function (model: any, position: any, context: any, _token: any) {
							try {
								const isManualTrigger = context && context.triggerKind === 1;

								// Check if automatic inline completions are enabled
								if (!isManualTrigger && typeof copilotInlineCompletionsEnabled !== 'undefined' && !copilotInlineCompletionsEnabled) {
									return { items: [] };
								}

								// Don't provide completions if we're in a comment
								const lineContent = model.getLineContent(position.lineNumber);
								const textBeforeOnLine = lineContent.substring(0, position.column - 1);
								if (textBeforeOnLine.includes(commentMarker)) {
									return { items: [] };
								}

								// Get text before and after cursor
								const fullText = model.getValue();
								const offset = model.getOffsetAt(position);
								const textBefore = fullText.substring(0, offset);
								const textAfter = fullText.substring(offset);

								// Don't trigger if editor is empty
								if (!textBefore.trim() && !textAfter.trim()) {
									return { items: [] };
								}

								const requestId = 'inline_' + (++__kustoInlineCompletionRequestId) + '_' + Date.now();

								// Find the boxId and editor
								let boxId = '';
								let editorForModel: any = null;
								try {
									const modelUri = model.uri ? model.uri.toString() : '';
									if (typeof queryEditorBoxByModelUri !== 'undefined' && modelUri) {
										boxId = queryEditorBoxByModelUri[modelUri] || '';
									}
									if (boxId && queryEditors) {
										editorForModel = queryEditors[boxId] || null;
									}
								} catch (e) { console.error('[kusto]', e); }

								// Show spinner
								let ownerToken = '';
								if (flavor === 'sql') {
									const sqlEl = boxId ? document.getElementById(boxId) as any : null;
									ownerToken = String(sqlEl?.getCopilotOwnerToken?.() || '');
									if (!ownerToken) return { items: [] };
								}

								if (editorForModel && boxId) {
									__kustoShowInlineSpinner(editorForModel, boxId, position.lineNumber, position.column);
								}

								// Create promise that resolves when the extension host responds.
								// IMPORTANT: we do NOT hook token.onCancellationRequested — Monaco
								// aggressively cancels especially for manual triggers, which would
								// delete the pending request before the LLM can respond.
								const completionPromise = new Promise<any[]>((resolve) => {
									const timeoutId = setTimeout(() => {
										delete copilotInlineCompletionRequests[requestId];
										resolve([]);
									}, 10000);

									copilotInlineCompletionRequests[requestId] = {
										resolve: (completions: any) => {
											clearTimeout(timeoutId);
											resolve(completions);
										}
									};
								});

								// Send request to extension host
								try {
									postMessageToHost({
										type: 'requestCopilotInlineCompletion',
										requestId,
										boxId,
										textBefore,
										textAfter,
										flavor,
										...(ownerToken ? { ownerToken } : {})
									});
								} catch (err) {
									delete copilotInlineCompletionRequests[requestId];
									if (editorForModel && boxId) __kustoHideInlineSpinner(editorForModel, boxId);
									return { items: [] };
								}

								// Await response
								const completions = await completionPromise;

								// Hide spinner
								if (editorForModel && boxId) {
									__kustoHideInlineSpinner(editorForModel, boxId);
								}

								if (!completions || !Array.isArray(completions) || completions.length === 0) {
									return { items: [] };
								}

								// Convert to Monaco inline completion items
								const items = completions.map(c => ({
									insertText: c.insertText || '',
									range: new monaco.Range(
										position.lineNumber,
										position.column,
										position.lineNumber,
										position.column
									)
								})).filter(item => item.insertText);

								return { items };
							} catch {
								return { items: [] };
							}
						},
						freeInlineCompletions: function () {
							// No cleanup needed
						}
					});

					monaco.languages.registerInlineCompletionsProvider('kusto', __kustoCreateInlineCompletionProvider('kusto', '//'));
					monaco.languages.registerInlineCompletionsProvider('sql', __kustoCreateInlineCompletionProvider('sql', '--'));
					monaco.languages.registerCompletionItemProvider('kusto', {
						provideCompletionItems: (model: any, position: any) => {
							try {
								const providerModelUri = String(model?.uri?.toString?.() || '');
								if (__kustoCustomColumnCompletionProviderDisabledModels.has(providerModelUri)) return { suggestions: [] };
								const decision = __kustoSupplementalCompletionDecisionForModel(model, position);
								recordAutocompleteTrace(__kustoGetAutocompleteTraceIdForModel(decision.modelUri), 'supplemental-provider-decision', {
									allow: decision.allow,
									reason: decision.reason,
									primaryReady: decision.primaryReady,
									enhancementPending: decision.enhancementPending,
									refsCount: decision.refsCount,
									missingCrossClusterCount: decision.missingCrossClusterCount,
								});
								if (!decision.allow) return { suggestions: [] };
								const columns = __kustoColumnCompletionsForModel(model, position);
								recordAutocompleteTrace(__kustoGetAutocompleteTraceIdForModel(decision.modelUri), 'supplemental-provider-result', {
									reason: decision.reason,
									count: columns.length,
								});
								if (!columns.length) return { suggestions: [] };
								const word = model.getWordUntilPosition(position);
								const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
								return {
									suggestions: columns.map((column: string) => ({
										label: column,
										kind: monaco.languages.CompletionItemKind.Field,
										insertText: column,
										sortText: '0000_' + column.toLowerCase(),
										range,
										detail: 'Kusto column',
									}))
								};
							} catch (e) { console.error('[kusto]', e); return { suggestions: [] }; }
						}
					});
					
					__kustoWorkerInitialized = true;
					
					// Start the theme observer to handle dynamic theme changes in VS Code
					startMonacoThemeObserver(monaco);
					
					traceFileOpen('monaco.ensure.resolved');
					resolve(monaco);
								} catch (e) {
									reject(e);
								}
							}, (e: any) => { traceFileOpen('monaco.kustoContribution.load.error', { message: e instanceof Error ? e.message : String(e) }); reject(e); }); // monaco-kusto load error handler
						} catch (e) {
							reject(e);
						}
					},
					(e: any) => { traceFileOpen('monaco.editorMain.load.error', { message: e instanceof Error ? e.message : String(e) }); reject(e); }
				);
			}).catch((e) => { traceFileOpen('monaco.waitForAmdLoader.error', { message: e instanceof Error ? e.message : String(e) }); reject(e); });
		} catch (e) {
			traceFileOpen('monaco.ensure.error', { message: e instanceof Error ? e.message : String(e) });
			reject(e);
		}
	}));

	// If Monaco init fails, allow retries within the same webview session.
	setMonacoReadyPromise(monacoReadyPromise!.catch((e: any) => {
		setMonacoReadyPromise(null);
		throw e;
	}));

	return monacoReadyPromise;
}

// Lazy loading state tracking
// Monaco+Kusto worker is NOT loaded until user focuses a query box
// This saves memory when files are opened but not actively edited
// __kustoWorkerInitialized and __kustoWorkerNeedsSchemaReload are initialized at module scope.

// Proactively start loading Monaco as soon as this script is loaded.
// This reduces the time the UI appears as a non-interactive placeholder before the editor mounts.
// NOTE: Now disabled by default for lazy loading - Monaco will load on first editor creation
// Set _win.__kustoPreloadMonaco = true before this script loads to enable pre-warming
try {
	if (_win.__kustoPreloadMonaco) {
		setTimeout(() => {
			try {
				const p = ensureMonaco();
				if (p && typeof p.catch === 'function') {
					p.catch(() => { /* ignore */ });
				}
			} catch (e) { console.error('[kusto]', e); }
		}, 0);
	}
} catch (e) { console.error('[kusto]', e); }

// Tab visibility change listener - clear schemas when tab is hidden to save memory
// Schemas will be reloaded when user focuses a query box after tab becomes visible
try {
	document.addEventListener('visibilitychange', () => {
		try {
			if (document.hidden) {
				const clearGeneration = ++__kustoSchemaClearGeneration;
				// Tab is being hidden - clear the loaded schemas from worker memory
				// This frees significant memory while keeping the basic worker alive
				
				// Mark that we need to reload schemas on next focus
				__kustoWorkerNeedsSchemaReload = true;
				
				// Clear the loaded schemas tracking
				if (__kustoSchemaTracker.loadedSchemas) {
					__kustoSchemaTracker.loadedSchemas = {};
				}
				// Clear per-model tracking too (Monaco model URIs can be reused)
				try { __kustoSchemaTracker.loadedSchemasByModel = {}; } catch (e) { console.error('[kusto]', e); }
				try { __kustoForgetAllSchemaWorkerReady(false); } catch (e) { console.error('[kusto]', e); }
						try { __kustoSupplementalCoordinator.invalidateAllApplications(); } catch (e) { console.error('[kusto]', e); }
						try { __kustoScheduleSupplementalPump(0); } catch (e) { console.error('[kusto]', e); }
				try { __kustoMonacoDatabaseInContextByModel = {}; } catch (e) { console.error('[kusto]', e); }
				try { __kustoMonacoInitializedByModel = {}; } catch (e) { console.error('[kusto]', e); }
				try { for (const key of Object.keys(__kustoAutocompleteTraceByModelUri)) delete __kustoAutocompleteTraceByModelUri[key]; } catch (e) { console.error('[kusto]', e); }
				__kustoSchemaTracker.databaseInContext = null;
				__kustoSchemaContextIntents.clear();
				
				// Clear the schema from the worker through the schema queue so it cannot
				// race after a newer visible-tab schema apply.
					void __kustoWorkerMutations.enqueue({ kind: 'visibility-clear', advancesPrimaryIntent: true }, async transaction => {
					try {
						if (!transaction.isActive() || !document.hidden || clearGeneration !== __kustoSchemaClearGeneration) {
							return;
						}
						if (typeof monaco !== 'undefined' && monaco && monaco.languages && monaco.languages.kusto && 
							typeof monaco.languages.kusto.getKustoWorker === 'function') {
							const workerAccessor = await monaco.languages.kusto.getKustoWorker();
							const models = monaco.editor.getModels();
							if (models && models.length > 0 && workerAccessor) {
								for (const model of models) {
									try {
										if (!transaction.isActive() || !document.hidden || clearGeneration !== __kustoSchemaClearGeneration) {
											return;
										}
										const worker = await workerAccessor(model.uri);
										if (transaction.isActive() && worker && typeof worker.setSchema === 'function') {
											await worker.setSchema({ cluster: { connectionString: '', databases: [] } });
											transaction.commit({ destructive: true });
										}
									} catch (e) { console.error('[kusto]', e); }
								}
										}
						}
					} catch (e) { console.error('[kusto]', e); }
					}).catch((e: any) => { console.error('[monaco-kusto] queued schema clear failed:', e); });
			} else {
				__kustoSchemaClearGeneration++;
				if (__kustoWorkerNeedsSchemaReload) {
					__kustoWorkerNeedsSchemaReload = false;
					for (const boxId of Object.keys(queryEditors || {})) {
						const preparation = getKustoPreparationState(boxId);
						if (preparation.status === 'ready') {
							requireSchemaWorkerApply(boxId);
							requestKustoSchemaApplyForBox(boxId, false);
						}
					}
					__kustoScheduleSupplementalPump(0);
				}
			}
		} catch (e) { console.error('[kusto]', e); }
	}, true);
} catch (e) { console.error('[kusto]', e); }

function initQueryEditor(boxId: any) {
	perfMark('webview.monaco.queryEditor.init.start', { boxId });
	const expectedSectionElement = document.getElementById(String(boxId || ''));
	return ensureMonaco()!.then((monaco: any) => {
		const sectionLease = kustoEditorSchemaCoordinator.getLease(String(boxId || ''));
		if (!sectionLease) throw new Error(`Kusto section lifecycle is not ready for ${String(boxId || '')}.`);
		if (!kustoEditorSchemaCoordinator.isSectionLeaseCurrent(sectionLease)) return;
		const container = document.getElementById(boxId + '_query_editor');
		const wrapper = container && container.closest ? container.closest('.query-editor-wrapper') : null;
		const placeholder = document.getElementById(boxId + '_query_placeholder');
		const resizer = document.getElementById(boxId + '_query_resizer');
		if (!container) {
			return;
		}

		const updatePlaceholderPosition = () => {
			if (!placeholder) {
				return;
			}
			try {
				// The placeholder is absolutely positioned within .query-editor-wrapper.
				// Compute its position based on the Monaco container's actual on-screen
				// location so it stays correct even when the editor is nested (e.g. in
				// the Copilot split pane).
				if (!wrapper) {
					return;
				}
				const c = container.getBoundingClientRect();
				const w = wrapper.getBoundingClientRect();
				if (!c || !w) return;

				// Align to the first line number baseline (small +1px nudge).
				const top = (c.top - w.top) + 1;
				// Keep existing gutter offset behavior (56px) but relative to the editor's left.
				const left = (c.left - w.left) + 56;
				// Mirror the old right inset (10px) but relative to the editor's right.
				const right = (w.right - c.right) + 10;

				placeholder.style.top = Math.max(0, Math.round(top)) + 'px';
				placeholder.style.left = Math.max(0, Math.round(left)) + 'px';
				placeholder.style.right = Math.max(0, Math.round(right)) + 'px';
			} catch (e) { console.error('[kusto]', e); }
		};

		// If an editor instance already exists, ensure it's still attached to this container.
		// If it's stale (detached due to DOM teardown), dispose and recreate.
		try {
			const existing = queryEditors && queryEditors[boxId] ? queryEditors[boxId] : null;
			if (existing) {
				const dom = (typeof existing.getDomNode === 'function') ? existing.getDomNode() : null;
				const attached = !!(dom && dom.isConnected && container.contains(dom));
				if (attached) {
					return;
				}
				try { existing.__kustoCursorStatus?.dispose?.(); } catch (e) { console.error('[kusto]', e); }
				try { existing.dispose(); } catch (e) { console.error('[kusto]', e); }
				try { delete queryEditors[boxId]; } catch (e) { console.error('[kusto]', e); }
			}
		} catch (e) { console.error('[kusto]', e); }

		// Ensure flex sizing doesn't allow the editor container to expand with content.
		container.style.minHeight = '0';
		container.style.minWidth = '0';

		// If persistence restore ran before Monaco init, apply the restored wrapper height now.
		// This avoids layout glitches when the Copilot split-pane is installed.
		try {
			const pending = pState.pendingWrapperHeightPxByBoxId && pState.pendingWrapperHeightPxByBoxId[boxId];
			if (typeof pending === 'number' && Number.isFinite(pending) && pending > 0) {
				let w = wrapper;
				if (!w) {
					const box = document.getElementById(boxId);
					w = (box && box.querySelector) ? box.querySelector('.query-editor-wrapper') : null;
				}
				if (w) {
					(w as any).style.height = Math.round(pending) + 'px';
					try { (w as any).dataset.kustoUserResized = 'true'; } catch (e) { console.error('[kusto]', e); }
					// Also update the manual height map so __kustoGetWrapperHeightPx returns consistent values.
					try {
						if (!pState.manualQueryEditorHeightPxByBoxId || typeof pState.manualQueryEditorHeightPxByBoxId !== 'object') {
							pState.manualQueryEditorHeightPxByBoxId = {};
						}
						pState.manualQueryEditorHeightPxByBoxId[boxId] = Math.round(pending);
					} catch (e) { console.error('[kusto]', e); }
				}
				try { delete pState.pendingWrapperHeightPxByBoxId[boxId]; } catch (e) { console.error('[kusto]', e); }
			}
		} catch (e) { console.error('[kusto]', e); }

		// Avoid calling editor.setValue() during initialization; pass initial value into create()
		// to reduce async timing races in VS Code webviews.
		let initialValue = '';
		try {
			const pending = pState.pendingQueryTextByBoxId && pState.pendingQueryTextByBoxId[boxId];
			if (typeof pending === 'string') {
				initialValue = pending;
				try { delete pState.pendingQueryTextByBoxId[boxId]; } catch (e) { console.error('[kusto]', e); }
			}
		} catch (e) { console.error('[kusto]', e); }

		const readOnly = __kustoIsEditorReadOnlyByCapability();
		const editor = monaco.editor.create(container, {
			value: initialValue,
			language: 'kusto',
			readOnly,
			domReadOnly: readOnly,
			automaticLayout: true,
			scrollbar: { alwaysConsumeMouseWheel: false, verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
			// Reduce the blank gap between the line numbers and the code.
			// We rely on the line-decorations lane for the active-statement indicator, so keep it
			// non-zero but tight.
			glyphMargin: false,
			lineDecorationsWidth: 8,
			// Suggest (and other overflow widgets) can be mispositioned when Monaco is nested inside
			// multiple stacked, scrollable containers (e.g. the 3rd query box on screen).
			// Fixed overflow widgets use viewport-based geometry and are more reliable in VS Code webviews.
			fixedOverflowWidgets: true,
			// Monaco's built-in hover UI shows multiple stacked hover blocks (markers + providers)
			// and an action bar ("View Problem") that isn't useful in our webview.
			// We hide the action bar via CSS and keep our custom diagnostics tooltip for squiggles.
			hover: { enabled: true, above: true, sticky: false },
			// The default blinking caret invalidates focused hovers on the blink cadence in VS Code webviews.
			cursorBlinking: 'solid',
			// Autocomplete should be manual-only (Ctrl+Space / toolbar) unless explicitly triggered by code.
			suggestOnTriggerCharacters: false,
			quickSuggestions: false,
			quickSuggestionsDelay: 0,
			// We don't use Monaco quick-fix/lightbulb UX in this webview.
			lightbulb: { enabled: false },
			minimap: { enabled: false },
			scrollBeyondLastLine: false,
			// Disable Monaco's built-in context menu — most items (Go to Definition, Rename,
			// Format, etc.) have no providers in this webview and silently do nothing.
			// We provide a custom context menu with only the actions that actually work.
			contextmenu: false,
			fontFamily: getComputedStyle(document.body).getPropertyValue('--vscode-editor-font-family'),
			fontSize: 13,
			lineNumbers: 'on',
			renderLineHighlight: 'none',
			// Enable inline suggestions (ghost text completions from Copilot)
			inlineSuggest: { enabled: true }
		});
		if (!kustoEditorSchemaCoordinator.isSectionLeaseCurrent(sectionLease)) {
			try { editor.dispose(); } catch (e) { console.error('[kusto]', e); }
			return;
		}
		const modelUriAtCreation = editor.getModel?.()?.uri?.toString?.() || '';
		const modelLease: KustoEditorModelLease | undefined = kustoEditorSchemaCoordinator.attachModel(
			sectionLease,
			modelUriAtCreation,
		);
		if (!modelLease) {
			try { editor.dispose(); } catch (e) { console.error('[kusto]', e); }
			return;
		}

		// Keep Monaco's suggest widget usable inside the editor bounds.
		try { __kustoInstallSmartSuggestWidgetSizing(editor); } catch (e) { console.error('[kusto]', e); }

		// Single diagnostics tooltip (replaces Monaco's default hover widget).
		try {
			// monaco-kusto uses the language ID 'kusto' as the marker owner
			const DIAG_OWNER = 'kusto';
			const DIAG_HOVER_SHOW_DELAY_MS = 1000;
			let diagHoverEl: any = null;
			let diagHoverLastKey = '';
			let diagHoverHideTimer: any = null;
			let diagHoverShowTimer: any = null;
			let diagHoverPending: any = null;
			let diagHoverLastMouse = { at: 0, clientX: 0, clientY: 0, position: null };
			let diagHoverLastCursor = { at: 0, position: null };
			let diagHoverActiveSource = null; // 'mouse' | 'cursor'

			const ensureDiagHoverEl = () => {
				if (diagHoverEl) return diagHoverEl;
				const el = document.createElement('div');
				el.className = 'kusto-doc-widget kusto-diagnostics-hover';
				(el as any).style.position = 'fixed';
				(el as any).style.display = 'none';
				(el as any).style.pointerEvents = 'none';
				// Keep above the editor but below Monaco context widgets (quick fix / lightbulb menu).
				(el as any).style.zIndex = '1000';
				document.body.appendChild(el);
				diagHoverEl = el;
				return el;
			};

			const hideDiagHover = (immediate: any) => {
				try {
					if (diagHoverShowTimer) {
						clearTimeout(diagHoverShowTimer);
						diagHoverShowTimer = null;
					}
					diagHoverPending = null;
					if (diagHoverHideTimer) {
						clearTimeout(diagHoverHideTimer);
						diagHoverHideTimer = null;
					}
					if (immediate) {
						if (diagHoverEl) diagHoverEl.style.display = 'none';
						return;
					}
					diagHoverHideTimer = setTimeout(() => {
						try {
							if (diagHoverEl) diagHoverEl.style.display = 'none';
						} catch (e) { console.error('[kusto]', e); }
					}, 50);
				} catch (e) { console.error('[kusto]', e); }
			};

			const getDiagnosticAt = (model: any, position: any) => {
				try {
					if (!model || !position) return null;
					const markers = monaco.editor.getModelMarkers({ owner: DIAG_OWNER, resource: model.uri });
					if (!markers || !markers.length) return null;
					const line = position.lineNumber;
					const col = position.column;
					for (const m of markers) {
						if (!m) continue;
						if (m.startLineNumber > line || m.endLineNumber < line) continue;
						if (m.startLineNumber === line && m.startColumn > col) continue;
						if (m.endLineNumber === line && m.endColumn < col) continue;
						return m;
					}
					return null;
				} catch {
					return null;
				}
			};

			const formatDiagMessageHtml = (msg: any) => {
				const raw = String(msg || '').trim();
				const esc = escapeHtml(raw);
				// Minimal markdown-ish formatting: `code` + newlines.
				const withCode = String(esc)
					.replace(/`([^`]+)`/g, '<code>$1</code>')
					.replace(/\n/g, '<br/>');
				return (
					'<div style="font-weight:600; margin-bottom:6px;">Kusto syntax issue</div>' +
					'<div style="opacity:0.95;">' + withCode + '</div>'
				);
			};

			const isMonacoContextMenuVisible = () => {
				try {
					const dom = editor && typeof editor.getDomNode === 'function' ? editor.getDomNode() : null;
					if (!dom) return false;
					// Monaco renders quick-fix/lightbulb menus inside a context-view container.
					const menu = dom.querySelector('.context-view .monaco-menu-container');
					if (menu) {
						const r = menu.getBoundingClientRect();
						if ((r.width || 0) > 2 && (r.height || 0) > 2) return true;
					}
					return false;
				} catch {
					return false;
				}
			};

			const positionDiagHover = (el: any, clientX: any, clientY: any) => {
				try {
					const pad = 12;
					const maxW = 560;
					(el as any).style.maxWidth = maxW + 'px';
					(el as any).style.left = '0px';
					(el as any).style.top = '0px';
					(el as any).style.display = 'block';
					// Measure now that it's visible.
					const rect = el.getBoundingClientRect();
					const vw = Math.max(0, window.innerWidth || document.documentElement.clientWidth || 0);
					const vh = Math.max(0, window.innerHeight || document.documentElement.clientHeight || 0);
					let x = (Number(clientX) || 0) + pad;
					// Prefer above the pointer/caret.
					let y = (Number(clientY) || 0) - (rect.height || 0) - pad;
					if (y < 6) {
						y = (Number(clientY) || 0) + pad;
					}
					if (vw && rect.width && x + rect.width > vw - 6) {
						x = Math.max(6, vw - rect.width - 6);
					}
					if (vh && rect.height && y + rect.height > vh - 6) {
						// Clamp within viewport.
						y = Math.max(6, vh - rect.height - 6);
					}
					(el as any).style.left = Math.round(x) + 'px';
					(el as any).style.top = Math.round(y) + 'px';
				} catch (e) { console.error('[kusto]', e); }
			};

			const getClientPointForCursor = (pos: any) => {
				try {
					if (!pos) return null;
					const dom = editor && typeof editor.getDomNode === 'function' ? editor.getDomNode() : null;
					if (!dom) return null;
					const r = dom.getBoundingClientRect();
					const v = editor.getScrolledVisiblePosition(pos);
					if (!v) return null;
					// Place near the caret. +2 so it doesn't overlap the glyph.
					return {
						clientX: Math.round(r.left + (v.left || 0) + 2),
						clientY: Math.round(r.top + (v.top || 0) + 2)
					};
				} catch {
					return null;
				}
			};

			const showDiagHover = (marker: any, mouseEventOrPoint: any) => {
				try {
					if (!marker) {
						hideDiagHover(false);
						return;
					}
					// Don't show our tooltip while Monaco is displaying a context menu (e.g. lightbulb quick fix).
					if (isMonacoContextMenuVisible()) {
						hideDiagHover(true);
						return;
					}
					const el = ensureDiagHoverEl();
					const key = String(marker.code || '') + '|' + String(marker.message || '') + '|' + marker.startLineNumber + ':' + marker.startColumn + '-' + marker.endLineNumber + ':' + marker.endColumn;
					if (key !== diagHoverLastKey) {
						diagHoverLastKey = key;
						el.innerHTML = formatDiagMessageHtml(marker.message || '');
					}
					(el as any).style.display = 'block';
					const be = mouseEventOrPoint && mouseEventOrPoint.browserEvent ? mouseEventOrPoint.browserEvent : null;
					const cx = be ? be.clientX : (mouseEventOrPoint && typeof mouseEventOrPoint.clientX === 'number' ? mouseEventOrPoint.clientX : 0);
					const cy = be ? be.clientY : (mouseEventOrPoint && typeof mouseEventOrPoint.clientY === 'number' ? mouseEventOrPoint.clientY : 0);
					positionDiagHover(el, cx, cy);
				} catch (e) { console.error('[kusto]', e); }
			};

			const scheduleDiagHover = (marker: any, point: any, source: any) => {
				try {
					if (!marker) {
						hideDiagHover(false);
						return;
					}
					// If a context menu is visible, never schedule.
					if (isMonacoContextMenuVisible()) {
						hideDiagHover(true);
						return;
					}
					const key = String(marker.code || '') + '|' + String(marker.message || '') + '|' + marker.startLineNumber + ':' + marker.startColumn + '-' + marker.endLineNumber + ':' + marker.endColumn;
					diagHoverPending = { key, marker, point, source, at: Date.now() };
					if (diagHoverShowTimer) {
						clearTimeout(diagHoverShowTimer);
						diagHoverShowTimer = null;
					}
					diagHoverShowTimer = setTimeout(() => {
						try {
							if (!diagHoverPending) return;
							// If a Monaco context menu is now visible, abort.
							if (isMonacoContextMenuVisible()) {
								hideDiagHover(true);
								return;
							}
							const pending = diagHoverPending;
							// Only show if the pending marker is still the most recent.
							if (!pending || !pending.marker) return;
							// Avoid showing stale tooltips if the user moved away.
							if (pending.source === 'mouse') {
								if (computeActiveSource() !== 'mouse') return;
								const model = editor.getModel();
								const pos = diagHoverLastMouse.position;
								if (!model || !pos) return;
								const current = getDiagnosticAt(model, pos);
								if (!current) return;
								const curKey = String(current.code || '') + '|' + String(current.message || '') + '|' + current.startLineNumber + ':' + current.startColumn + '-' + current.endLineNumber + ':' + current.endColumn;
								if (curKey !== pending.key) return;
								showDiagHover(current, pending.point);
								return;
							}
							// cursor
							try {
								if (!editor.hasTextFocus()) return;
							} catch (e) { console.error('[kusto]', e); }
							if (computeActiveSource() !== 'cursor') return;
							const model = editor.getModel();
							const pos = editor.getPosition();
							if (!model || !pos) return;
							const current = getDiagnosticAt(model, pos);
							if (!current) return;
							const curKey = String(current.code || '') + '|' + String(current.message || '') + '|' + current.startLineNumber + ':' + current.startColumn + '-' + current.endLineNumber + ':' + current.endColumn;
							if (curKey !== pending.key) return;
							showDiagHover(current, pending.point);
						} catch (e) { console.error('[kusto]', e); }
					}, DIAG_HOVER_SHOW_DELAY_MS);
				} catch (e) { console.error('[kusto]', e); }
			};

			const computeActiveSource = () => {
				const m = diagHoverLastMouse.at || 0;
				const c = diagHoverLastCursor.at || 0;
				return (m >= c) ? 'mouse' : 'cursor';
			};

			const refreshDiagHoverFromActiveSource = () => {
				try {
					const model = editor.getModel();
					if (!model) {
						hideDiagHover(false);
						return;
					}

					const source = computeActiveSource();
					diagHoverActiveSource = source;

					if (source === 'mouse') {
						const pos = diagHoverLastMouse.position;
						if (!pos) {
							hideDiagHover(false);
							return;
						}
						const marker = getDiagnosticAt(model, pos);
						if (!marker) {
							hideDiagHover(false);
							return;
						}
						scheduleDiagHover(marker, { clientX: diagHoverLastMouse.clientX, clientY: diagHoverLastMouse.clientY }, 'mouse');
						return;
					}

					// cursor
					// Only show cursor-driven tooltip when editor is focused.
					try {
						if (!editor.hasTextFocus()) {
							hideDiagHover(false);
							return;
						}
					} catch (e) { console.error('[kusto]', e); }
					const pos = editor.getPosition();
					if (!pos) {
						hideDiagHover(false);
						return;
					}
					const marker = getDiagnosticAt(model, pos);
					if (!marker) {
						hideDiagHover(false);
						return;
					}
					const pt = getClientPointForCursor(pos) || { clientX: 0, clientY: 0 };
					scheduleDiagHover(marker, pt, 'cursor');
				} catch {
					hideDiagHover(false);
				}
			};

			// Hook mouse move to show diagnostics on hover.
			try {
				editor.onMouseMove((e: any) => {
					try {
						const now = Date.now();
						diagHoverLastMouse.at = now;
						if (!e || !e.target) {
							hideDiagHover(false);
							return;
						}
						const pos = e.target.position;
						const model = editor.getModel();
						if (!pos || !model) {
							hideDiagHover(false);
							return;
						}
						// Only treat as mouse-driven when the mouse actually moved.
						try {
							const be = e && e.event && e.event.browserEvent ? e.event.browserEvent : null;
							if (be) {
								diagHoverLastMouse.clientX = be.clientX;
								diagHoverLastMouse.clientY = be.clientY;
							}
						} catch (e) { console.error('[kusto]', e); }
						diagHoverLastMouse.position = pos;
						const marker = getDiagnosticAt(model, pos);
						if (!marker) {
							// If mouse is the active source, hide; otherwise leave cursor tooltip alone.
							if (computeActiveSource() === 'mouse') {
								hideDiagHover(false);
							}
							return;
						}
						if (computeActiveSource() === 'mouse') {
							scheduleDiagHover(marker, { clientX: diagHoverLastMouse.clientX, clientY: diagHoverLastMouse.clientY }, 'mouse');
						}
					} catch {
						hideDiagHover(false);
					}
				});
			} catch (e) { console.error('[kusto]', e); }

			// Hook cursor moves (keyboard or programmatic) to show diagnostics at caret.
			try {
				editor.onDidChangeCursorPosition((e: any) => {
					try {
						diagHoverLastCursor.at = Date.now();
						diagHoverLastCursor.position = e && e.position ? e.position : null;
						refreshDiagHoverFromActiveSource();
					} catch (e) { console.error('[kusto]', e); }
				});
			} catch (e) { console.error('[kusto]', e); }

			// If mouse is the active source, refresh when we scroll.
			try {
				editor.onDidScrollChange(() => {
					try {
						if (computeActiveSource() === 'cursor') {
							refreshDiagHoverFromActiveSource();
						}
					} catch (e) { console.error('[kusto]', e); }
				});
			} catch (e) { console.error('[kusto]', e); }

			try {
				editor.onMouseLeave(() => hideDiagHover(true));
			} catch (e) { console.error('[kusto]', e); }
			try {
				editor.onDidBlurEditorText(() => hideDiagHover(true));
			} catch (e) { console.error('[kusto]', e); }
		} catch (e) { console.error('[kusto]', e); }

		// Active statement indicator (only when multi-statement via blank-line separators).
		// We intentionally avoid a background highlight; instead, we draw a subtle gutter bar.
		try {
			// Shared statement splitting helpers.
			// - A "blank line" is a line containing only whitespace.
			// - Statements are separated by one-or-more blank lines (the existing behavior).
			// This must match Run Query behavior and the gutter indicator.
			try {
				if (typeof __kustoStatementSeparatorMinBlankLines !== 'number') {
					__kustoStatementSeparatorMinBlankLines = 1;
				}
			} catch (e) { console.error('[kusto]', e); }
			try {
				if (typeof __kustoGetStatementBlocksFromModel !== 'function') {
					__kustoGetStatementBlocksFromModel = function (model: any) {
						try {
							if (!model || typeof model.getLineCount !== 'function' || typeof model.getLineContent !== 'function') return [];
							const minBlankLines = Math.max(1, Number(__kustoStatementSeparatorMinBlankLines) || 1);
							const lineCount = Math.max(0, Number(model.getLineCount()) || 0);
							if (!lineCount) return [];
							const blocks = [];
							let startLine = null;
							let lastNonBlankLine = null;
							let blankRun = 0;
							let inTripleBacktick = false;
							for (let ln = 1; ln <= lineCount; ln++) {
								const lineText = String(model.getLineContent(ln) || '');
								// Track triple-backtick (```) multi-line string literals.
								// Count occurrences of ``` on this line to toggle the state;
								// an odd count flips the state, an even count keeps it unchanged.
								let tripleCount = 0;
								for (let ci = 0; ci < lineText.length - 2; ci++) {
									if (lineText[ci] === '`' && lineText[ci + 1] === '`' && lineText[ci + 2] === '`') {
										tripleCount++;
										ci += 2; // skip past the triple
									}
								}
								if (tripleCount % 2 === 1) {
									inTripleBacktick = !inTripleBacktick;
								}
								// While inside a triple-backtick string, blank lines are NOT separators.
								if (inTripleBacktick) {
									if (startLine === null) startLine = ln;
									lastNonBlankLine = ln;
									blankRun = 0;
									continue;
								}
								const isBlank = /^\s*$/.test(lineText);
								if (!isBlank) {
									if (startLine === null) {
										startLine = ln;
									}
									lastNonBlankLine = ln;
									blankRun = 0;
									continue;
								}

								// Blank line.
								if (startLine === null) {
									// Leading blank lines before the first statement.
									continue;
								}
								blankRun++;
								if (blankRun >= minBlankLines) {
									// Statement separator: end the current block at the last non-blank line.
									if (lastNonBlankLine !== null && lastNonBlankLine >= startLine) {
										blocks.push({ startLine: startLine, endLine: lastNonBlankLine });
									}
									startLine = null;
									lastNonBlankLine = null;
									blankRun = minBlankLines;
								}
							}
							if (startLine !== null && lastNonBlankLine !== null) {
								blocks.push({ startLine: startLine, endLine: lastNonBlankLine });
							}
							return blocks;
						} catch {
							return [];
						}
					};
				}
			} catch (e) { console.error('[kusto]', e); }
			try {
				if (typeof __kustoIsSeparatorBlankLine !== 'function') {
					__kustoIsSeparatorBlankLine = function (model: any, lineNumber: any) {
						try {
							if (!model || typeof model.getLineContent !== 'function' || typeof model.getLineCount !== 'function') return false;
							const lineCount = Math.max(0, Number(model.getLineCount()) || 0);
							const ln = Number(lineNumber) || 0;
							if (!ln || ln < 1 || ln > lineCount) return false;
							const minBlankLines = Math.max(1, Number(__kustoStatementSeparatorMinBlankLines) || 1);
							const isBlank = /^\s*$/.test(String(model.getLineContent(ln) || ''));
							if (!isBlank) return false;
							let start = ln;
							while (start > 1) {
								const prev = String(model.getLineContent(start - 1) || '');
								if (!/^\s*$/.test(prev)) break;
								start--;
							}
							let end = ln;
							while (end < lineCount) {
								const next = String(model.getLineContent(end + 1) || '');
								if (!/^\s*$/.test(next)) break;
								end++;
							}
							const len = (end - start) + 1;
							return len >= minBlankLines;
						} catch {
							return false;
						}
					};
				}
			} catch (e) { console.error('[kusto]', e); }
			try {
				if (typeof __kustoExtractStatementTextAtCursor !== 'function') {
					__kustoExtractStatementTextAtCursor = function (editor: any) {
						try {
							if (!editor || typeof editor.getModel !== 'function' || typeof editor.getPosition !== 'function') return null;
							const model = editor.getModel();
							const pos = editor.getPosition();
							if (!model || !pos || !pos.lineNumber) return null;
							const cursorLine = Number(pos.lineNumber) || 0;
							if (!cursorLine || cursorLine < 1) return null;
							// If the cursor is on a separator (2+ blank lines), treat as "no statement".
							try {
								if (__kustoIsSeparatorBlankLine && __kustoIsSeparatorBlankLine(model, cursorLine)) {
									return null;
								}
							} catch (e) { console.error('[kusto]', e); }
							const blocks = (__kustoGetStatementBlocksFromModel && typeof __kustoGetStatementBlocksFromModel === 'function')
								? __kustoGetStatementBlocksFromModel(model)
								: [];
							if (!blocks || !blocks.length) return null;
							let block = null;
							for (const b of blocks) {
								if (!b) continue;
								if (cursorLine >= b.startLine && cursorLine <= b.endLine) { block = b; break; }
							}
							if (!block) return null;
							const endCol = (typeof model.getLineMaxColumn === 'function') ? model.getLineMaxColumn(block.endLine) : 1;
							const range = {
								startLineNumber: block.startLine,
								startColumn: 1,
								endLineNumber: block.endLine,
								endColumn: endCol
							};
							const text = (typeof model.getValueInRange === 'function') ? model.getValueInRange(range) : '';
							const trimmed = String(text || '').trim();
							return trimmed || null;
						} catch {
							return null;
						}
					};
				}
			} catch (e) { console.error('[kusto]', e); }

			const ACTIVE_STMT_CLASS = 'kusto-active-statement-gutter';
			let activeStmtDecorationIds: any[] = [];
			let cachedBlocks: any = null;
			let cachedVersionId = -1;
			let scheduled = false;

			const computeStatementBlocks = (model: any) => {
				try {
					if (__kustoGetStatementBlocksFromModel && typeof __kustoGetStatementBlocksFromModel === 'function') {
						return __kustoGetStatementBlocksFromModel(model);
					}
				} catch (e) { console.error('[kusto]', e); }
				return [];
			};

			const getBlocksCached = (model: any) => {
				try {
					const v = (model && typeof model.getVersionId === 'function') ? model.getVersionId() : -1;
					if (v !== cachedVersionId || !Array.isArray(cachedBlocks)) {
						cachedVersionId = v;
						cachedBlocks = computeStatementBlocks(model);
					}
					return Array.isArray(cachedBlocks) ? cachedBlocks : [];
				} catch {
					cachedVersionId = -1;
					cachedBlocks = null;
					return [];
				}
			};

			const updateActiveStatementIndicator = () => {
				scheduled = false;
				try {
					const model = editor.getModel && editor.getModel();
					const pos = editor.getPosition && editor.getPosition();
					if (!model || !pos || !pos.lineNumber) {
						activeStmtDecorationIds = editor.deltaDecorations(activeStmtDecorationIds, []);
						return;
					}
					const blocks = getBlocksCached(model);
					// Only show when there are 2+ statements separated by blank lines.
					if (!blocks || blocks.length < 2) {
						activeStmtDecorationIds = editor.deltaDecorations(activeStmtDecorationIds, []);
						return;
					}
					// If cursor is on a separator blank-line run (2+ blank lines), don't show an active statement.
					try {
						if (__kustoIsSeparatorBlankLine && __kustoIsSeparatorBlankLine(model, pos.lineNumber)) {
							activeStmtDecorationIds = editor.deltaDecorations(activeStmtDecorationIds, []);
							return;
						}
					} catch (e) { console.error('[kusto]', e); }

					let block = null;
					for (const b of blocks) {
						if (!b) continue;
						if (b.startLine <= pos.lineNumber && pos.lineNumber <= b.endLine) {
							block = b;
							break;
						}
					}
					if (!block) {
						activeStmtDecorationIds = editor.deltaDecorations(activeStmtDecorationIds, []);
						return;
					}

					const range = new monaco.Range(block.startLine, 1, block.endLine, 1);
					activeStmtDecorationIds = editor.deltaDecorations(activeStmtDecorationIds, [
						{
							range,
							options: {
								isWholeLine: true,
								linesDecorationsClassName: ACTIVE_STMT_CLASS
							}
						}
					]);
				} catch {
					try { activeStmtDecorationIds = editor.deltaDecorations(activeStmtDecorationIds, []); } catch (e) { console.error('[kusto]', e); }
				}
			};

			const scheduleUpdate = () => {
				try {
					if (scheduled) return;
					scheduled = true;
					requestAnimationFrame(updateActiveStatementIndicator);
				} catch {
					scheduled = false;
					try { setTimeout(updateActiveStatementIndicator, 0); } catch (e) { console.error('[kusto]', e); }
				}
			};

			try {
				editor.onDidChangeCursorPosition(() => scheduleUpdate());
			} catch (e) { console.error('[kusto]', e); }
			try {
				editor.onDidChangeModelContent(() => {
					cachedVersionId = -1;
					scheduleUpdate();
				});
			} catch (e) { console.error('[kusto]', e); }
			try { editor.onDidFocusEditorText(() => scheduleUpdate()); } catch (e) { console.error('[kusto]', e); }
			try { editor.onDidBlurEditorText(() => scheduleUpdate()); } catch (e) { console.error('[kusto]', e); }
			// Initial paint.
			scheduleUpdate();
		} catch (e) { console.error('[kusto]', e); }

		// SEM0139 helper: auto-select term and open Find-with-selection.
		try {
			if (!__kustoAutoFindInQueryEditor) {
				__kustoAutoFindInQueryEditor = async (boxId: any, term: any) => {
					const bid = String(boxId || '').trim();
					const t = String(term || '');
					if (!bid || !t) return false;
					const ed = (typeof queryEditors !== 'undefined' && queryEditors) ? queryEditors[bid] : null;
					if (!ed) return false;
					try {
						const state = __kustoAutoFindStateByBoxId[bid];
						if (state && state.term === t) {
							return true;
						}
					} catch (e) { console.error('[kusto]', e); }
					const model = (ed && typeof ed.getModel === 'function') ? ed.getModel() : null;
					if (!model || typeof model.findMatches !== 'function') return false;
					let match = null;
					let usedTerm = t;
					const tryFind = (needle: any) => {
						try {
							const s = String(needle || '');
							if (!s) return null;
							const matches = model.findMatches(s, true, false, false, null, true, 1);
							return (matches && matches.length) ? matches[0] : null;
						} catch (e) { console.error('[kusto]', e); }
						return null;
					};

					// Try exact first, then a few safe normalizations for bracket/dynamic access.
					const candidates = (() => {
						const list: any[] = [];
						const push = (s: any) => {
							try {
								const v = String(s || '');
								if (!v) return;
								if (v.length > 400) return;
								if (!list.includes(v)) list.push(v);
							} catch (e) { console.error('[kusto]', e); }
						};

						push(t);
						// obj.["prop"] -> obj["prop"]
						push(t.replace(/\.\s*\[/g, '['));
						// Swap quote styles inside brackets: ["x"] <-> ['x']
						push(t.replace(/\[\s*"([^\"]+)"\s*\]/g, "['$1']"));
						push(t.replace(/\[\s*'([^']+)'\s*\]/g, '["$1"]'));
						// Extract inner property token from bracket access and try searching just that.
						try {
							const m = t.match(/\[\s*(?:"([^\"]+)"|'([^']+)')\s*\]/);
							const prop = m ? String(m[1] || m[2] || '') : '';
							if (prop) {
								push(prop);
								push('"' + prop + '"');
								push("'" + prop + "'");
								// obj.["prop"] -> obj.prop
								push(t.replace(/\[\s*(?:"([^\"]+)"|'([^']+)')\s*\]/g, '.' + prop).replace(/\.\./g, '.'));
							}
						} catch (e) { console.error('[kusto]', e); }

						return list;
					})();

					for (const c of candidates) {
						const m = tryFind(c);
						if (m && m.range) {
							match = m;
							usedTerm = c;
							break;
						}
					}

					if (!match || !match.range) {
						return false;
					}
					try {
						ed.focus();
						ed.setSelection(match.range);
						if (typeof ed.revealRangeInCenter === 'function') {
							ed.revealRangeInCenter(match.range);
						}
					} catch (e) { console.error('[kusto]', e); }
					try {
						const action = ed.getAction && ed.getAction('actions.findWithSelection');
						if (action && typeof action.run === 'function') {
							await action.run();
						} else {
							// Best-effort fallback.
							ed.trigger('keyboard', 'actions.find', {});
						}
					} catch (e) { console.error('[kusto]', e); }
					try {
						__kustoAutoFindStateByBoxId[bid] = { term: usedTerm, ts: Date.now() };
					} catch (e) { console.error('[kusto]', e); }
					return true;
				};
				// Retain window bridge for kw-query-section.ts which reads window.__kustoAutoFindInQueryEditor.
				_win.__kustoAutoFindInQueryEditor = __kustoAutoFindInQueryEditor;
			}
			if (typeof _win.__kustoClearAutoFindInQueryEditor !== 'function') {
				_win.__kustoClearAutoFindInQueryEditor = (boxId: any) => {
					const bid = String(boxId || '').trim();
					if (!bid) return;
					let had = false;
					try { had = !!(__kustoAutoFindStateByBoxId[bid]); } catch { had = false; }
					if (!had) return;
					try { delete __kustoAutoFindStateByBoxId[bid]; } catch (e) { console.error('[kusto]', e); }
					const ed = (typeof queryEditors !== 'undefined' && queryEditors) ? queryEditors[bid] : null;
					if (!ed) return;
					try {
						// Close find widget if it was opened by us.
						ed.trigger('keyboard', 'closeFindWidget', {});
					} catch (e) { console.error('[kusto]', e); }
					try {
						// Clear selection highlight.
						const pos = (typeof ed.getPosition === 'function') ? ed.getPosition() : null;
						if (pos) {
							ed.setSelection({ startLineNumber: pos.lineNumber, startColumn: pos.column, endLineNumber: pos.lineNumber, endColumn: pos.column });
						}
					} catch (e) { console.error('[kusto]', e); }
				};
			}
		} catch (e) { console.error('[kusto]', e); }

		// Right-click Cut/Copy in Monaco context menu uses Monaco actions (not DOM cut/copy events).
		// Override those actions to use our clipboard workaround when possible.
		try {
			const tryOverride = (actionId: any, isCut: any) => {
				try {
					const action = editor.getAction && editor.getAction(actionId);
					if (!action || typeof action.run !== 'function') {
						return;
					}
					const originalRun = action.run.bind(action);
					action.run = async () => {
						try {
							if (window && typeof _win.__kustoCopyOrCutMonacoEditor === 'function') {
								const ok = await _win.__kustoCopyOrCutMonacoEditor(editor, !!isCut);
								if (ok) {
									return;
								}
							}
						} catch (e) { console.error('[kusto]', e); }
						try {
							return await originalRun();
						} catch (e) { console.error('[kusto]', e); }
					};
				} catch (e) { console.error('[kusto]', e); }
			};
			tryOverride('editor.action.clipboardCutAction', true);
			tryOverride('editor.action.clipboardCopyAction', false);
		} catch (e) { console.error('[kusto]', e); }

		// Custom right-click context menu with only the actions that work in this webview.
		try {
			const editorDom = editor.getDomNode();
			if (editorDom) {
				editorDom.addEventListener('contextmenu', (e: MouseEvent) => {
					e.preventDefault();
					e.stopPropagation();
					__kustoShowEditorContextMenu(editor, e);
				});
			}
		} catch (e) { console.error('[kusto]', e); }

		if (!kustoEditorSchemaCoordinator.isModelLeaseCurrent(modelLease)) {
			try { editor.dispose(); } catch (e) { console.error('[kusto]', e); }
			return;
		}
		queryEditors[boxId] = editor;
		__kustoCancelMonacoInitRetry(String(boxId || ''));
		registerKustoSchemaApplyRequester(__kustoRegisteredSchemaApplyRequester);
		let unsubscribeSupplementalPreparation: (() => void) | null = null;
		try {
			unsubscribeSupplementalPreparation = subscribeKustoPreparation(String(boxId), (preparation) => {
				try {
					const modelUri = editor?.getModel?.()?.uri?.toString?.() || '';
					if (!modelUri) return;
					if (preparation.status === 'ready') {
						__kustoTraceCrossCluster('preparation.primary-ready', { boxId, modelUri, generation: preparation.generation, revision: preparation.revision });
						__kustoSyncSupplementalReferencesForBox(String(boxId), 'background');
						const changed = __kustoSupplementalCoordinator.setPrimaryReady(modelUri, true);
						for (const state of changed) {
							if (state.fetchedAvailable) __kustoTraceCrossCluster('preparation.supplemental-reapply', { modelUri, schemaKey: state.schemaKey });
						}
						__kustoScheduleSupplementalPump(0);
					} else if (preparation.status === 'preparing' || preparation.status === 'deferred' || preparation.status === 'error') {
						__kustoTraceCrossCluster('preparation.primary-not-ready', { boxId, modelUri, status: preparation.status, generation: preparation.generation, revision: preparation.revision });
						__kustoSupplementalCoordinator.setPrimaryReady(modelUri, false);
					}
				} catch (error) {
					__kustoTraceCrossCluster('preparation-sync.error', { boxId, errorType: error instanceof Error ? error.name : 'Error' });
				}
			});
		} catch (e) { console.error('[kusto]', e); }
		let unregisterPendingSchemaSuggestMutation: (() => void) | null = null;
		try {
			const updateSuggestVisibility = () => {
				const widget = __kustoFindSuggestWidgetForEditor(editor, { requireVisible: true, maxDistancePx: 320 });
				const visible = !!(widget && __kustoIsElementVisibleForSuggest(widget));
				const pending = getPendingSchemaWorkerUpdate(boxId);
				if (__kustoShouldFlushPendingSchemaAfterSuggestMutation({
					suggestVisible: visible,
					isActiveBox: activeQueryEditorBoxId === boxId,
					hasPendingSchema: !!pending,
				}) && __kustoUpdateSchemaForFocusedBox !== null) {
					traceFileOpen('monaco.schema.pending.flush.suggestClosed', { boxId, reason: pending?.reason || '' });
					void __kustoUpdateSchemaForFocusedBox(boxId);
				}
			};
			unregisterPendingSchemaSuggestMutation = __kustoRegisterGlobalSuggestMutationHandler(document, updateSuggestVisibility);
			updateSuggestVisibility();
		} catch (e) { console.error('[kusto]', e); }
		perfMark('webview.monaco.queryEditor.ready', { boxId });
		traceFileOpen('monaco.queryEditor.ready', { boxId, editorCount: Object.keys(queryEditors || {}).length });
		try {
			const editorIds = Object.keys(queryEditors || {}).filter(id => !!queryEditors[id]);
			if (!activeQueryEditorBoxId && editorIds.length === 1 && editorIds[0] === boxId && __kustoIsSoleQuerySectionBox(String(boxId)) && getPendingSchemaWorkerUpdate(boxId) && __kustoUpdateSchemaForFocusedBox !== null) {
				traceFileOpen('monaco.queryEditor.flushPendingSchema.openTime', { boxId });
				void __kustoUpdateSchemaForFocusedBox(boxId);
			}
		} catch (e) { console.error('[kusto]', e); }
		try {
			const cursorStatus = createMonacoCursorStatusPublisher({
				editor,
				boxId: String(boxId),
				editorKind: 'kusto',
				postMessage: (message) => postMessageToHost(message)
			});
			editor.__kustoCursorStatus = cursorStatus;
			const originalDispose = typeof editor.dispose === 'function' ? editor.dispose.bind(editor) : null;
			if (originalDispose) {
				editor.dispose = () => {
					try { __kustoAutocompleteRetryCoordinator.cancel(editor); } catch (e) { console.error('[kusto]', e); }
					try { cursorStatus.dispose(); } catch (e) { console.error('[kusto]', e); }
					return originalDispose();
				};
			}
		} catch (e) { console.error('[kusto]', e); }
		// Allow other scripts to reliably map editor -> boxId (used for global key handlers).
		try { editor.__kustoBoxId = boxId; } catch (e) { console.error('[kusto]', e); }
		// Work around sporadic webview timing issues where Monaco input can end up stuck readonly.
		try { __kustoEnsureEditorWritableSoon(editor); } catch (e) { console.error('[kusto]', e); }
		try { __kustoInstallWritableGuard(editor); } catch (e) { console.error('[kusto]', e); }
		// Auto-resize this editor to show full content, until the user manually resizes.
		try { __kustoAttachAutoResizeToContent(editor, container); } catch (e) { console.error('[kusto]', e); }

		// F1 should show docs hover (not the webview / VS Code default behavior).
		try {
			editor.addCommand(monaco.KeyCode.F1, () => {
				try {
					editor.trigger('keyboard', 'editor.action.showHover', {});
				} catch (e) { console.error('[kusto]', e); }
			});
		} catch (e) { console.error('[kusto]', e); }

		// Trigger suggest, then auto-hide it if Monaco has nothing to show.
		// NOTE: Be conservative here; hiding too early can suppress real suggestions.
		const __kustoHideSuggestIfNoSuggestions = (ed: any, expectedModelVersionId: any) => {
			try {
				const __kustoSafeEditorTrigger = (editor: any, commandId: any) => {
					try {
						if (!editor || !commandId) return;
						const result = editor.trigger('keyboard', commandId, {});
						// Some Monaco commands return a Promise; avoid unhandled rejections.
						if (result && typeof result.then === 'function') {
							result.catch(() => { /* ignore */ });
						}
					} catch (e) { console.error('[kusto]', e); }
				};

				try {
					if (typeof expectedModelVersionId === 'number') {
						const model = ed && ed.getModel && ed.getModel();
						const current = model && typeof model.getVersionId === 'function' ? model.getVersionId() : null;
						// If the user typed or the model changed, don't auto-hide.
						if (typeof current === 'number' && current !== expectedModelVersionId) {
							return;
						}
					}
				} catch (e) { console.error('[kusto]', e); }

				const widget = __kustoFindSuggestWidgetForEditor(ed, { requireVisible: true, maxDistancePx: 320 });
				if (!widget) return;
				// IMPORTANT:
				// Don't hide merely because rows haven't rendered yet.
				// Monaco can take a tick (or longer with async providers) to populate the list.
				const text = String(widget.textContent || '').toLowerCase();
				const hasNoSuggestionsText = text.includes('no suggestions');
				const hasRows = !!(widget.querySelector && widget.querySelector('.monaco-list-row'));
				const isVisible = __kustoIsElementVisibleForSuggest(widget);
				const hasProgress = !!(widget.querySelector && widget.querySelector('.monaco-progress-container'));
				const hasLoadingText = text.includes('loading');
				if (isVisible && hasNoSuggestionsText && !hasRows && !hasProgress && !hasLoadingText) {
					// Use the built-in internal command; don't call non-existent editor actions.
					__kustoSafeEditorTrigger(ed, 'hideSuggestWidget');
				}
			} catch (e) { console.error('[kusto]', e); }
		};

		// Enhancement (best-effort): when the suggest widget opens and the caret is inside a word,
		// preselect the suggestion that exactly matches the current word (if present).
		// This is intentionally defensive: if Monaco DOM/structure differs, it does nothing.
		const __kustoPreselectExactWordInSuggestIfPresent = (ed: any, expectedModelVersionId: any, forcedWord: any) => {
			try {
				if (!ed) return;
				try {
					if (typeof expectedModelVersionId === 'number') {
						const model = ed.getModel && ed.getModel();
						const current = model && typeof model.getVersionId === 'function' ? model.getVersionId() : null;
						if (typeof current === 'number' && current !== expectedModelVersionId) {
							return;
						}
					}
				} catch (e) { console.error('[kusto]', e); }

				let currentWord = '';
				if (typeof forcedWord === 'string' && forcedWord.trim()) {
					currentWord = forcedWord;
				} else {
					currentWord = __kustoGetWordNearCursor(ed);
				}
				if (!currentWord || !String(currentWord).trim()) return;
				const normalize = (s: any) => {
					try {
						let x = String(s || '').trim();
						// Strip common wrappers seen in Kusto identifiers.
						x = x.replace(/^(\[|\(|\{|"|')+/, '').replace(/(\]|\)|\}|"|')+$/, '');
						// For aria labels like "ColumnName, field" or "ColumnName: type" keep only the identifier.
						x = x.split(/[\s,\(:]/g).filter(Boolean)[0] || x;
						return String(x || '').trim();
					} catch {
						return String(s || '').trim();
					}
				};
				const target = normalize(currentWord);
				if (!target) return;
				const targetLower = target.toLowerCase();

				const widget = __kustoFindSuggestWidgetForEditor(ed, { requireVisible: true, maxDistancePx: 320 });
				if (!widget || typeof widget.querySelectorAll !== 'function') return;

				const tryFocusByInternalListModel = () => {
					// Monaco virtualizes list rows; when the suggest list is large/unfiltered the exact
					// matching item may not be present in the DOM yet. In that case, use internal list/tree
					// models to locate the item and focus it.
					try {
						if (typeof ed.getContribution !== 'function') return false;
						const ctrl = ed.getContribution('editor.contrib.suggestController');
						if (!ctrl) return false;

						const candidates = [];
						try { if (ctrl && ctrl._widget) candidates.push(ctrl._widget); } catch (e) { console.error('[kusto]', e); }
						try { if (ctrl && ctrl.widget) candidates.push(ctrl.widget); } catch (e) { console.error('[kusto]', e); }
						try { if (ctrl && ctrl._suggestWidget) candidates.push(ctrl._suggestWidget); } catch (e) { console.error('[kusto]', e); }
						try { if (ctrl && ctrl.suggestWidget) candidates.push(ctrl.suggestWidget); } catch (e) { console.error('[kusto]', e); }

						const tryGetList = (w0: any) => {
							try {
								const w = (w0 && w0.value) ? w0.value : w0;
								if (!w) return null;
								return w._list || w.list || w._tree || w.tree || null;
							} catch {
								return null;
							}
						};

						const getListLength = (list: any) => {
							try {
								if (!list) return 0;
								if (typeof list.length === 'number') return Math.max(0, Math.floor(list.length));
								if (typeof list.getLength === 'function') return Math.max(0, Math.floor(list.getLength()));
								const m = list._model || list.model;
								if (m) {
									if (typeof m.length === 'number') return Math.max(0, Math.floor(m.length));
									if (typeof m.size === 'number') return Math.max(0, Math.floor(m.size));
									if (typeof m.getLength === 'function') return Math.max(0, Math.floor(m.getLength()));
									if (typeof m.getSize === 'function') return Math.max(0, Math.floor(m.getSize()));
								}
							} catch (e) { console.error('[kusto]', e); }
							return 0;
						};

						const getElementAt = (list: any, idx: any) => {
							try {
								if (!list || !isFinite(idx)) return null;
								if (typeof list.element === 'function') return list.element(idx);
								if (typeof list.getElementAt === 'function') return list.getElementAt(idx);
								const m = list._model || list.model;
								if (m) {
									if (typeof m.get === 'function') return m.get(idx);
									if (typeof m.element === 'function') return m.element(idx);
									if (typeof m.getElementAt === 'function') return m.getElementAt(idx);
								}
							} catch (e) { console.error('[kusto]', e); }
							return null;
						};

						const getLabelFromElement = (el: any) => {
							try {
								if (!el) return '';
								// Try common shapes across Monaco builds.
								const direct = el.label || el.textLabel || el.insertText || el.filterText;
								if (typeof direct === 'string') return direct;
								const completion = el.completion || el.suggestion || el.item || el._item || el._completionItem;
								if (completion) {
									const l = completion.label || completion.textLabel || completion.insertText || completion.filterText;
									if (typeof l === 'string') return l;
									if (l && typeof l.label === 'string') return l.label;
								}
								// Some builds store label as an object.
								if (el.label && typeof el.label.label === 'string') return el.label.label;
							} catch (e) { console.error('[kusto]', e); }
							return '';
						};

						for (const w0 of candidates) {
							const list = tryGetList(w0);
							const len = getListLength(list);
							if (!list || !len) continue;
							// Bound work: suggest lists can be large when unfiltered.
							const limit = Math.min(len, 2500);
							for (let i = 0; i < limit; i++) {
								const el = getElementAt(list, i);
								let label = getLabelFromElement(el);
								label = normalize(label);
								if (!label) continue;
								if (String(label).toLowerCase() === targetLower) {
									try { if (typeof list.reveal === 'function') list.reveal(i); } catch (e) { console.error('[kusto]', e); }
									try { if (typeof list.setFocus === 'function') list.setFocus([i]); } catch (e) { console.error('[kusto]', e); }
									try { if (typeof list.setSelection === 'function') list.setSelection([]); } catch (e) { console.error('[kusto]', e); }
									return true;
								}
							}
						}
					} catch (e) { console.error('[kusto]', e); }
					return false;
				};

				// First attempt: DOM rows (fast when the list is already rendered/filtered).
				let matchRow = null;
				try {
					const rows = widget.querySelectorAll('.monaco-list-row');
					if (rows && rows.length) {
						for (const row of rows) {
							if (!row) continue;
							let label = '';
							try {
								const labelName = row.querySelector && row.querySelector('.label-name');
								if (labelName && typeof labelName.textContent === 'string') {
									label = labelName.textContent;
								}
							} catch (e) { console.error('[kusto]', e); }
							if (!label) {
								try {
									const aria = row.getAttribute ? row.getAttribute('aria-label') : '';
									label = String(aria || '');
								} catch (e) { console.error('[kusto]', e); }
							}
							label = normalize(label);
							if (!label) continue;
							if (String(label).toLowerCase() === targetLower) {
								matchRow = row;
								break;
							}
						}
					}
				} catch (e) { console.error('[kusto]', e); }

				// If the matching row isn't rendered yet, fall back to internal list model.
				if (!matchRow) {
					const did = tryFocusByInternalListModel();
					if (did) return true;
					return;
				}

				// Prefer focusing the Monaco list via internal APIs (more reliable than DOM hover).
				try {
					let idx = NaN;
					try {
						const s = (matchRow.getAttribute && matchRow.getAttribute('data-index')) || '';
						idx = parseInt(String(s || ''), 10);
					} catch (e) { console.error('[kusto]', e); }
					if (!isFinite(idx)) {
						try {
							const ds = matchRow.dataset && (matchRow.dataset.index || matchRow.dataset.row);
							idx = parseInt(String(ds || ''), 10);
						} catch (e) { console.error('[kusto]', e); }
					}

					if (isFinite(idx) && typeof ed.getContribution === 'function') {
						const ctrl = ed.getContribution('editor.contrib.suggestController');
						const candidates = [];
						try { if (ctrl && ctrl._widget) candidates.push(ctrl._widget); } catch (e) { console.error('[kusto]', e); }
						try { if (ctrl && ctrl.widget) candidates.push(ctrl.widget); } catch (e) { console.error('[kusto]', e); }
						try { if (ctrl && ctrl._suggestWidget) candidates.push(ctrl._suggestWidget); } catch (e) { console.error('[kusto]', e); }
						try { if (ctrl && ctrl.suggestWidget) candidates.push(ctrl.suggestWidget); } catch (e) { console.error('[kusto]', e); }
						for (const w0 of candidates) {
							const w1 = (w0 && w0.value) ? w0.value : w0;
							if (!w1) continue;
							const list = w1._list || w1.list || w1._tree || w1.tree;
							if (!list) continue;
							try { if (typeof list.reveal === 'function') list.reveal(idx); } catch (e) { console.error('[kusto]', e); }
							// Only change focus (highlight). Do NOT set selection; some Monaco builds treat
							// selection changes as an accept/commit signal.
								try { if (typeof list.setFocus === 'function') list.setFocus([idx]); } catch (e) { console.error('[kusto]', e); }
								return true;
						}
					}
				} catch (e) { console.error('[kusto]', e); }

				// Fallback: try to focus/select without accepting via gentle hover.
				try {
					const rect = matchRow.getBoundingClientRect ? matchRow.getBoundingClientRect() : null;
					const clientX = rect ? Math.floor(rect.left + Math.min(12, Math.max(2, rect.width / 2))) : 1;
					const clientY = rect ? Math.floor(rect.top + Math.min(8, Math.max(2, rect.height / 2))) : 1;
					const evInit = { bubbles: true, cancelable: true, view: window, clientX, clientY };
					try { matchRow.dispatchEvent(new MouseEvent('mouseover', evInit)); } catch (e) { console.error('[kusto]', e); }
					try { matchRow.dispatchEvent(new MouseEvent('mousemove', evInit)); } catch (e) { console.error('[kusto]', e); }
					try { matchRow.dispatchEvent(new MouseEvent('mouseenter', evInit)); } catch (e) { console.error('[kusto]', e); }
					return true;
				} catch (e) { console.error('[kusto]', e); }
			} catch (e) { console.error('[kusto]', e); }
			return false;
		};

		const __kustoTriggerAutocomplete = async (ed: any) => {
			let traceId = '';
			let request: KustoAutocompleteRetryRequest | undefined;
			try {
				if (!ed) return false;
				__kustoAutocompleteRetryCoordinator.cancel(ed);
				__kustoSetAutocompleteRetryPending(ed, false);
				let boxId = '';
				let modelUri = '';
				let position: any = null;
				let lineLength = 0;
				let wordNearCursorLength = 0;
				try {
					boxId = __kustoGetBoxIdForEditor(ed);
					const model = typeof ed.getModel === 'function' ? ed.getModel() : null;
					modelUri = model && model.uri ? String(model.uri.toString()) : '';
					position = typeof ed.getPosition === 'function' ? ed.getPosition() : null;
					const currentLine = model && position && typeof model.getLineContent === 'function' ? String(model.getLineContent(position.lineNumber) || '') : '';
					lineLength = currentLine.length;
					wordNearCursorLength = __kustoGetWordNearCursor(ed).length;
				} catch (e) { console.error('[kusto]', e); }
				const traceSeed = { boxId, modelUri, position, lineLength, wordNearCursorLength };
				const schemaTarget = boxId ? __kustoCaptureAutocompleteSchemaTarget(boxId) : undefined;
				request = boxId && schemaTarget ? __kustoAutocompleteRetryCoordinator.begin({
					editor: ed,
					boxId,
					isEditorCurrent: () => queryEditors?.[boxId] === ed
						&& __kustoAutocompleteSchemaTargetMatches(boxId, schemaTarget),
					subscribeCurrentness: listener => {
						const unsubscribe = kustoEditorSchemaCoordinator.subscribeLifecycle(event => {
							if (event.owner.boxId === boxId) listener();
						});
						return { dispose: unsubscribe };
					},
					subscribeCancellation: listener => __kustoSubscribeAutocompleteRetryCancellation(ed, listener),
				}) : undefined;
				traceId = startAutocompleteTrace(traceSeed);
				try { ed.__kustoAutocompleteTraceId = traceId; } catch (e) { console.error('[kusto]', e); }
				try { if (modelUri) __kustoAutocompleteTraceByModelUri[modelUri] = traceId; } catch (e) { console.error('[kusto]', e); }
				recordAutocompleteTrace(traceId, 'trigger-start', traceSeed);
				__kustoTriggerAutocompleteInternal = __kustoTriggerAutocomplete;
				const schemaState = await __kustoPrepareSchemaForAutocomplete(ed, traceId, request);
				recordAutocompleteTrace(traceId, 'schema-prepare-result', { schemaState });
				if (request && !__kustoAutocompleteRetryCoordinator.isCurrent(request)) {
					finishAutocompleteTrace(traceId, 'abandoned', { reason: 'autocomplete-request-stale' });
					try { __kustoClearAutocompleteTraceForModel(modelUri, traceId); } catch (e) { console.error('[kusto]', e); }
					return true;
				}
				if (schemaState === 'blocked') {
					finishAutocompleteTrace(traceId, 'success', { reason: 'schema-refresh-blocked-trigger' });
					try { __kustoClearAutocompleteTraceForModel(modelUri, traceId); } catch (e) { console.error('[kusto]', e); }
					return true;
				}
				try {
					const root = ed.getDomNode && ed.getDomNode();
					const host = root && root.closest ? (root.closest('.monaco-editor') || root) : root;
					const doc = root && root.ownerDocument ? root.ownerDocument : document;
					const widgets = host && typeof host.querySelectorAll === 'function'
						? host.querySelectorAll('.suggest-widget')
						: (doc && typeof doc.querySelectorAll === 'function' ? doc.querySelectorAll('.suggest-widget') : []);
					for (const widget of Array.from(widgets || []) as any[]) {
						try { if (widget.classList && widget.classList.contains('hidden')) widget.classList.remove('hidden'); } catch (e) { console.error('[kusto]', e); }
						try { if (widget.style && widget.style.display === 'none') widget.style.display = ''; } catch (e) { console.error('[kusto]', e); }
					}
				} catch (e) { console.error('[kusto]', e); }
				let shouldDeferTrigger = false;
				// Ensure the editor's layout info is up-to-date before Monaco decides
				// whether the suggest widget should render above or below the caret.
				try {
					ed.layout();
					// Layout changes can be async in VS Code webviews; defer the trigger by a frame
					// so Monaco computes widget placement from the updated dimensions.
					shouldDeferTrigger = true;
				} catch (e) { console.error('[kusto]', e); }

				let versionId = null;
				try {
					const model = ed.getModel && ed.getModel();
					versionId = model && typeof model.getVersionId === 'function' ? model.getVersionId() : null;
				} catch (e) { console.error('[kusto]', e); }
				// Record the trigger context so the suggest widget observer can preselect when rows arrive.
				try {
					ed.__kustoLastSuggestTriggerAt = Date.now();
					ed.__kustoLastSuggestTriggerModelVersionId = (typeof versionId === 'number') ? versionId : null;
				} catch (e) { console.error('[kusto]', e); }
				const triggerNow = () => {
					try {
						if (request && !__kustoAutocompleteRetryCoordinator.hasQueuedRetry(request)
							&& !__kustoAutocompleteRetryCoordinator.complete(request)) {
							recordAutocompleteTrace(traceId, 'suggest-skipped-stale-request', {});
							return false;
						}
						ed.trigger('keyboard', 'editor.action.triggerSuggest', {});
						recordAutocompleteTrace(traceId, 'suggest-triggered', {});
						try { if (typeof ed.__kustoScheduleSuggestClamp === 'function') ed.__kustoScheduleSuggestClamp(); } catch (e) { console.error('[kusto]', e); }
						return true;
					} catch (e) { console.error('[kusto]', e); recordAutocompleteTrace(traceId, 'suggest-trigger-error', { error: e instanceof Error ? e.message : String(e) }); return false; }
				};
				const frameResult = await runKustoAutocompleteTriggerFrame({
					isCurrent: () => !request || __kustoAutocompleteRetryCoordinator.isCurrent(request),
					trigger: triggerNow,
					schedule: run => {
						if (!shouldDeferTrigger) {
							run();
							return;
						}
						const deferred = () => {
							try { ed.layout(); } catch (e) { console.error('[kusto]', e); }
							run();
						};
						try { requestAnimationFrame(deferred); } catch { setTimeout(deferred, 0); }
					},
				});
				if (frameResult.stale) {
					recordAutocompleteTrace(traceId, 'suggest-skipped-stale-request', {});
					finishAutocompleteTrace(traceId, 'abandoned', { reason: 'autocomplete-request-stale-frame' });
					try { __kustoClearAutocompleteTraceForModel(modelUri, traceId); } catch (e) { console.error('[kusto]', e); }
					return true;
				}
				const triggered = frameResult.triggered;
				if (!frameResult.accepted) {
					return false;
				}
				// Let Monaco render and providers settle before we decide to hide.
				// Use longer delays and only hide if the model didn't change.
				setTimeout(() => __kustoHideSuggestIfNoSuggestions(ed, versionId), 1200);
				setTimeout(() => __kustoHideSuggestIfNoSuggestions(ed, versionId), 2500);
				setTimeout(() => {
					try {
						const root = ed.getDomNode && ed.getDomNode();
						const host = root && root.closest ? (root.closest('.monaco-editor') || root) : root;
						const widgets = host && typeof host.querySelectorAll === 'function' ? host.querySelectorAll('.suggest-widget') : [];
						const widget = widgets && widgets.length ? widgets[widgets.length - 1] as HTMLElement : null;
						const labels = widget
							? Array.from(widget.querySelectorAll('.monaco-list-row .label-name')).map((label: any) => String(label.textContent || '').trim()).filter(Boolean).slice(0, 80)
							: [];
						recordAutocompleteTrace(traceId, 'suggest-visible-snapshot', { hasWidget: !!widget, labelCount: labels.length, widgetTextLength: widget ? String(widget.textContent || '').length : 0 });
						finishAutocompleteTrace(traceId, labels.length ? 'success' : 'abandoned', { labelCount: labels.length });
						try { __kustoClearAutocompleteTraceForModel(modelUri, traceId); } catch (e) { console.error('[kusto]', e); }
					} catch (e) { recordAutocompleteTrace(traceId, 'suggest-visible-snapshot-error', { error: e instanceof Error ? e.message : String(e) }); }
				}, 900);
				// Best-effort preselect is driven by the suggest widget visibility observer (one-shot per open).
				return triggered;
			} catch (e) { if (request) __kustoAutocompleteRetryCoordinator.cancelRequest(request); console.error('[kusto]', e); finishAutocompleteTrace(traceId, 'failed', { error: e instanceof Error ? e.message : String(e) }); try { __kustoClearAutocompleteTraceId(traceId); } catch (cleanupError) { console.error('[kusto]', cleanupError); } return false; }
		};

		const __kustoMaybeAutoTriggerAutocomplete = (ed: any, boxId: any, changeEvent: any) => {
			try {
				if (!ed) return;
				if (typeof autoTriggerAutocompleteEnabled !== 'boolean' || !autoTriggerAutocompleteEnabled) return;
				// Only auto-trigger for the currently focused query editor.
				try {
					if (typeof activeQueryEditorBoxId === 'string' && activeQueryEditorBoxId !== boxId) {
						return;
					}
				} catch (e) { console.error('[kusto]', e); }
				try {
					if (typeof ed.hasTextFocus === 'function' && !ed.hasTextFocus()) {
						return;
					}
				} catch (e) { console.error('[kusto]', e); }

				// Heuristic: trigger for typical typing / completion contexts.
				let shouldTrigger = true;
				let maxChangeLen = 0; // Track longest change to detect autocomplete acceptance vs normal typing
				try {
					shouldTrigger = false;
					const ev = changeEvent && typeof changeEvent === 'object' ? changeEvent : null;
					const changes = ev && Array.isArray(ev.changes) ? ev.changes : null;
					if (!changes || !changes.length) {
						shouldTrigger = true;
					} else {
						for (const ch of changes) {
							const txt = ch && typeof ch.text === 'string' ? ch.text : '';
							if (!txt) {
								continue; // deletion
							}
							maxChangeLen = Math.max(maxChangeLen, txt.length);
							// Newline insertion is a good time to suggest operators/keywords.
							if (txt.indexOf('\n') >= 0 || txt.indexOf('\r') >= 0) {
								shouldTrigger = true;
								break;
							}
							// Typical identifiers / member access / pipe / assignment.
							if (/[A-Za-z0-9_.$|\[\(=]/.test(txt)) {
								shouldTrigger = true;
								break;
							}
							// Space after a pipe is a common moment to suggest operators.
							if (txt === ' ') {
								try {
									const model = ed.getModel && ed.getModel();
									const pos = ed.getPosition && ed.getPosition();
									if (model && pos && typeof model.getLineContent === 'function') {
										const line = model.getLineContent(pos.lineNumber) || '';
										const before = line.slice(0, Math.max(0, pos.column - 1));
										const trimmed = before.replace(/\s+$/, '');
										if (trimmed.endsWith('|')) {
											shouldTrigger = true;
											break;
										}
									}
								} catch (e) { console.error('[kusto]', e); }
							}
						}
					}
				} catch {
					shouldTrigger = true;
				}
				if (!shouldTrigger) return;
				// Skip bulk edits (agent writes, paste, autocomplete acceptance) — matches SQL parity.
				if (maxChangeLen > 2) return;

				// Debounce + rate-limit (typing can fire rapidly).
				try {
					if (ed.__kustoAutoSuggestTimer) {
						clearTimeout(ed.__kustoAutoSuggestTimer);
					}
				} catch (e) { console.error('[kusto]', e); }

				ed.__kustoAutoSuggestTimer = setTimeout(() => {
					try {
						const now = Date.now();
						const last = (typeof ed.__kustoAutoSuggestLastTriggeredAt === 'number') ? ed.__kustoAutoSuggestLastTriggeredAt : 0;
						if (now - last < 180) return;

						// Never auto-trigger when cursor is at the end of a completed term.
						// E.g.: `| where ColumnName > ColumnName2<cursor>` or `dcount(ClientName<cursor>)`
						// - there's nothing useful to suggest here. The user needs to type more first.
						try {
							const model = ed.getModel && ed.getModel();
							const pos = ed.getPosition && ed.getPosition();
							if (model && pos && typeof model.getLineContent === 'function') {
								const line = model.getLineContent(pos.lineNumber) || '';
								const col = pos.column; // 1-based
								const charBeforeCursor = col > 1 ? line[col - 2] : ''; // col-2 because col is 1-based
								const charAtCursor = col <= line.length ? line[col - 1] : ''; // char at cursor position (or empty if at EOL)

								const isWordChar = (c: any) => /[A-Za-z0-9_]/.test(c || '');

								// If cursor is right after a word character and NOT followed by another word character,
								// we're at the end of a completed term - skip triggering.
								// This covers: EOL, whitespace, ), ], }, comma, operators, etc.
								if (isWordChar(charBeforeCursor) && !isWordChar(charAtCursor)) {
									return;
								}
							}
						} catch (e) { console.error('[kusto]', e); }

						ed.__kustoAutoSuggestLastTriggeredAt = now;
						__kustoTriggerAutocomplete(ed);
					} catch (e) { console.error('[kusto]', e); }
				}, 140);
			} catch (e) { console.error('[kusto]', e); }
		};

		// Expose the preselect helper so the suggest widget sizing/visibility observer can call it.
		try {
			editor.__kustoPreselectExactWordInSuggestIfPresent = (forcedWord: any) => {
				try {
					// Cache the current target word (best-effort) so callers can avoid redundant focus changes.
					try {
						if (typeof forcedWord === 'string' && forcedWord.trim()) {
							editor.__kustoLastSuggestPreselectTargetLower = forcedWord.trim().toLowerCase();
						} else {
							const t = String(__kustoGetWordNearCursor(editor) || '').trim();
							if (t) {
								editor.__kustoLastSuggestPreselectTargetLower = t.toLowerCase();
							}
						}
					} catch (e) { console.error('[kusto]', e); }
					const model = editor.getModel && editor.getModel();
					const vid = model && typeof model.getVersionId === 'function' ? model.getVersionId() : null;
					// Prefer the version at trigger time (prevents selecting after typing changes the context).
					const expected = (typeof editor.__kustoLastSuggestTriggerModelVersionId === 'number')
						? editor.__kustoLastSuggestTriggerModelVersionId
						: (typeof vid === 'number' ? vid : null);
					return __kustoPreselectExactWordInSuggestIfPresent(editor, expected, forcedWord);
				} catch {
					return false;
				}
			};
		} catch (e) { console.error('[kusto]', e); }

		// Expose for toolbar / other scripts.
		try {
			if (typeof _win.__kustoTriggerAutocompleteForBoxId !== 'function') {
				_win.__kustoTriggerAutocompleteForBoxId = async (id: any) => {
					try {
						const ed = (typeof queryEditors !== 'undefined' && queryEditors) ? queryEditors[id] : null;
						if (ed) {
							return await __kustoTriggerAutocomplete(ed);
						}
					} catch (e) { console.error('[kusto]', e); }
					return false;
				};
			}
		} catch (e) { console.error('[kusto]', e); }

		const __kustoReplaceAllText = (ed: any, nextText: any, label: any) => {
			try {
				if (!ed) return;
				const model = ed.getModel && ed.getModel();
				if (!model) return;
				const current = model.getValue();
				if (current === nextText) return;
				try { ed.pushUndoStop && ed.pushUndoStop(); } catch (e) { console.error('[kusto]', e); }
				const full = model.getFullModelRange ? model.getFullModelRange() : null;
				if (!full) {
					model.setValue(nextText);
					return;
				}
				ed.executeEdits(label || 'kusto-format', [{ range: full, text: nextText }]);
				try { ed.pushUndoStop && ed.pushUndoStop(); } catch (e) { console.error('[kusto]', e); }
			} catch (e) { console.error('[kusto]', e); }
		};

		// Expose query formatting helpers for toolbar buttons.
		try {
			if (typeof _win.__kustoSingleLineQueryForBoxId !== 'function') {
				_win.__kustoSingleLineQueryForBoxId = (id: any) => {
					try {
						const ed = (typeof queryEditors !== 'undefined' && queryEditors) ? queryEditors[id] : null;
						if (!ed) return;
						const v = ed.getValue ? ed.getValue() : '';
						const next = __kustoToSingleLineKusto(v);
						__kustoReplaceAllText(ed, next, 'kusto-single-line');
					} catch (e) { console.error('[kusto]', e); }
				};
			}
			if (typeof _win.__kustoPrettifyQueryForBoxId !== 'function') {
				_win.__kustoPrettifyQueryForBoxId = (id: any) => {
					try {
						const ed = (typeof queryEditors !== 'undefined' && queryEditors) ? queryEditors[id] : null;
						if (!ed) return;
						const v = ed.getValue ? ed.getValue() : '';
						const next = __kustoPrettifyKustoTextWithSemicolonStatements(v);
						__kustoReplaceAllText(ed, next, 'kusto-prettify');
					} catch (e) { console.error('[kusto]', e); }
				};
			}
			if (typeof _win.__kustoPrettifyKustoText !== 'function') {
				_win.__kustoPrettifyKustoText = (text: any) => {
					try {
						return __kustoPrettifyKustoTextWithSemicolonStatements(String(text ?? ''));
					} catch {
						return String(text ?? '');
					}
				};
			}
			if (typeof _win.__kustoCopySingleLineQueryForBoxId !== 'function') {
				_win.__kustoCopySingleLineQueryForBoxId = async (id: any) => {
					try {
						const ed = (typeof queryEditors !== 'undefined' && queryEditors) ? queryEditors[id] : null;
						if (!ed) return;
						let v = ed.getValue ? ed.getValue() : '';
						// When the editor has multiple statements, operate on the statement under the cursor.
						try {
							const model = ed.getModel && ed.getModel();
							const blocks = (model && typeof __kustoGetStatementBlocksFromModel === 'function')
								? __kustoGetStatementBlocksFromModel(model)
								: [];
							const hasMultipleStatements = blocks && blocks.length > 1;
							if (hasMultipleStatements && typeof __kustoExtractStatementTextAtCursor === 'function') {
								const stmt = __kustoExtractStatementTextAtCursor(ed);
								if (stmt) {
									v = stmt;
								} else {
									try { postMessageToHost({ type: 'showInfo', message: 'Place the cursor inside a query statement (not on a separator) to copy that statement as a single line.' }); } catch (e) { console.error('[kusto]', e); }
									return;
								}
							}
						} catch (e) { console.error('[kusto]', e); }
						const single = __kustoToSingleLineKusto(v);

						// Copy to clipboard without modifying the editor.
						try {
							if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
								await navigator.clipboard.writeText(single);
								try { postMessageToHost({ type: 'showInfo', message: 'Single-line query copied to clipboard.' }); } catch (e) { console.error('[kusto]', e); }
								return;
							}
						} catch (e) { console.error('[kusto]', e); }

						// Fallback path.
						const ta = document.createElement('textarea');
						ta.value = single;
						ta.setAttribute('readonly', '');
						ta.style.position = 'fixed';
						ta.style.left = '-9999px';
						ta.style.top = '0';
						(document.body || document.documentElement).appendChild(ta);
						ta.focus();
						ta.select();
						const ok = document.execCommand('copy');
						try { ta.parentNode && ta.parentNode.removeChild(ta); } catch (e) { console.error('[kusto]', e); }
						if (!ok) {
							throw new Error('copy failed');
						}
						try { postMessageToHost({ type: 'showInfo', message: 'Single-line query copied to clipboard.' }); } catch (e) { console.error('[kusto]', e); }
					} catch {
						try { postMessageToHost({ type: 'showInfo', message: 'Failed to copy single-line query to clipboard.' }); } catch (e) { console.error('[kusto]', e); }
					}
				};
			}
		} catch (e) { console.error('[kusto]', e); }

		// Copy as inline function — converts .create[-or-alter] function to let statement.
		try {
			if (typeof _win.__kustoCopyAsInlineFunctionForBoxId !== 'function') {
				_win.__kustoCopyAsInlineFunctionForBoxId = async (id: any) => {
					try {
						const ed = (typeof queryEditors !== 'undefined' && queryEditors) ? queryEditors[id] : null;
						if (!ed) return;
						let v = ed.getValue ? ed.getValue() : '';
						// When the editor has multiple statements, operate on the statement under the cursor.
						try {
							const model = ed.getModel && ed.getModel();
							const blocks = (model && typeof __kustoGetStatementBlocksFromModel === 'function')
								? __kustoGetStatementBlocksFromModel(model)
								: [];
							const hasMultipleStatements = blocks && blocks.length > 1;
							if (hasMultipleStatements && typeof __kustoExtractStatementTextAtCursor === 'function') {
								const stmt = __kustoExtractStatementTextAtCursor(ed);
								if (stmt) {
									v = stmt;
								} else {
									try { postMessageToHost({ type: 'showInfo', message: 'Place the cursor inside a function definition to copy it as an inline function.' }); } catch (e) { console.error('[kusto]', e); }
									return;
								}
							}
						} catch (e) { console.error('[kusto]', e); }
						const result = __kustoConvertFunctionToInline(v);
						if (!result) {
							try { postMessageToHost({ type: 'showInfo', message: 'No function definition found in this section.' }); } catch (e) { console.error('[kusto]', e); }
							return;
						}

						// Copy to clipboard without modifying the editor.
						try {
							if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
								await navigator.clipboard.writeText(result.text);
								try { postMessageToHost({ type: 'showInfo', message: 'Inline function copied to clipboard.' }); } catch (e) { console.error('[kusto]', e); }
								return;
							}
						} catch (e) { console.error('[kusto]', e); }

						// Fallback path.
						const ta = document.createElement('textarea');
						ta.value = result.text;
						ta.setAttribute('readonly', '');
						ta.style.position = 'fixed';
						ta.style.left = '-9999px';
						ta.style.top = '0';
						(document.body || document.documentElement).appendChild(ta);
						ta.focus();
						ta.select();
						const ok = document.execCommand('copy');
						try { ta.parentNode && ta.parentNode.removeChild(ta); } catch (e) { console.error('[kusto]', e); }
						if (!ok) {
							throw new Error('copy failed');
						}
						try { postMessageToHost({ type: 'showInfo', message: 'Inline function copied to clipboard.' }); } catch (e) { console.error('[kusto]', e); }
					} catch {
						try { postMessageToHost({ type: 'showInfo', message: 'Failed to copy inline function to clipboard.' }); } catch (e) { console.error('[kusto]', e); }
					}
				};
			}
		} catch (e) { console.error('[kusto]', e); }

		// Ensure Ctrl+Space always triggers autocomplete inside the webview.
		try {
			editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Space, () => {
				void __kustoTriggerAutocomplete(editor);
			});
		} catch (e) { console.error('[kusto]', e); }

		// Ctrl+Shift+Space triggers Copilot inline suggestions (ghost text) on demand.
		try {
			editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Space, () => {
				console.log('[Kusto] CTRL+SHIFT+SPACE pressed');
				try {
					// Try the action runner first (more reliable).
					const action = editor.getAction('editor.action.inlineSuggest.trigger');
					if (action) {
						action.run().catch(() => { /* ignore */ });
					} else {
						editor.trigger('keyboard', 'editor.action.inlineSuggest.trigger', {});
					}
				} catch (e) {
					console.error('[Kusto] CTRL+SHIFT+SPACE trigger failed', e);
				}
			});
		} catch (e) { console.error('[kusto]', e); }

		// Ctrl+Enter / Ctrl+Shift+Enter should execute the query (same as the Run button).
		// NOTE: We install this at the Monaco level so Monaco can't consume Ctrl+Shift+Enter before
		// our document-level capture handler runs.
		try {
			if ((window as unknown as { __kustoReadOnlyMode?: boolean }).__kustoReadOnlyMode !== true) {
				const __kustoRunThisQueryBox = () => {
					try {
						executeQuery(boxId);
					} catch (e) { console.error('[kusto]', e); }
				};
				editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, __kustoRunThisQueryBox);
				editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Enter, __kustoRunThisQueryBox);
			}
		} catch (e) { console.error('[kusto]', e); }

		// Docs tooltip: keep visible while typing, even when Monaco autocomplete is open.
		const renderDocMarkdownToHtml = (markdown: any) => {
			let raw = String(markdown || '');
			if (!raw.trim()) {
				return '';
			}
			// Presentation tweak: remove the blank line between the signature (first line)
			// and the documentation that follows.
			try {
				const normalized = String(raw).replace(/\r\n/g, '\n');
				const lines = normalized.split('\n');
				let firstNonEmpty = -1;
				for (let i = 0; i < lines.length; i++) {
					if (String(lines[i] || '').trim().length > 0) {
						firstNonEmpty = i;
						break;
					}
				}
				if (firstNonEmpty >= 0) {
					const after = firstNonEmpty + 1;
					if (after < lines.length && String(lines[after] || '').trim().length === 0) {
						lines.splice(after, 1);
						raw = lines.join('\n');
					}
				}
			} catch (e) { console.error('[kusto]', e); }
			const escaped = escapeHtml(raw);
			const html = escaped
				.replace(/\r\n/g, '\n')
				// Signature blocks: {{sig}}...{{/sig}} → styled span (must run before backtick/bold).
				.replace(/\{\{sig\}\}([\s\S]*?)\{\{\/sig\}\}/g, '<span class=\"qe-sig\">$1</span>')
				.replace(/`([^`]+)`/g, '<code>$1</code>')
				// Show literal **...** markers while also bolding the content.
				.replace(/\*\*([^*]+)\*\*/g, '<strong>**$1**</strong>');

			// Use per-line block elements so CSS can add bottom spacing per line.
			try {
				const parts = String(html).split('\n');
				return parts
					.map((line) => {
						const s = String(line ?? '');
						return '<div class="qe-caret-docs-line">' + (s.trim() ? s : '&nbsp;') + '</div>';
					})
					.join('');
			} catch {
				return html;
			}
		};

		// Render caret docs as a banner at the top of the editor (less distracting than a tooltip).
		// Keep triggers/content logic the same; only change presentation.
		const createDocOverlay = () => {
			const banner = document.getElementById(boxId + '_caret_docs');
			const text = document.getElementById(boxId + '_caret_docs_text') || banner;
			let lastHtml = '';
			let lastDocsHtml = '';
			let lastKey = '';
			const watermarkTitle = 'Smart documentation';
			const watermarkBody = 'Kusto documentation will appear here as the cursor moves around';

			// Persist last docs HTML across editor/overlay recreation (can happen if VS Code detaches the webview DOM).
			try {
				if (!__kustoCaretDocsLastHtmlByBoxId || typeof __kustoCaretDocsLastHtmlByBoxId !== 'object') {
					__kustoCaretDocsLastHtmlByBoxId = {};
				}
				const cached = __kustoCaretDocsLastHtmlByBoxId[boxId];
				if (typeof cached === 'string' && cached.trim()) {
					lastDocsHtml = cached;
					lastHtml = cached;
					// If caret-docs are enabled, paint the cached docs immediately so we don't flash watermark.
					try {
						if (typeof caretDocsEnabled === 'undefined' || caretDocsEnabled !== false) {
							if (banner) banner.style.display = 'flex';
							if (text) {
								if (text.classList) text.classList.remove('is-watermark');
								text.innerHTML = cached;
							}
						}
					} catch (e) { console.error('[kusto]', e); }
				}
			} catch (e) { console.error('[kusto]', e); }

			// In VS Code webviews, document.hasFocus() can be unreliable when the VS Code window
			// loses focus. Track focus explicitly from window-level events.
			try {
				if (typeof __kustoWebviewHasFocus !== 'boolean') {
					__kustoWebviewHasFocus = true;
				}
				if (!__kustoWebviewFocusListenersInstalled) {
					__kustoWebviewFocusListenersInstalled = true;
					try {
						window.addEventListener(
							'blur',
							() => {
								try { __kustoWebviewHasFocus = false; } catch (e) { console.error('[kusto]', e); }
								// After focus flips, refresh the active overlay once so it can freeze/restore docs.
								try {
									setTimeout(() => {
										try {
											if (typeof _win.__kustoRefreshActiveCaretDocs === 'function') {
												_win.__kustoRefreshActiveCaretDocs();
											}
										} catch (e) { console.error('[kusto]', e); }
									}, 0);
								} catch (e) { console.error('[kusto]', e); }
							},
							true
						);
					} catch (e) { console.error('[kusto]', e); }
					try { window.addEventListener('focus', () => { try { __kustoWebviewHasFocus = true; } catch (e) { console.error('[kusto]', e); } }, true); } catch (e) { console.error('[kusto]', e); }
					try {
						document.addEventListener('visibilitychange', () => {
							try {
								// When the tab becomes hidden, treat as unfocused.
								__kustoWebviewHasFocus = !document.hidden;
							} catch (e) { console.error('[kusto]', e); }
						}, true);
					} catch (e) { console.error('[kusto]', e); }
				}
			} catch (e) { console.error('[kusto]', e); }

			const isWebviewFocused = () => {
				try {
					if (typeof __kustoWebviewHasFocus === 'boolean') {
						return !!__kustoWebviewHasFocus;
					}
				} catch (e) { console.error('[kusto]', e); }
				try {
					return typeof document.hasFocus === 'function' ? !!document.hasFocus() : true;
				} catch {
					return true;
				}
			};

			const showWatermark = () => {
				// Never overwrite real docs while the overall VS Code/webview is unfocused.
				try {
					if (!isWebviewFocused() && (lastDocsHtml || lastHtml)) {
						return;
					}
				} catch (e) { console.error('[kusto]', e); }
				try {
					if (banner) {
						banner.style.display = 'flex';
					}
				} catch (e) { console.error('[kusto]', e); }
				try { updatePlaceholderPosition(); } catch (e) { console.error('[kusto]', e); }
				try {
					if (text) {
						text.innerHTML =
							'<div class="qe-caret-docs-line qe-caret-docs-watermark-title">' +
							watermarkTitle +
							'</div>' +
							'<div class="qe-caret-docs-line qe-caret-docs-watermark-body">' +
							watermarkBody +
							'</div>';
						if (text.classList) {
							text.classList.add('is-watermark');
						}
					}
				} catch (e) { console.error('[kusto]', e); }
				lastHtml = '';
				lastKey = 'watermark';
			};

			const hide = () => {
				try {
					if (banner) banner.style.display = 'none';
				} catch (e) { console.error('[kusto]', e); }
				try { updatePlaceholderPosition(); } catch (e) { console.error('[kusto]', e); }
			};

			const update = () => {
				try {
					// Default to enabled if the global toggle hasn't been initialized yet.
					try {
						if (typeof caretDocsEnabled !== 'undefined' && caretDocsEnabled === false) {
							hide();
							return;
						}
					} catch (e) { console.error('[kusto]', e); }

						// When the editor is not focused, freeze the banner content.
						// This avoids resetting to the watermark while focus is elsewhere.
						try {
							let hasFocus = false;
							try {
								let knownUnfocused = false;
								// If the overall VS Code/webview is unfocused, freeze regardless of Monaco state.
								try {
									if (typeof __kustoWebviewHasFocus === 'boolean' && __kustoWebviewHasFocus === false) {
										knownUnfocused = true;
									}
								} catch (e) { console.error('[kusto]', e); }

								// If the VS Code window/webview isn't focused, freeze regardless of Monaco internals.
								if (!knownUnfocused) {
									try {
										if (typeof document !== 'undefined' && typeof document.hasFocus === 'function' && !document.hasFocus()) {
											knownUnfocused = true;
										}
									} catch (e) { console.error('[kusto]', e); }
								}

								if (!knownUnfocused) {
									const dom = typeof editor.getDomNode === 'function' ? editor.getDomNode() : null;
									const ae = (typeof document !== 'undefined') ? document.activeElement : null;
									if (dom && ae && typeof dom.contains === 'function') {
										hasFocus = dom.contains(ae);
									} else {
										hasFocus =
										(typeof editor.hasTextFocus === 'function' && editor.hasTextFocus()) ||
										(typeof editor.hasWidgetFocus === 'function' && editor.hasWidgetFocus());
									}
								}
							} catch {
								hasFocus =
								(typeof editor.hasTextFocus === 'function' && editor.hasTextFocus()) ||
								(typeof editor.hasWidgetFocus === 'function' && editor.hasWidgetFocus());
							}
							// Apply document focus as a final gate (activeElement can be stale when app loses focus).
							try {
								if (typeof document !== 'undefined' && typeof document.hasFocus === 'function' && !document.hasFocus()) {
									hasFocus = false;
								}
							} catch (e) { console.error('[kusto]', e); }
							if (!hasFocus) {
								// If we've never rendered any docs yet, keep the watermark behavior.
								if (!lastDocsHtml && !lastHtml) {
									showWatermark();
									return;
								}
								// If we have prior docs, ensure they remain rendered.
								try {
									if (lastDocsHtml && text) {
										if (text.classList) text.classList.remove('is-watermark');
										text.innerHTML = lastDocsHtml;
									}
								} catch (e) { console.error('[kusto]', e); }
								try {
									if (banner) banner.style.display = 'flex';
								} catch (e) { console.error('[kusto]', e); }
								try { updatePlaceholderPosition(); } catch (e) { console.error('[kusto]', e); }
								return;
							}
						} catch (e) { console.error('[kusto]', e); }

					// Prefer the explicit "active editor" tracking. In some Monaco builds,
					// hasTextFocus/hasWidgetFocus can be unreliable while the suggest widget is open.
					try {
						const activeId = (typeof activeQueryEditorBoxId !== 'undefined' && activeQueryEditorBoxId)
							? String(activeQueryEditorBoxId)
							: null;
						if (activeId && activeId !== String(boxId)) {
								// When another editor is active, keep the last content (if any) instead
								// of resetting to the watermark.
								if (!lastHtml) {
									showWatermark();
								} else {
									try { if (banner) banner.style.display = 'flex'; } catch (e) { console.error('[kusto]', e); }
									try { updatePlaceholderPosition(); } catch (e) { console.error('[kusto]', e); }
								}
								return;
						}
					} catch (e) { console.error('[kusto]', e); }

					const model = editor.getModel();
					const pos = editor.getPosition();
					const sel = editor.getSelection();
							if (!model || !pos || !sel || !sel.isEmpty()) {
								// Don't lose the last docs due to transient blur/selection glitches.
								if (lastDocsHtml) {
									try {
										if (banner) banner.style.display = 'flex';
										if (text) {
											if (text.classList) text.classList.remove('is-watermark');
											text.innerHTML = lastDocsHtml;
										}
									} catch (e) { console.error('[kusto]', e); }
									try { updatePlaceholderPosition(); } catch (e) { console.error('[kusto]', e); }
									return;
								}
								showWatermark();
								return;
							}

					const getter = __kustoGetHoverInfoAt;
					if (typeof getter !== 'function') {
						showWatermark();
						return;
					}

					// Probe near the caret so we still show docs when the caret is on/near '(' or ')' or just after ')'.
					// Keep the caret position first so active-argument detection stays accurate.
					const probePositions = [pos];
					let originalOffset = null;
					try {
						originalOffset = model.getOffsetAt(pos);
					} catch {
						originalOffset = null;
					}
					try {
						const maxCol = typeof model.getLineMaxColumn === 'function' ? model.getLineMaxColumn(pos.lineNumber) : null;
						if (pos.column > 1) probePositions.push(new monaco.Position(pos.lineNumber, pos.column - 1));
						if (pos.column > 2) probePositions.push(new monaco.Position(pos.lineNumber, pos.column - 2));
						if (typeof maxCol === 'number' && pos.column < maxCol) probePositions.push(new monaco.Position(pos.lineNumber, pos.column + 1));
					} catch (e) { console.error('[kusto]', e); }
					let info = null;
					for (const p of probePositions) {
						try {
							info = getter(model, p, boxId, { inferPipeOperatorContext: true });
							if (info && info.markdown) {
								// For control commands, do NOT keep docs visible after the caret moves outside
								// the command/options region, even if probing hits ')' or nearby characters.
								try {
									if (
										info.__kustoKind === 'controlCommand' &&
										typeof info.__kustoStartOffset === 'number' &&
										typeof info.__kustoMaxOffset === 'number' &&
										typeof originalOffset === 'number'
									) {
										if (originalOffset < info.__kustoStartOffset || originalOffset > info.__kustoMaxOffset) {
											info = null;
											continue;
										}
									}
								} catch (e) { console.error('[kusto]', e); }
								break;
							}
						} catch (e) { console.error('[kusto]', e); }
					}
					const html = info && info.markdown ? renderDocMarkdownToHtml(info.markdown) : '';
					if (!html) {
						showWatermark();
						return;
					}

					const key = `${pos.lineNumber}:${pos.column}:${html.slice(0, 120)}`;
							if (html !== lastHtml) {
						lastHtml = html;
								lastDocsHtml = html;
								try {
									if (__kustoCaretDocsLastHtmlByBoxId && typeof __kustoCaretDocsLastHtmlByBoxId === 'object') {
										__kustoCaretDocsLastHtmlByBoxId[boxId] = html;
									}
								} catch (e) { console.error('[kusto]', e); }
						try {
							if (text) {
								if (text.classList) {
									text.classList.remove('is-watermark');
								}
								text.innerHTML = html;
							}
						} catch (e) { console.error('[kusto]', e); }
					}
					if (key !== lastKey) {
						lastKey = key;
					}

					try {
						if (banner) banner.style.display = 'flex';
					} catch (e) { console.error('[kusto]', e); }
					try { updatePlaceholderPosition(); } catch (e) { console.error('[kusto]', e); }
				} catch (e) { console.error('[kusto]', e); }
			};

			return { update, hide, showWatermark };
		};

					const docOverlay = createDocOverlay();
					try {
						if (typeof caretDocOverlaysByBoxId !== 'undefined' && caretDocOverlaysByBoxId) {
							caretDocOverlaysByBoxId[boxId] = docOverlay;
						}
					} catch (e) { console.error('[kusto]', e); }

					// Keep the overlay positioned correctly when the outer webview scrolls/resizes.
					// Install once globally to avoid accumulating listeners per editor.
					try {
						if (!__kustoCaretDocsViewportListenersInstalled) {
							__kustoCaretDocsViewportListenersInstalled = true;
							const refreshActive = () => {
								try {
									if (typeof caretDocsEnabled !== 'undefined' && caretDocsEnabled === false) {
										return;
									}
									const overlays = typeof caretDocOverlaysByBoxId !== 'undefined' ? caretDocOverlaysByBoxId : null;
									if (!overlays) {
										return;
									}
									let activeId = null;
									try {
										activeId = typeof activeQueryEditorBoxId !== 'undefined' ? activeQueryEditorBoxId : null;
									} catch {
										activeId = null;
									}
									if (activeId && overlays[activeId] && typeof overlays[activeId].update === 'function') {
										overlays[activeId].update();
									}
								} catch (e) { console.error('[kusto]', e); }
							};
								try {
									// Allow other features (e.g., async doc fetch) to request a re-render of the active caret-docs banner.
									_win.__kustoRefreshActiveCaretDocs = refreshActive;
								} catch (e) { console.error('[kusto]', e); }
							addPageScrollListener(refreshActive, { passive: true });
							window.addEventListener('resize', refreshActive);
						}
					} catch (e) { console.error('[kusto]', e); }

		// Hide caret tooltip on Escape (without preventing Monaco default behavior).
		try {
			editor.onKeyDown((e: any) => {
				try {
					if (!e) return;
					// monaco.KeyCode.Escape === 9
					if (e.keyCode === monaco.KeyCode.Escape) {
						try {
							if (typeof caretDocsEnabled !== 'undefined' && caretDocsEnabled === false) {
								docOverlay.hide();
							} else if (docOverlay && typeof docOverlay.showWatermark === 'function') {
								docOverlay.showWatermark();
							}
						} catch (e) { console.error('[kusto]', e); }
					}
				} catch (e) { console.error('[kusto]', e); }
			});
		} catch (e) { console.error('[kusto]', e); }
		let docTimer: any = null;
		const scheduleDocUpdate = () => {
			try {
				if (docTimer) {
					clearTimeout(docTimer);
				}
				docTimer = setTimeout(() => {
					try { docOverlay.update(); } catch (e) { console.error('[kusto]', e); }
				}, 140);
			} catch (e) { console.error('[kusto]', e); }
		};

		editor.onDidChangeCursorPosition(scheduleDocUpdate);
		try { editor.onDidScrollChange(scheduleDocUpdate); } catch (e) { console.error('[kusto]', e); }
		try {
			const model = editor.getModel();
			if (model && model.uri) {
				queryEditorBoxByModelUri[model.uri.toString()] = boxId;
			}
		} catch (e) { console.error('[kusto]', e); }

		const syncPlaceholder = () => {
			if (!placeholder) {
				return;
			}
			updatePlaceholderPosition();
			// Hide placeholder while the editor is focused, even if empty.
			const isFocused = activeQueryEditorBoxId === boxId;
			placeholder.style.display = (!editor.getValue().trim() && !isFocused) ? 'block' : 'none';
		};
		syncPlaceholder();
		editor.onDidChangeModelContent((e: any) => {
			syncPlaceholder();
			scheduleDocUpdate();
			try { retireKustoOptimizeForQueryEdit(boxId); } catch (e) { console.error('[kusto]', e); }
			try {
				if (typeof _win.__kustoOnQueryValueChanged === 'function') {
					_win.__kustoOnQueryValueChanged(boxId, editor.getValue());
				}
			} catch (e) { console.error('[kusto]', e); }
			try {
				__kustoScheduleKustoDiagnostics(boxId, 250);
			} catch (e) { console.error('[kusto]', e); }
			try { schedulePersist(); } catch (e) { console.error('[kusto]', e); }
			// Establish ownership immediately so transient KS207/KS208 markers are filtered,
			// then debounce only network dispatch / worker application.
			try {
				if (__kustoCheckCrossClusterRefs !== null) {
					__kustoSyncSupplementalReferencesForBox(boxId, 'background');
					__kustoScheduleSupplementalPump(CROSS_CLUSTER_SCHEMA_CONTENT_CHECK_DELAY_MS);
					__kustoNoteCrossClusterInteraction(boxId);
					__kustoScheduleCrossClusterRefCheck(editor, boxId, CROSS_CLUSTER_SCHEMA_CONTENT_CHECK_DELAY_MS);
				}
			} catch (e) { console.error('[kusto]', e); }
			try { __kustoMaybeAutoTriggerAutocomplete(editor, boxId, e); } catch (e) { console.error('[kusto]', e); }
			try { updateFunctionDetection(boxId, editor.getValue()); } catch (e) { console.error('[kusto]', e); }
		});
		try {
			__kustoSyncSupplementalReferencesForBox(boxId, 'background');
			__kustoScheduleSupplementalPump(0);
		} catch (e) { console.error('[kusto]', e); }
		editor.onDidFocusEditorText(() => {
			setActiveQueryEditorBoxId(boxId);
			setActiveMonacoEditor(editor);
			try { __kustoLastMonacoInteractionAt = Date.now(); } catch (e) { console.error('[kusto]', e); }
			try { __kustoNoteCrossClusterInteraction(boxId); } catch (e) { console.error('[kusto]', e); }
			try { __kustoForceEditorWritable(editor); } catch (e) { console.error('[kusto]', e); }
			syncPlaceholder();
			ensureSchemaForBox(boxId);
			scheduleDocUpdate();
			// Update monaco-kusto schema if switching to a different cluster/database
			try {
				if (__kustoUpdateSchemaForFocusedBox !== null) {
					__kustoUpdateSchemaForFocusedBox!(boxId);
				}
			} catch (e) { console.error('[kusto]', e); }
			try {
				__kustoScheduleKustoDiagnostics(boxId, 0);
			} catch (e) { console.error('[kusto]', e); }
			// Check for cross-cluster references on focus (in addition to content change),
			// but wait for click/selection activity to settle before starting schema work.
			try {
				if (__kustoCheckCrossClusterRefs !== null) {
					__kustoSyncSupplementalReferencesForBox(boxId, 'background');
					__kustoScheduleCrossClusterRefCheck(editor, boxId, CROSS_CLUSTER_SCHEMA_FOCUS_CHECK_DELAY_MS);
				}
			} catch (e) { console.error('[kusto]', e); }
		});
		// When the suggest widget opens, Monaco may blur the text area while the editor widget
		// still has focus. Track focus at the editor-widget level so our docs widget stays visible.
		try {
			editor.onDidFocusEditorWidget(() => {
				setActiveQueryEditorBoxId(boxId);
				setActiveMonacoEditor(editor);
				try { __kustoLastMonacoInteractionAt = Date.now(); } catch (e) { console.error('[kusto]', e); }
				try { __kustoNoteCrossClusterInteraction(boxId); } catch (e) { console.error('[kusto]', e); }
				try { __kustoForceEditorWritable(editor); } catch (e) { console.error('[kusto]', e); }
				syncPlaceholder();
				scheduleDocUpdate();
			});
			editor.onDidBlurEditorWidget(() => {
				// Some Monaco versions can fire blur(widget) while the suggest widget is opening/closing.
				// Defer and only hide if the editor really isn't focused anymore.
				setTimeout(() => {
					try {
						const stillFocused = isEditorFocused();
						if (!stillFocused) {
							try {
								if (typeof caretDocsEnabled !== 'undefined' && caretDocsEnabled === false) {
									docOverlay.hide();
								}
							} catch (e) { console.error('[kusto]', e); }
							if (activeQueryEditorBoxId === boxId) {
								setActiveQueryEditorBoxId(null);
							}
							syncPlaceholder();
							// Keep existing docs banner content visible while unfocused.
							// (The overlay's update loop also freezes while unfocused.)
							
							// Disable markers (red squiggles) for this editor now that it's unfocused
							try {
								const model = editor.getModel();
								if (model && model.uri && __kustoScheduleDisableMarkersForModel !== null) {
									__kustoScheduleDisableMarkersForModel!(model.uri);
								}
							} catch (e) { console.error('[kusto]', e); }
						}
					} catch (e) { console.error('[kusto]', e); }
				}, 0);
			});
		} catch (e) { console.error('[kusto]', e); }

		// Keep click-to-caret reliable after collapse/expand and page-scroll changes.
		// The guard synchronously lays Monaco out before Monaco maps mouse coordinates,
		// then uses a narrow deferred repair only for simple clicks that Monaco missed.
		const clickFidelityGuard = __kustoInstallEditorClickFidelityGuard({
			boxId,
			editor,
			container,
			wrapper: wrapper as HTMLElement | null,
			activateEditor: () => {
				setActiveQueryEditorBoxId(boxId);
				setActiveMonacoEditor(editor);
			},
			forceWritable: () => __kustoForceEditorWritable(editor),
			setCrossClusterPointerDown: (isPointerDown: boolean) => __kustoSetCrossClusterPointerDown(boxId, isPointerDown),
			scheduleSuggestClamp: () => {
				if (typeof editor.__kustoScheduleSuggestClamp === 'function') {
					editor.__kustoScheduleSuggestClamp();
				}
			},
			logError: (error: unknown) => console.error('[kusto]', error),
		});
		const onCrossClusterPointerUp = () => __kustoSetCrossClusterPointerDown(boxId, false);
		let disposePageScrollRelayout: (() => void) | null = null;
		let pageScrollRelayoutFrame = 0;
		const isEditorConnectedAndMeasurable = () => {
			try {
				const editorDom = typeof editor.getDomNode === 'function' ? editor.getDomNode() : container;
				const measured = (wrapper as HTMLElement | null) || container || editorDom;
				if (!editorDom || !measured || !editorDom.isConnected || !measured.isConnected) {
					return false;
				}
				const editorRect = editorDom.getBoundingClientRect ? editorDom.getBoundingClientRect() : null;
				const measuredRect = measured.getBoundingClientRect ? measured.getBoundingClientRect() : null;
				if (!editorRect || !measuredRect) {
					return false;
				}
				const viewportHeight = Math.max(0, window.innerHeight || document.documentElement?.clientHeight || 0);
				const viewportWidth = Math.max(0, window.innerWidth || document.documentElement?.clientWidth || 0);
				const overscan = 600;
				const nearViewport = !viewportHeight || !viewportWidth
					|| (editorRect.bottom >= -overscan
						&& editorRect.top <= viewportHeight + overscan
						&& editorRect.right >= -overscan
						&& editorRect.left <= viewportWidth + overscan);
				return nearViewport
					&& editorRect.width > 0 && editorRect.height > 0
					&& measuredRect.width > 0 && measuredRect.height > 0;
			} catch {
				return false;
			}
		};
		const runPageScrollRelayout = () => {
			pageScrollRelayoutFrame = 0;
			if (!isEditorConnectedAndMeasurable()) {
				return;
			}
			try { editor.layout(); } catch (e) { console.error('[kusto]', e); }
			try { if (typeof editor.render === 'function') editor.render(true); } catch (e) { console.error('[kusto]', e); }
			try { if (typeof editor.__kustoScheduleSuggestClamp === 'function') editor.__kustoScheduleSuggestClamp(); } catch (e) { console.error('[kusto]', e); }
		};
		const schedulePageScrollRelayout = () => {
			if (pageScrollRelayoutFrame) {
				return;
			}
			try {
				pageScrollRelayoutFrame = requestAnimationFrame(runPageScrollRelayout);
			} catch {
				setTimeout(runPageScrollRelayout, 0);
			}
		};
		try {
			disposePageScrollRelayout = addPageScrollListener(schedulePageScrollRelayout, { passive: true });
		} catch (e) { console.error('[kusto]', e); }
		try {
			editor.onMouseDown(() => __kustoSetCrossClusterPointerDown(boxId, true));
			editor.onMouseMove((event: any) => {
				try {
					const buttons = event?.event?.browserEvent?.buttons;
					if (buttons === 0) {
						__kustoSetCrossClusterPointerDown(boxId, false);
						return;
					}
				} catch (e) { console.error('[kusto]', e); }
				__kustoNoteCrossClusterInteraction(boxId);
			});
			editor.onDidChangeCursorPosition(() => __kustoNoteCrossClusterInteraction(boxId));
			document.addEventListener('mouseup', onCrossClusterPointerUp, true);
			document.addEventListener('pointerup', onCrossClusterPointerUp, true);
			document.addEventListener('pointercancel', onCrossClusterPointerUp, true);
			document.addEventListener('visibilitychange', onCrossClusterPointerUp, true);
			window.addEventListener('blur', onCrossClusterPointerUp, true);
		} catch (e) { console.error('[kusto]', e); }
		try {
			if (typeof editor.onDidDispose === 'function') {
				editor.onDidDispose(() => {
					const disposedModelUri = modelLease.modelUri;
					try { clickFidelityGuard.dispose(); } catch (e) { console.error('[kusto]', e); }
					try { unregisterPendingSchemaSuggestMutation?.(); } catch (e) { console.error('[kusto]', e); }
					unregisterPendingSchemaSuggestMutation = null;
					try { unsubscribeSupplementalPreparation?.(); } catch (e) { console.error('[kusto]', e); }
					unsubscribeSupplementalPreparation = null;
					try { if (pageScrollRelayoutFrame) cancelAnimationFrame(pageScrollRelayoutFrame); } catch (e) { console.error('[kusto]', e); }
					pageScrollRelayoutFrame = 0;
					try { if (disposePageScrollRelayout) disposePageScrollRelayout(); } catch (e) { console.error('[kusto]', e); }
					disposePageScrollRelayout = null;
					kustoEditorSchemaCoordinator.detachModel(modelLease);
					if (disposedModelUri) {
						try { if (queryEditorBoxByModelUri[disposedModelUri] === boxId) delete queryEditorBoxByModelUri[disposedModelUri]; } catch (e) { console.error('[kusto]', e); }
						try { __kustoMarkersEnabledModels.delete(disposedModelUri); } catch (e) { console.error('[kusto]', e); }
						try {
							if (__kustoMarkerBlurClearTimers[disposedModelUri]) clearTimeout(__kustoMarkerBlurClearTimers[disposedModelUri]);
							delete __kustoMarkerBlurClearTimers[disposedModelUri];
						} catch (e) { console.error('[kusto]', e); }
						try { __kustoSchemaTracker.disposeModel(disposedModelUri); } catch (e) { console.error('[kusto]', e); }
						try { delete __kustoMonacoDatabaseInContextByModel[disposedModelUri]; } catch (e) { console.error('[kusto]', e); }
						try { delete __kustoMonacoInitializedByModel[disposedModelUri]; } catch (e) { console.error('[kusto]', e); }
						try { delete __kustoModelClusterMap[disposedModelUri]; } catch (e) { console.error('[kusto]', e); }
						try { __kustoClearAutocompleteTraceForModel(disposedModelUri); } catch (e) { console.error('[kusto]', e); }
						try { __kustoDisposeSupplementalModel(disposedModelUri); } catch (e) { console.error('[kusto]', e); }
					}
					try { if (queryEditors[boxId] === editor) delete queryEditors[boxId]; } catch (e) { console.error('[kusto]', e); }
					__kustoClearCrossClusterCheckTimer(boxId);
					try { __kustoRemoveCrossClusterInterestForBox(boxId); } catch (e) { console.error('[kusto]', e); }
					try { delete __kustoLastCrossClusterInteractionAtByBoxId[boxId]; } catch (e) { console.error('[kusto]', e); }
					try { delete __kustoCrossClusterPointerDownByBoxId[boxId]; } catch (e) { console.error('[kusto]', e); }
					try { invalidateSchemaWorkerReadinessForBox(String(boxId || '')); } catch (e) { console.error('[kusto]', e); }
					try { document.removeEventListener('mouseup', onCrossClusterPointerUp, true); } catch (e) { console.error('[kusto]', e); }
					try { document.removeEventListener('pointerup', onCrossClusterPointerUp, true); } catch (e) { console.error('[kusto]', e); }
					try { document.removeEventListener('pointercancel', onCrossClusterPointerUp, true); } catch (e) { console.error('[kusto]', e); }
					try { document.removeEventListener('visibilitychange', onCrossClusterPointerUp, true); } catch (e) { console.error('[kusto]', e); }
					try { window.removeEventListener('blur', onCrossClusterPointerUp, true); } catch (e) { console.error('[kusto]', e); }
				});
			}
		} catch (e) { console.error('[kusto]', e); }
		const isEditorFocused = () => {
			try {
				const hasWidgetFocus = typeof editor.hasWidgetFocus === 'function' ? editor.hasWidgetFocus() : false;
				const hasTextFocus = typeof editor.hasTextFocus === 'function' ? editor.hasTextFocus() : false;
				return hasWidgetFocus || hasTextFocus;
			} catch {
				return false;
			}
		};

		editor.onDidBlurEditorText(() => {
			syncPlaceholder();
		});

		// Ensure Monaco has a correct initial layout after insertion into the DOM.
		try {
			requestAnimationFrame(() => {
				try { editor.layout(); } catch (e) { console.error('[kusto]', e); }
			});
		} catch (e) { console.error('[kusto]', e); }

		// Kick off missing-cluster detection for the initial value as well.
		try {
			if (typeof _win.__kustoOnQueryValueChanged === 'function') {
				_win.__kustoOnQueryValueChanged(boxId, editor.getValue());
			}
		} catch (e) { console.error('[kusto]', e); }

		// Detect function definitions in the initial editor content.
		try { updateFunctionDetection(boxId, editor.getValue()); } catch (e) { console.error('[kusto]', e); }

		// Note: we intentionally do NOT auto-trigger Monaco suggestions on typing.
		// Users can trigger via Ctrl+Space or the toolbar button.

		// Keep Monaco laid out when the user resizes the wrapper.
		if (wrapper && typeof ResizeObserver !== 'undefined') {
			if (queryEditorResizeObservers[boxId]) {
				try { queryEditorResizeObservers[boxId].disconnect(); } catch (e) { console.error('[kusto]', e); }
			}
			const ro = new ResizeObserver(() => {
				try { editor.layout(); } catch (e) { console.error('[kusto]', e); }
				try { if (typeof editor.__kustoScheduleSuggestClamp === 'function') editor.__kustoScheduleSuggestClamp(); } catch (e) { console.error('[kusto]', e); }
			});
			ro.observe(wrapper);
			queryEditorResizeObservers[boxId] = ro;
		}

		// In multi-editor layouts (e.g. Copilot split panes), editors can be created while hidden.
		// Ensure we relayout when the wrapper becomes visible again so Monaco widgets position correctly.
		try {
			if (typeof queryEditorVisibilityObservers === 'object' && queryEditorVisibilityObservers && queryEditorVisibilityObservers[boxId]) {
				try { queryEditorVisibilityObservers[boxId].disconnect(); } catch (e) { console.error('[kusto]', e); }
				try { delete queryEditorVisibilityObservers[boxId]; } catch (e) { console.error('[kusto]', e); }
			}
		} catch (e) { console.error('[kusto]', e); }
		try {
			if (typeof queryEditorVisibilityMutationObservers === 'object' && queryEditorVisibilityMutationObservers && queryEditorVisibilityMutationObservers[boxId]) {
				try { queryEditorVisibilityMutationObservers[boxId].disconnect(); } catch (e) { console.error('[kusto]', e); }
				try { delete queryEditorVisibilityMutationObservers[boxId]; } catch (e) { console.error('[kusto]', e); }
			}
		} catch (e) { console.error('[kusto]', e); }

		const scheduleRelayoutSoon = () => {
			try {
				requestAnimationFrame(() => {
					try { editor.layout(); } catch (e) { console.error('[kusto]', e); }
					try { if (typeof editor.__kustoScheduleSuggestClamp === 'function') editor.__kustoScheduleSuggestClamp(); } catch (e) { console.error('[kusto]', e); }
				});
			} catch {
				setTimeout(() => {
					try { editor.layout(); } catch (e) { console.error('[kusto]', e); }
					try { if (typeof editor.__kustoScheduleSuggestClamp === 'function') editor.__kustoScheduleSuggestClamp(); } catch (e) { console.error('[kusto]', e); }
				}, 0);
			}
		};

		try {
			const observedEl = wrapper || container;
			if (observedEl && typeof IntersectionObserver !== 'undefined') {
				const io = new IntersectionObserver((entries) => {
					try {
						if (!entries || !entries.length) return;
						for (const e of entries) {
							if (e && e.isIntersecting) {
								scheduleRelayoutSoon();
								break;
							}
						}
					} catch (e) { console.error('[kusto]', e); }
				});
				io.observe(observedEl);
				try { if (typeof queryEditorVisibilityObservers === 'object' && queryEditorVisibilityObservers) queryEditorVisibilityObservers[boxId] = io; } catch (e) { console.error('[kusto]', e); }
			}
		} catch (e) { console.error('[kusto]', e); }

		try {
			if (wrapper && typeof MutationObserver !== 'undefined') {
				const mo = new MutationObserver(() => {
					try {
						// Only relayout if the wrapper is measurable (visible).
						const h = wrapper.getBoundingClientRect ? Math.round(wrapper.getBoundingClientRect().height || 0) : 0;
						if (h > 0) {
							scheduleRelayoutSoon();
						}
					} catch (e) { console.error('[kusto]', e); }
				});
				mo.observe(wrapper, { attributes: true, attributeFilter: ['class', 'style', 'aria-hidden'] });
				try { if (typeof queryEditorVisibilityMutationObservers === 'object' && queryEditorVisibilityMutationObservers) queryEditorVisibilityMutationObservers[boxId] = mo; } catch (e) { console.error('[kusto]', e); }
			}
		} catch (e) { console.error('[kusto]', e); }

		// Initialize toolbar overflow handling (shows "..." button when buttons overflow)
		try {
			initToolbarOverflow(boxId);
		} catch (e) { console.error('[kusto]', e); }

		// Drag handle resize (more reliable than CSS resize in VS Code webviews).
		if (resizer) {
			const resolveWrapperForResize = () => {
				try {
					let w = null;
					try {
						w = (resizer && resizer.closest) ? resizer.closest('.query-editor-wrapper') : null;
					} catch (e) { console.error('[kusto]', e); }
					if (!w) {
						try {
							w = (container && container.closest) ? container.closest('.query-editor-wrapper') : null;
						} catch (e) { console.error('[kusto]', e); }
					}
					if (!w) {
						try {
							const box = document.getElementById(boxId);
							w = (box && box.querySelector) ? box.querySelector('.query-editor-wrapper') : null;
						} catch (e) { console.error('[kusto]', e); }
					}
					return w;
				} catch {
					return null;
				}
			};

			resizer.addEventListener('mousedown', (e) => {
				e.preventDefault();
				e.stopPropagation();

				const w = resolveWrapperForResize();
				if (!w) {
					return;
				}
				try {
					(w as any).dataset.kustoUserResized = 'true';
					try { delete (w as any).dataset.kustoAutoResized; } catch (e) { console.error('[kusto]', e); }
				} catch (e) { console.error('[kusto]', e); }
				try {
					if (!pState.manualQueryEditorHeightPxByBoxId || typeof pState.manualQueryEditorHeightPxByBoxId !== 'object') {
						pState.manualQueryEditorHeightPxByBoxId = {};
					}
				} catch (e) { console.error('[kusto]', e); }

				resizer.classList.add('is-dragging');
				const previousCursor = document.body.style.cursor;
				const previousUserSelect = document.body.style.userSelect;
				document.body.style.cursor = 'ns-resize';
				document.body.style.userSelect = 'none';

				const startPageY = e.clientY + getScrollY();
				const startHeight = w.getBoundingClientRect().height;

				// monaco-editor-max-height: 750px. Manual drag cannot exceed it.
				const maxEditorH = 750;

				const onMove = (moveEvent: any) => {
					try {
						maybeAutoScrollWhileDragging(moveEvent.clientY);
					} catch (e) { console.error('[kusto]', e); }
					const pageY = moveEvent.clientY + getScrollY();
					const delta = pageY - startPageY;
					// Use a larger min-height when the Copilot chat is visible.
					let minHeightPx = 120;
					try {
						const split = w.querySelector('.kusto-copilot-split');
						if (split && !split.classList.contains('kusto-copilot-chat-hidden')) {
							minHeightPx = 180;
						}
					} catch (e) { console.error('[kusto]', e); }
					// Cap at monaco-editor-max-height (content height + chrome).
					const nextHeight = Math.max(minHeightPx, Math.min(maxEditorH, startHeight + delta));
					(w as any).style.height = nextHeight + 'px';
					try {
						if (pState.manualQueryEditorHeightPxByBoxId && typeof pState.manualQueryEditorHeightPxByBoxId === 'object') {
							pState.manualQueryEditorHeightPxByBoxId[boxId] = Math.round(nextHeight);
						}
					} catch (e) { console.error('[kusto]', e); }
					try { editor.layout(); } catch (e) { console.error('[kusto]', e); }
				};
				const onUp = () => {
					document.removeEventListener('mousemove', onMove, true);
					document.removeEventListener('mouseup', onUp, true);
					resizer.classList.remove('is-dragging');
					document.body.style.cursor = previousCursor;
					document.body.style.userSelect = previousUserSelect;
					try { schedulePersist(); } catch (e) { console.error('[kusto]', e); }
				};

				document.addEventListener('mousemove', onMove, true);
				document.addEventListener('mouseup', onUp, true);
			});

			// Double-click to fit editor to contents - delegate to the button's function
			// which already handles measurement with proper retries for async layout settling.
			resizer.addEventListener('dblclick', (e) => {
				try {
					e.preventDefault();
					e.stopPropagation();
					__kustoAutoSizeEditor(boxId, schedulePersist);
				} catch (e) { console.error('[kusto]', e); }
			});
		}
	}).catch((e: any) => {
		// If Monaco fails to initialize transiently, retry a few times so the editor
		// doesn't get stuck in a non-interactive placeholder state until reopen.
		try {
			if (queryEditors && queryEditors[boxId]) {
				return;
			}
		} catch (e) { console.error('[kusto]', e); }

		let attempt = 0;
		try {
			attempt = (__kustoMonacoInitRetryCountByBoxId[boxId] || 0) + 1;
			__kustoMonacoInitRetryCountByBoxId[boxId] = attempt;
		} catch {
			attempt = 1;
		}

		const delays = [50, 250, 1000, 2000, 4000];
		const delay = delays[Math.min(attempt - 1, delays.length - 1)];
		if (attempt > delays.length) {
			try { console.error('Monaco init failed (query editor).', e); } catch (e) { console.error('[kusto]', e); }
			return;
		}
		try {
			if (__kustoMonacoInitRetryTimerByBoxId[boxId] !== undefined) clearTimeout(__kustoMonacoInitRetryTimerByBoxId[boxId]);
			__kustoMonacoInitRetryTimerByBoxId[boxId] = setTimeout(() => {
				delete __kustoMonacoInitRetryTimerByBoxId[boxId];
				if (!expectedSectionElement || document.getElementById(String(boxId || '')) !== expectedSectionElement) {
					__kustoCancelMonacoInitRetry(String(boxId || ''));
					return;
				}
				try { initQueryEditor(boxId); } catch (e) { console.error('[kusto]', e); }
			}, delay);
		} catch (e) { console.error('[kusto]', e); }
	});
}

// ── Custom context menu for Monaco editors ──
// Monaco's built-in context menu is disabled (contextmenu: false) because most of its items
// (Go to Definition, Format, etc.) have no providers in this webview.
// This custom menu provides the clipboard and selection actions that actually work.

let __kustoEditorContextMenuEl: HTMLElement | null = null;
let __kustoEditorContextMenuCleanup: (() => void) | null = null;

function __kustoHideEditorContextMenu() {
	try {
		if (__kustoEditorContextMenuCleanup) {
			__kustoEditorContextMenuCleanup();
			__kustoEditorContextMenuCleanup = null;
		}
		if (__kustoEditorContextMenuEl) {
			__kustoEditorContextMenuEl.remove();
			__kustoEditorContextMenuEl = null;
		}
	} catch (e) { console.error('[kusto]', e); }
}

function __kustoShowEditorContextMenu(editor: any, event: MouseEvent) {
	__kustoHideEditorContextMenu();
	// Also hide any results-table context menu that might be open.
	try { if (typeof _win.__kustoHideContextMenu === 'function') _win.__kustoHideContextMenu(); } catch (e) { /* ignore */ }

	const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
	const mod = isMac ? '\u2318' : 'Ctrl';

	const hasSelection = (() => {
		try {
			const sel = editor.getSelection();
			return sel && (sel.startLineNumber !== sel.endLineNumber || sel.startColumn !== sel.endColumn);
		} catch { return false; }
	})();

	const isReadOnly = (() => {
		try {
			const opts = editor.getOptions();
			// readOnly option id is 90 in monaco 0.52; fall back to getRawOptions
			try {
				const raw = editor.getRawOptions();
				return !!raw.readOnly;
			} catch { return false; }
		} catch { return false; }
	})();

	type MenuItem = { label: string; shortcut: string; action: () => void; disabled?: boolean } | { separator: true };
	const items: MenuItem[] = [];

	if (!isReadOnly) {
		items.push({ label: 'Cut', shortcut: `${mod}+X`, action: () => { _win.__kustoCopyOrCutMonacoEditor?.(editor, true); }, disabled: !hasSelection });
	}
	items.push({ label: 'Copy', shortcut: `${mod}+C`, action: () => { _win.__kustoCopyOrCutMonacoEditor?.(editor, false); }, disabled: !hasSelection });
	if (!isReadOnly) {
		items.push({
			label: 'Paste', shortcut: `${mod}+V`, action: async () => {
				try {
					const text = await navigator.clipboard.readText();
					if (typeof text === 'string') {
						const selection = editor.getSelection();
						if (selection) {
							editor.executeEdits('clipboard', [{ range: selection, text }]);
							editor.focus();
						}
					}
				} catch (e) { console.error('[kusto]', e); }
			}
		});
	}
	if (!isReadOnly) {
		items.push({ separator: true });
		items.push({ label: 'Undo', shortcut: `${mod}+Z`, action: () => { try { editor.trigger('contextMenu', 'undo', null); } catch (e) { console.error('[kusto]', e); } } });
		items.push({ label: 'Redo', shortcut: `${mod}+Y`, action: () => { try { editor.trigger('contextMenu', 'redo', null); } catch (e) { console.error('[kusto]', e); } } });
	}
	items.push({ separator: true });
	if (!isReadOnly) {
		items.push({ label: 'Toggle Comment', shortcut: `${mod}+/`, action: () => { try { editor.trigger('contextMenu', 'editor.action.commentLine', null); } catch (e) { console.error('[kusto]', e); } } });
		items.push({ label: 'Rename', shortcut: 'F2', action: () => { try { editor.trigger('contextMenu', 'editor.action.rename', null); } catch (e) { console.error('[kusto]', e); } } });
	}
	items.push({ label: 'Select All', shortcut: `${mod}+A`, action: () => { try { editor.trigger('contextMenu', 'editor.action.selectAll', null); } catch (e) { console.error('[kusto]', e); } } });

	const menu = document.createElement('div');
	menu.className = 'kusto-context-menu';
	menu.setAttribute('role', 'menu');

	for (const item of items) {
		if ('separator' in item) {
			const sep = document.createElement('div');
			sep.className = 'kusto-context-menu-separator';
			menu.appendChild(sep);
			continue;
		}
		const btn = document.createElement('button');
		btn.type = 'button';
		btn.className = 'kusto-context-menu-item';
		btn.setAttribute('role', 'menuitem');
		if (item.disabled) {
			btn.disabled = true;
			btn.classList.add('disabled');
		}

		const labelSpan = document.createElement('span');
		labelSpan.textContent = item.label;
		btn.appendChild(labelSpan);

		const shortcutSpan = document.createElement('span');
		shortcutSpan.className = 'kusto-context-menu-shortcut';
		shortcutSpan.textContent = item.shortcut;
		btn.appendChild(shortcutSpan);

		const action = item.action;
		btn.addEventListener('click', (e) => {
			e.preventDefault();
			e.stopPropagation();
			__kustoHideEditorContextMenu();
			action();
		});
		menu.appendChild(btn);
	}

	document.body.appendChild(menu);
	__kustoEditorContextMenuEl = menu;

	// Position from viewport coordinates. The notebook page uses an overlay scroll
	// element, so pageX/pageY can disagree with fixed/body overlays after scroll.
	const menuRect = menu.getBoundingClientRect();
	let left = event.clientX;
	let top = event.clientY;
	if (left + menuRect.width > window.innerWidth) {
		left = Math.max(0, window.innerWidth - menuRect.width - 4);
	}
	if (top + menuRect.height > window.innerHeight) {
		top = Math.max(0, window.innerHeight - menuRect.height - 4);
	}
	menu.style.left = left + 'px';
	menu.style.top = top + 'px';

	// Dismiss on outside click or scroll.
	const onDismiss = (e: Event) => {
		try {
			if (menu.contains(e.target as Node)) return;
			__kustoHideEditorContextMenu();
		} catch { __kustoHideEditorContextMenu(); }
	};
	const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') __kustoHideEditorContextMenu(); };
	let removeScrollListener: (() => void) | null = null;

	setTimeout(() => {
		document.addEventListener('mousedown', onDismiss, true);
		removeScrollListener = registerPageScrollDismissable(() => __kustoHideEditorContextMenu(), { mode: 'ephemeral', dismissOnWheel: true });
		document.addEventListener('keydown', onKeyDown, true);
	}, 0);

	__kustoEditorContextMenuCleanup = () => {
		document.removeEventListener('mousedown', onDismiss, true);
		if (removeScrollListener) {
			removeScrollListener();
			removeScrollListener = null;
		}
		document.removeEventListener('keydown', onKeyDown, true);
	};
}

// ── Window bridges for remaining legacy callers ──
window.__kustoGetColumnsByTable = __kustoGetColumnsByTable;
window.ensureMonaco = ensureMonaco as any;
window.initQueryEditor = initQueryEditor;
window.__kustoGetAutocompleteTrace = getAutocompleteTrace as any;
window.__kustoClearAutocompleteTrace = clearAutocompleteTrace as any;
window.__kustoCompactAutocompleteTrace = compactAutocompleteTrace as any;
Object.defineProperty(window, '__kustoLastAutocompleteTraceId', { get: () => getLastAutocompleteTraceId(), configurable: true });

// ── Deferred window bridges ──────────────────────────────────────────────────
// These module-level lets are populated inside the ensureMonaco().then() callback.
// External modules access them via window.__kustoXxx; the bridge is set via
// Object.defineProperty so it always reads the current value of the module-level let.
Object.defineProperty(window, '__kustoTriggerRevalidation', { get: () => __kustoTriggerRevalidation, configurable: true });
Object.defineProperty(window, '__kustoGetCrossClusterTrace', { get: () => __kustoGetCrossClusterTrace, configurable: true });
Object.defineProperty(window, '__kustoClearCrossClusterTrace', { get: () => __kustoClearCrossClusterTrace, configurable: true });
Object.defineProperty(window, '__kustoGetStatementBlocksFromModel', { get: () => __kustoGetStatementBlocksFromModel, configurable: true });
Object.defineProperty(window, '__kustoExtractStatementTextAtCursor', { get: () => __kustoExtractStatementTextAtCursor, configurable: true });
