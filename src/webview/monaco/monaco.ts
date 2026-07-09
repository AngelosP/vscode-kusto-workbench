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
} from './writable';
import {
	__kustoIsElementVisibleForSuggest,
	__kustoGetWordNearCursor,
	__kustoFindSuggestWidgetForEditor,
	__kustoRegisterGlobalSuggestMutationHandler,
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
import { __kustoAttachAutoResizeToContent } from './resize';
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
import { __kustoAutoSizeEditor, ensureSchemaForBox, __kustoGetConnectionId, __kustoGetClusterUrl, __kustoGetDatabase } from '../core/section-factory';
import { executeQuery } from '../sections/query-execution.controller';
import { initToolbarOverflow } from '../sections/kw-query-toolbar';
import { postMessageToHost } from '../shared/webview-messages';
import { createMonacoCursorStatusPublisher } from '../shared/editor-cursor-status';
import { decideSchemaOperation } from '../shared/schema-decision';
import { SchemaTracker } from '../shared/schema-tracker';
import { extractCrossClusterRefs, getCrossClusterSchemaCheckDelay } from '../shared/cross-cluster-schema';
import { buildKustoFunctionBodyFromOutputColumns, ensureKustoFunctionBodiesForSchema } from '../shared/kusto-function-output-schema';
import { kustoClusterKey, kustoDatabaseKey } from '../../shared/kustoClusterUrls.js';
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
	queryEditorBoxByModelUri,
	schemaByBoxId,
	schemaDiagnosticsTrustedByBoxId,
	schemaMetaByBoxId,
	schemaWorkerReadyByBoxId,
	schemaWorkerReadyWaitersByBoxId,
	pendingSchemaWorkerUpdateByBoxId,
	markSchemaWorkerApplyFailed,
	markSchemaWorkerApplyPending,
	markSchemaWorkerReady,
	waitForSchemaWorkerReady,
	isSchemaWorkerReady,
	copilotInlineCompletionRequests,
	queryEditorResizeObservers,
	queryEditorVisibilityObservers,
	queryEditorVisibilityMutationObservers,
	caretDocOverlaysByBoxId,
} from '../core/state';

// ── Schema state singleton (the ONLY source of truth for schema tracking) ───
export const __kustoSchemaTracker = new SchemaTracker();

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

function __kustoGetSchemaContextForBox(boxId: string): { connectionId: string; database: string; clusterUrl: string; schemaKey: string } | null {
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
		if (!clusterUrl) {
			return null;
		}
		return { connectionId, database, clusterUrl, schemaKey: kustoDatabaseKey(clusterUrl, database) };
	} catch {
		return null;
	}
}

async function __kustoFlushPendingSchemaWorkerUpdateForBox(boxId: string): Promise<boolean> {
	try {
		const pending = pendingSchemaWorkerUpdateByBoxId[boxId];
		if (!pending || !pending.rawSchemaJson) {
			return false;
		}
		const currentContext = __kustoGetSchemaContextForBox(boxId);
		if (!currentContext || pending.schemaKey !== currentContext.schemaKey) {
			try { delete pendingSchemaWorkerUpdateByBoxId[boxId]; } catch (e) { console.error('[kusto]', e); }
			return false;
		}
		const editor = queryEditors ? queryEditors[boxId] : null;
		const model = editor && typeof editor.getModel === 'function' ? editor.getModel() : null;
		const modelUri = model && model.uri ? model.uri.toString() : '';
		if (!modelUri || typeof _win.__kustoSetMonacoKustoSchema !== 'function') {
			return false;
		}
		markSchemaWorkerApplyPending(boxId, pending.schemaKey, pending.schemaSignature);
		const applied = await _win.__kustoSetMonacoKustoSchema(
			pending.rawSchemaJson,
			pending.clusterUrl,
			pending.database,
			true,
			modelUri,
			!!pending.forceRefresh
		);
		if (!applied) {
			markSchemaWorkerApplyFailed(boxId, pending.schemaKey);
			return false;
		}
		try { if (typeof __kustoTriggerRevalidation === 'function') __kustoTriggerRevalidation(boxId); } catch (e) { console.error('[kusto]', e); }
		markSchemaWorkerReady(boxId, pending.schemaKey, pending.schemaSignature);
		try { delete pendingSchemaWorkerUpdateByBoxId[boxId]; } catch (e) { console.error('[kusto]', e); }
		return true;
	} catch (error) {
		console.error('[monaco-kusto] Failed to flush pending schema update:', error);
		try {
			const pending = pendingSchemaWorkerUpdateByBoxId[boxId];
			markSchemaWorkerApplyFailed(boxId, pending?.schemaKey);
		} catch (e) { console.error('[kusto]', e); }
		return false;
	}
}

async function __kustoPrepareSchemaForAutocomplete(ed: any, traceId?: string): Promise<'ready' | 'blocked'> {
	try {
		try { if (ed) ed.__kustoAutocompleteRetryQueuedForSchema = false; } catch (e) { console.error('[kusto]', e); }
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
				const keys: string[] = [];
				for (const ref of refs) {
					const clusterName = String(ref?.clusterName || '').trim();
					const database = String(ref?.database || '').trim();
					const key = __kustoGetCrossClusterSchemaKey(clusterName, database);
					if (!key || keys.includes(key)) continue;
					keys.push(key);
					if (!__kustoIsCrossClusterSchemaLoadedForModel(key, modelUri)) {
						const loadedEntry = __kustoCrossClusterSchemas?.[key];
						if (__kustoIsCrossClusterSchemaLoaded(key) && loadedEntry?.rawSchemaJson && typeof _win.__kustoApplyCrossClusterSchema === 'function') {
							void _win.__kustoApplyCrossClusterSchema(clusterName, loadedEntry.clusterUrl || clusterName, database, loadedEntry.rawSchemaJson, boxId, 'autocomplete-no-context-reapply');
						} else if (typeof __kustoRequestCrossClusterSchema === 'function') {
							__kustoRequestCrossClusterSchema(clusterName, database, boxId);
						}
					}
				}
				const missingKeys = keys.filter(key => !__kustoIsCrossClusterSchemaLoadedForModel(key, modelUri));
				recordAutocompleteTrace(traceId, 'schema-prepare-no-context-refs', { boxId, keys, missingKeys });
				if (missingKeys.length) {
					const ready = await Promise.all(missingKeys.map(key => __kustoWaitForCrossClusterSchemaReadyForModel(key, modelUri, CROSS_CLUSTER_SCHEMA_AUTOCOMPLETE_WAIT_MS)));
					recordAutocompleteTrace(traceId, 'schema-prepare-no-context-cross-cluster-wait', { boxId, missingKeys, results: ready });
					if (!ready.every(Boolean)) return 'blocked';
				}
			}
			return 'ready';
		}
		recordAutocompleteTrace(traceId, 'schema-prepare-context', { boxId, ...context });

		await __kustoFlushPendingSchemaWorkerUpdateForBox(boxId);

		const schema = schemaByBoxId ? schemaByBoxId[boxId] : null;
		const rawSchemaJson = schema && schema.rawSchemaJson ? schema.rawSchemaJson : null;
		if (!rawSchemaJson) {
			recordAutocompleteTrace(traceId, 'schema-prepare-no-raw-schema', { boxId, hasSchema: !!schema, tables: Array.isArray(schema?.tables) ? schema.tables.length : undefined });
			if (typeof ensureSchemaForBox === 'function') {
				ensureSchemaForBox(boxId, false);
			}
			__kustoQueueAutocompleteRetryForPrimarySchema(ed, boxId, context.schemaKey);
			return 'blocked';
		}

		if (!isSchemaWorkerReady(boxId, context.schemaKey)) {
			if (typeof __kustoUpdateSchemaForFocusedBox === 'function') {
				try { void __kustoUpdateSchemaForFocusedBox(boxId, false); } catch (e) { console.error('[kusto]', e); }
			}
			const primaryReady = await waitForSchemaWorkerReady(boxId, context.schemaKey, CROSS_CLUSTER_SCHEMA_AUTOCOMPLETE_WAIT_MS);
			recordAutocompleteTrace(traceId, 'schema-prepare-primary-wait', { boxId, schemaKey: context.schemaKey, ready: primaryReady });
			__kustoTraceCrossCluster('autocomplete-primary-wait-finished', { boxId, schemaKey: context.schemaKey, ready: primaryReady });
			if (!primaryReady) {
				__kustoQueueAutocompleteRetryForPrimarySchema(ed, boxId, context.schemaKey);
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
		for (const ref of refs) {
			try {
				const clusterName = __kustoResolveCrossClusterNameForRef(ref, boxId, context);
				const database = String(ref?.database || '').trim();
				const key = __kustoGetCrossClusterSchemaKey(clusterName, database);
				if (!key || keys.includes(key)) {
					continue;
				}
				keys.push(key);
				if (!__kustoIsCrossClusterSchemaLoadedForModel(key, modelUri)) {
					__kustoMarkCrossClusterAutocompleteDemand(key);
					const loadedEntry = __kustoCrossClusterSchemas?.[key];
					if (__kustoIsCrossClusterSchemaLoaded(key) && loadedEntry?.rawSchemaJson && typeof _win.__kustoApplyCrossClusterSchema === 'function') {
						void _win.__kustoApplyCrossClusterSchema(clusterName, loadedEntry.clusterUrl || clusterName, database, loadedEntry.rawSchemaJson, boxId, 'autocomplete-reapply');
					} else if (typeof __kustoRequestCrossClusterSchema === 'function') {
						__kustoRequestCrossClusterSchema(ref.clusterName, database, boxId);
					}
				}
			} catch (e) { console.error('[kusto]', e); }
		}

		const missingKeys = keys.filter(key => !__kustoIsCrossClusterSchemaLoadedForModel(key, modelUri));
		recordAutocompleteTrace(traceId, 'schema-prepare-keys', { boxId, modelUri, keys, missingKeys });
		__kustoTraceCrossCluster('autocomplete-prepare-keys', { boxId, modelUri, keys, missingKeys });
		if (missingKeys.length === 0) {
			return 'ready';
		}

		const quickReadyResults = await Promise.all(missingKeys.map(key => __kustoWaitForCrossClusterSchemaReadyForModel(key, modelUri, CROSS_CLUSTER_SCHEMA_AUTOCOMPLETE_WAIT_MS)));
		recordAutocompleteTrace(traceId, 'schema-prepare-cross-cluster-wait', { boxId, missingKeys, results: quickReadyResults });
		__kustoTraceCrossCluster('autocomplete-short-wait-finished', { boxId, missingKeys, results: quickReadyResults });
		if (quickReadyResults.every(Boolean)) {
			return 'ready';
		}

		try {
			if (!ed.__kustoRetrySuggestWhenCrossClusterSchemaReady) {
				__kustoTraceCrossCluster('autocomplete-retry-wait-start', { boxId, missingKeys });
				ed.__kustoAutocompleteRetryQueuedForSchema = true;
				ed.__kustoRetrySuggestWhenCrossClusterSchemaReady = true;
				Promise.all(missingKeys.map(key => __kustoWaitForCrossClusterSchemaReadyForModel(key, modelUri, CROSS_CLUSTER_SCHEMA_AUTOCOMPLETE_RETRY_WAIT_MS))).then((results: boolean[]) => {
					try {
						ed.__kustoAutocompleteRetryQueuedForSchema = false;
						ed.__kustoRetrySuggestWhenCrossClusterSchemaReady = false;
						__kustoTraceCrossCluster('autocomplete-retry-wait-finished', { boxId, missingKeys, results, hasTextFocus: typeof ed.hasTextFocus === 'function' ? ed.hasTextFocus() : null, hasWidgetFocus: typeof ed.hasWidgetFocus === 'function' ? ed.hasWidgetFocus() : null });
						if (!results.every(Boolean)) return;
						const hasFocus = (typeof ed.hasTextFocus === 'function' && ed.hasTextFocus()) || (typeof ed.hasWidgetFocus === 'function' && ed.hasWidgetFocus());
						if (!hasFocus) {
							__kustoTraceCrossCluster('autocomplete-retry-skipped-no-focus', { boxId, missingKeys });
							return;
						}
						if (typeof _win.__kustoTriggerAutocompleteForBoxId === 'function') {
							__kustoTraceCrossCluster('autocomplete-retry-trigger', { boxId, missingKeys });
							void _win.__kustoTriggerAutocompleteForBoxId(boxId);
						}
					} catch (e) { console.error('[kusto]', e); }
				}).catch((e: any) => {
					try { ed.__kustoAutocompleteRetryQueuedForSchema = false; } catch (inner) { console.error('[kusto]', inner); }
					try { ed.__kustoRetrySuggestWhenCrossClusterSchemaReady = false; } catch (inner) { console.error('[kusto]', inner); }
					console.error('[kusto]', e);
				});
			} else {
				__kustoTraceCrossCluster('autocomplete-retry-already-waiting', { boxId, missingKeys });
				ed.__kustoAutocompleteRetryQueuedForSchema = true;
			}
		} catch (e) { console.error('[kusto]', e); }
		return 'ready';
	} catch (error) {
		console.error('[monaco-kusto] Failed to prepare schema for autocomplete:', error);
		return 'ready';
	}
}

function __kustoExtractAutocompleteSchemaScopeText(ed: any): string {
	try {
		const model = ed && typeof ed.getModel === 'function' ? ed.getModel() : null;
		const pos = ed && typeof ed.getPosition === 'function' ? ed.getPosition() : null;
		const fullText = model && typeof model.getValue === 'function' ? String(model.getValue() || '') : '';
		if (model && pos && fullText) {
			const offset = typeof model.getOffsetAt === 'function'
				? model.getOffsetAt(pos)
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
let __kustoSchemaOperationQueue: Promise<any> = Promise.resolve();
let __kustoSetMonacoKustoSchemaInternal: ((...args: any[]) => Promise<any>) | null = null;
let __kustoSetDatabaseInContext: ((...args: any[]) => Promise<boolean>) | null = null;
export let __kustoUpdateSchemaForFocusedBox: ((...args: any[]) => Promise<void>) | null = null;
let __kustoEnableMarkersForBox: ((boxId: any) => void) | null = null;
let __kustoTriggerRevalidation: ((boxId: any) => void) | null = null;
let __kustoExtractCrossClusterRefs: ((queryText: any, currentContext?: any) => any[]) | null = null;
let __kustoRequestCrossClusterSchema: ((clusterName: any, database: any, boxId: any) => void) | null = null;
let __kustoApplyCrossClusterSchemaInternal: ((...args: any[]) => Promise<void>) | null = null;
let __kustoCheckCrossClusterRefs: ((queryText: any, boxId: any) => void) | null = null;
let __kustoTriggerAutocompleteInternal: ((ed: any) => Promise<boolean>) | null = null;
let __kustoFocusInProgress: string | null = null;
const __kustoFocusUpdateRerunByBoxId: Record<string, boolean> = {};
let __kustoStatementSeparatorMinBlankLines = 1;
let __kustoGetStatementBlocksFromModel: ((model: any) => any[]) | null = null;
let __kustoIsSeparatorBlankLine: ((model: any, lineNumber: any) => boolean) | null = null;
let __kustoExtractStatementTextAtCursor: ((editor: any) => string | null) | null = null;
const KUSTO_MARKER_BLUR_CLEAR_DELAY_MS = 150;
const __kustoMarkerBlurClearTimers: Record<string, any> = {};

// Exported module-level lets for cross-module ES imports (lazily assigned inside require callback).
export let __kustoAutoFindInQueryEditor: ((boxId: any, term: any) => Promise<boolean>) | null = null;
let __kustoAutoFindStateByBoxId: Record<string, any> = {};

// Module-level state variables — converted from _win.__kusto* window bridges.
// Group A: Internal state (only used within monaco.ts)
let __kustoMarkersEnabledModels: Set<string> = new Set();
let __kustoModelClusterMap: Record<string, string> = {};
let __kustoMonacoDatabaseInContextByModel: Record<string, { clusterUrl: string; database: string } | null> = {};
let __kustoMonacoInitializedByModel: Record<string, boolean> = {};
const __kustoAutocompleteTraceByModelUri: Record<string, string> = {};

function __kustoQueueAutocompleteRetryForPrimarySchema(ed: any, boxId: string, schemaKey: string): void {
	try {
		if (!ed || !boxId || !schemaKey || ed.__kustoRetrySuggestWhenPrimarySchemaReady) return;
		ed.__kustoAutocompleteRetryQueuedForSchema = true;
		ed.__kustoRetrySuggestWhenPrimarySchemaReady = true;
		void waitForSchemaWorkerReady(boxId, schemaKey, CROSS_CLUSTER_SCHEMA_AUTOCOMPLETE_RETRY_WAIT_MS).then((ready: boolean) => {
			try {
				ed.__kustoAutocompleteRetryQueuedForSchema = false;
				ed.__kustoRetrySuggestWhenPrimarySchemaReady = false;
				if (!ready) return;
				const hasFocus = (typeof ed.hasTextFocus === 'function' && ed.hasTextFocus()) || (typeof ed.hasWidgetFocus === 'function' && ed.hasWidgetFocus());
				if (!hasFocus) return;
				if (typeof __kustoTriggerAutocompleteInternal === 'function') {
					void __kustoTriggerAutocompleteInternal(ed);
				}
			} catch (e) { console.error('[kusto]', e); }
		}).catch((e: any) => {
			try { ed.__kustoAutocompleteRetryQueuedForSchema = false; } catch (inner) { console.error('[kusto]', inner); }
			try { ed.__kustoRetrySuggestWhenPrimarySchemaReady = false; } catch (inner) { console.error('[kusto]', inner); }
			console.error('[kusto]', e);
		});
	} catch (e) { console.error('[kusto]', e); }
}

function __kustoGetAutocompleteTraceIdForModel(modelUri: any): string {
	const modelKey = String(modelUri || '');
	const traceId = modelKey ? __kustoAutocompleteTraceByModelUri[modelKey] : '';
	return traceId || getActiveAutocompleteTraceId();
}

function __kustoColumnNamesFromSchemaEntity(entity: any): string[] {
	try {
		const source = entity?.OrderedColumns || entity?.orderedColumns || entity?.Columns || entity?.columns || entity?.OutputColumns || entity?.outputColumns || {};
		if (Array.isArray(source)) {
			return source.map((column: any, index: number) => {
				if (Array.isArray(column)) return String(column[0] || column[1]?.Name || column[1]?.name || `Column${index + 1}`);
				if (typeof column === 'string') return column;
				return String(column?.Name || column?.name || column?.ColumnName || column?.columnName || `Column${index + 1}`);
			}).filter(Boolean);
		}
		if (typeof source === 'string') {
			return source.split(',').map(part => part.trim().split(':')[0]?.trim()).filter(Boolean);
		}
		return Object.entries(source).map(([name, column]: [string, any]) => String(column?.Name || column?.name || column?.ColumnName || column?.columnName || name)).filter(Boolean);
	} catch {
		return [];
	}
}

function __kustoResolveRawSchemaEntityColumns(rawSchemaJson: any, database: string, entityName: string): string[] {
	try {
		const dbs = rawSchemaJson?.Databases || {};
		const dbEntry = dbs[database]
			|| Object.entries(dbs).find(([name]) => String(name).toLowerCase() === String(database).toLowerCase())?.[1]
			|| Object.values(dbs)[0];
		if (!dbEntry) return [];
		const nameLower = String(entityName || '').toLowerCase();
		const containers = [dbEntry.Tables, dbEntry.MaterializedViews, dbEntry.ExternalTables, dbEntry.Functions];
		for (const container of containers) {
			if (!container || typeof container !== 'object') continue;
			const entry = container[entityName]
				|| Object.entries(container).find(([name, value]: [string, any]) => String(name).toLowerCase() === nameLower || String(value?.Name || '').toLowerCase() === nameLower)?.[1];
			const columns = __kustoColumnNamesFromSchemaEntity(entry);
			if (columns.length) return columns;
		}
	} catch (e) { console.error('[kusto]', e); }
	return [];
}

function __kustoFindRawSchemaEntity(rawSchemaJson: any, database: string, entityName: string): any {
	try {
		const dbs = rawSchemaJson?.Databases || {};
		const dbEntry = dbs[database]
			|| Object.entries(dbs).find(([name]) => String(name).toLowerCase() === String(database).toLowerCase())?.[1]
			|| Object.values(dbs)[0];
		if (!dbEntry) return null;
		const nameLower = String(entityName || '').toLowerCase();
		const containers = [dbEntry.Tables, dbEntry.MaterializedViews, dbEntry.ExternalTables, dbEntry.Functions];
		for (const container of containers) {
			if (!container || typeof container !== 'object') continue;
			const entry = container[entityName]
				|| Object.entries(container).find(([name, value]: [string, any]) => String(name).toLowerCase() === nameLower || String(value?.Name || '').toLowerCase() === nameLower)?.[1];
			if (entry) return entry;
		}
	} catch (e) { console.error('[kusto]', e); }
	return null;
}

function __kustoResolveRawSchemaEntityColumnsDeep(rawSchemaJson: any, database: string, entityName: string, seen: Set<string> = new Set()): string[] {
	try {
		const key = `${String(database || '').toLowerCase()}|${String(entityName || '').toLowerCase()}`;
		if (!entityName || seen.has(key)) return [];
		seen.add(key);
		const direct = __kustoResolveRawSchemaEntityColumns(rawSchemaJson, database, entityName);
		if (direct.length) return direct;
		const entity = __kustoFindRawSchemaEntity(rawSchemaJson, database, entityName);
		return __kustoInferRawFunctionBodyColumns(rawSchemaJson, database, entity?.Body || entity?.body || '', seen);
	} catch (e) { console.error('[kusto]', e); }
	return [];
}

function __kustoInferRawFunctionBodyColumns(rawSchemaJson: any, database: string, body: any, seen: Set<string> = new Set()): string[] {
	try {
		const text = String(body || '').replace(/^\s*\{/, '').replace(/\}\s*$/, '').trim();
		if (/^union\b/i.test(text)) {
			const set = new Set<string>();
			const unionBody = text
				.replace(/^union\b/i, ' ')
				.replace(/\b(kind|isfuzzy|withsource)\s*=\s*("[^"]*"|'[^']*'|[^\s,|)]+)/ig, ' ');
			for (const match of unionBody.matchAll(/(?:cluster\s*\(\s*(['"])(.*?)\1\s*\)\s*\.\s*)?(?:database\s*\(\s*(['"])(.*?)\3\s*\)\s*\.\s*)?([A-Za-z_][\w-]*)\s*(?:\(\s*\))?/gi)) {
				const name = match[5];
				if (!name || /^(union|kind|isfuzzy|withsource|true|false)$/i.test(name)) continue;
				for (const column of __kustoResolveRawSchemaEntityColumnsDeep(rawSchemaJson, match[4] || database, name, new Set(seen))) {
					set.add(column);
				}
			}
			if (set.size) return Array.from(set);
		}
		const sourceMatch = text.match(/(?:cluster\s*\(\s*(['"])(.*?)\1\s*\)\s*\.\s*)?(?:database\s*\(\s*(['"])(.*?)\3\s*\)\s*\.\s*)?([A-Za-z_][\w-]*)\s*(?:\(\s*\))?/i);
		if (!sourceMatch) return [];
		let columns = __kustoResolveRawSchemaEntityColumnsDeep(rawSchemaJson, sourceMatch[4] || database, sourceMatch[5], new Set(seen));
		if (!columns.length) return [];
		const stages = text.split('|').slice(1).map(stage => stage.trim()).filter(Boolean);
		for (const stage of stages) {
			if (/^(where|filter|take|limit|top|order\s+by|sort\s+by)\b/i.test(stage)) continue;
			if (/^project-away\b/i.test(stage)) {
				const remove = new Set((stage.replace(/^project-away\b/i, '').match(/[A-Za-z_][\w-]*/g) || []).map(name => name.toLowerCase()));
				columns = columns.filter(column => !remove.has(column.toLowerCase()));
				continue;
			}
			if (/^project(-keep)?\b/i.test(stage)) {
				const bodyPart = stage.replace(/^project(-keep)?\b/i, '');
				const next = bodyPart.split(',').map(part => {
					const assignment = part.match(/^\s*([A-Za-z_][\w-]*)\s*=/);
					if (assignment) return assignment[1];
					const ident = part.match(/\b([A-Za-z_][\w-]*)\b/);
					return ident ? ident[1] : '';
				}).filter(Boolean);
				if (next.length) columns = next;
				continue;
			}
			if (/^extend\b/i.test(stage)) {
				const set = new Set(columns);
				for (const match of stage.matchAll(/\b([A-Za-z_][\w-]*)\s*=/g)) set.add(match[1]);
				columns = Array.from(set);
				continue;
			}
			if (/^summarize\b/i.test(stage)) {
				const by = stage.match(/\bby\b([\s\S]*)$/i)?.[1] || '';
				const next: string[] = (by.match(/[A-Za-z_][\w-]*/g) || []);
				const aggregatePart = stage.split(/\bby\b/i)[0];
				for (const match of aggregatePart.matchAll(/\b([A-Za-z_][\w-]*)\s*=/g)) next.push(match[1]);
				if (!next.length && /\bcount\s*\(\s*\)/i.test(aggregatePart)) next.push('Count');
				columns = Array.from(new Set(next));
			}
		}
		return columns;
	} catch (e) { console.error('[kusto]', e); }
	return [];
}

function __kustoFindLoadedRawSchemaForColumnCompletions(clusterName: string, database: string): any {
	try {
		const key = __kustoGetCrossClusterSchemaKey(clusterName, database);
		if (key && __kustoCrossClusterSchemas?.[key]?.rawSchemaJson) {
			return __kustoCrossClusterSchemas[key].rawSchemaJson;
		}
	} catch (e) { console.error('[kusto]', e); }
	return null;
}

function __kustoSyntheticBodyForColumnNames(columns: string[]): string {
	const unique = Array.from(new Set((columns || []).map(column => String(column || '').trim()).filter(Boolean)));
	if (!unique.length) return '';
	return `{ print ${unique.map(column => {
		const alias = /^[A-Za-z_][A-Za-z0-9_]*$/.test(column) ? column : `["${column.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`;
		const literal = column.toLowerCase() === 'timestamp' || /time|date/i.test(column) ? 'datetime(2026-01-01)' : '""';
		return `${alias} = ${literal}`;
	}).join(', ')} }`;
}

function __kustoEnsureInferredFunctionBodiesForSchema(schemaObj: any): any {
	try {
		const dbs = schemaObj?.Databases || {};
		for (const [databaseName, db] of Object.entries(dbs) as Array<[string, any]>) {
			const functions = db?.Functions || {};
			for (const fn of Object.values(functions) as any[]) {
				if (!fn || typeof fn !== 'object') continue;
				const existingOutputColumns = __kustoColumnNamesFromSchemaEntity({ OutputColumns: fn.OutputColumns || fn.outputColumns || [] });
				if (existingOutputColumns.length) continue;
				const inferred = __kustoInferRawFunctionBodyColumns(schemaObj, databaseName, fn.Body || fn.body || '');
				const syntheticBody = __kustoSyntheticBodyForColumnNames(inferred);
				if (!syntheticBody) continue;
				const originalBody = String(fn.Body || fn.body || '').trim();
				if (originalBody && !fn.__kustoOriginalBody) fn.__kustoOriginalBody = originalBody;
				fn.OutputColumns = inferred.map((column: string, index: number) => ({
					Name: column,
					Type: /time|date/i.test(column) ? 'datetime' : 'string',
					CslType: /time|date/i.test(column) ? 'datetime' : 'string',
					Ordinal: index,
				}));
				fn.outputColumns = fn.OutputColumns;
				fn.Body = syntheticBody;
				fn.body = syntheticBody;
			}
		}
	} catch (e) { console.error('[kusto]', e); }
	return schemaObj;
}

function __kustoPrepareSchemaForKustoWorker(schemaObj: any): any {
	return __kustoEnsureInferredFunctionBodiesForSchema(ensureKustoFunctionBodiesForSchema(schemaObj));
}

function __kustoApplyColumnPipelineStages(columns: string[], stages: string[]): string[] {
	let current = Array.from(new Set(columns || []));
	for (const rawStage of stages || []) {
		const stage = String(rawStage || '').trim();
		if (!stage) continue;
		if (/^(where|filter|take|limit|top|order\s+by|sort\s+by)\b/i.test(stage)) continue;
		if (/^project-away\b/i.test(stage)) {
			const remove = new Set((stage.replace(/^project-away\b/i, '').match(/[A-Za-z_][\w-]*/g) || []).map(name => name.toLowerCase()));
			current = current.filter(column => !remove.has(column.toLowerCase()));
			continue;
		}
		if (/^project-rename\b/i.test(stage)) {
			for (const match of stage.replace(/^project-rename\b/i, '').matchAll(/\b([A-Za-z_][\w-]*)\s*=\s*([A-Za-z_][\w-]*)\b/g)) {
				const nextName = match[1];
				const oldName = match[2];
				current = current.map(column => column.toLowerCase() === oldName.toLowerCase() ? nextName : column);
			}
			continue;
		}
		if (/^project-reorder\b/i.test(stage)) {
			continue;
		}
		if (/^project(-keep)?\b/i.test(stage)) {
			const bodyPart = stage.replace(/^project(-keep)?\b/i, '');
			const next = bodyPart.split(',').map(part => {
				const assignment = part.match(/^\s*([A-Za-z_][\w-]*)\s*=/);
				if (assignment) return assignment[1];
				const ident = part.match(/\b([A-Za-z_][\w-]*)\b/);
				return ident ? ident[1] : '';
			}).filter(Boolean);
			if (next.length) current = next;
			continue;
		}
		if (/^extend\b/i.test(stage)) {
			const set = new Set(current);
			for (const match of stage.matchAll(/\b([A-Za-z_][\w-]*)\s*=/g)) set.add(match[1]);
			current = Array.from(set);
			continue;
		}
		if (/^distinct\b/i.test(stage)) {
			const next = (stage.replace(/^distinct\b/i, '').match(/[A-Za-z_][\w-]*/g) || []);
			if (next.length) current = next;
			continue;
		}
		if (/^summarize\b/i.test(stage)) {
			const by = stage.match(/\bby\b([\s\S]*)$/i)?.[1] || '';
			const next: string[] = (by.match(/[A-Za-z_][\w-]*/g) || []);
			const aggregatePart = stage.split(/\bby\b/i)[0];
			for (const match of aggregatePart.matchAll(/\b([A-Za-z_][\w-]*)\s*=/g)) next.push(match[1]);
			if (!next.length && /\bcount\s*\(\s*\)/i.test(aggregatePart)) next.push('Count');
			current = Array.from(new Set(next));
		}
	}
	return current;
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
		const currentStageMatch = String(before || '').match(/\|\s*([A-Za-z_][\w-]*(?:\s+[A-Za-z_][\w-]*)?)\b([^|]*)$/i);
		const operator = String(currentStageMatch?.[1] || '').toLowerCase().replace(/\s+/g, ' ');
		const operatorTail = String(currentStageMatch?.[2] || '');
		if (!operator || /^(take|limit)$/.test(operator)) {
			return [];
		}
		if (operator === 'top' && !/\bby\b/i.test(operatorTail)) {
			return [];
		}
		if (!/^(where|filter|project|project-away|project-keep|project-rename|project-reorder|extend|summarize|distinct|order by|sort by|top)$/.test(operator)) {
			return [];
		}
		const stages = __kustoSplitPipelineStagesDeep(before).map((stage: any) => String(stage || '').trim()).filter(Boolean);
		if (!stages.length) return [];
		const sourceStage = stages[0];
		const priorStages = stages.slice(1, -1);
		const sourceMatches = Array.from(sourceStage.matchAll(/(?:cluster\s*\(\s*(['"])(.*?)\1\s*\)\s*\.\s*)?(?:database\s*\(\s*(['"])(.*?)\3\s*\)\s*\.\s*)?([A-Za-z_][\w-]*)\s*(?:\(\s*\))?/gi));
		const sourceMatch = sourceMatches.length ? sourceMatches[sourceMatches.length - 1] : null;
		if (!sourceMatch) return [];
		const clusterName = sourceMatch[2] || '';
		const database = sourceMatch[4] || __kustoGetDatabase(boxId);
		const entityName = sourceMatch[5];
		const schema = schemaByBoxId?.[boxId];
		const context = __kustoGetSchemaContextForBox(boxId);
		let rawSchemaJson = schema?.rawSchemaJson || null;
		if (clusterName) {
			const refIsCurrent = (() => {
				try {
					const ref = extractCrossClusterRefs(`cluster('${clusterName}').database('${database}').${entityName}`, context || undefined);
					return Array.isArray(ref) && ref.length === 0;
				} catch { return false; }
			})();
			rawSchemaJson = refIsCurrent ? (schema?.rawSchemaJson || null) : __kustoFindLoadedRawSchemaForColumnCompletions(clusterName, database);
		}
		let columns = __kustoResolveRawSchemaEntityColumns(rawSchemaJson, database, entityName);
		if (!columns.length) {
			const entity = __kustoFindRawSchemaEntity(rawSchemaJson, database, entityName);
			columns = __kustoInferRawFunctionBodyColumns(rawSchemaJson, database, entity?.Body || entity?.body || '');
		}
		recordAutocompleteTrace(__kustoGetAutocompleteTraceIdForModel(modelUri), 'supplemental-columns', {
			boxId,
			clusterName,
			database,
			entityName,
			hasRawSchema: !!rawSchemaJson,
			columnCount: columns.length,
			sample: columns.slice(0, 12),
		});
		return __kustoApplyColumnPipelineStages(columns, priorStages);
	} catch (e) { console.error('[kusto]', e); }
	return [];
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
let __kustoLastCrossClusterInteractionAtByBoxId: Record<string, number> = {};
let __kustoCrossClusterPointerDownByBoxId: Record<string, boolean> = {};
let __kustoCrossClusterInterestedBoxIdsByKey: Record<string, Set<string>> = {};
let __kustoCrossClusterRequestTokenByBoxKey: Record<string, string> = {};
let __kustoCrossClusterLoadedModelUrisByKey: Record<string, Set<string>> = {};
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
export let __kustoCrossClusterSchemas: Record<string, any> = {};
export let __kustoMonacoInitRetryCountByBoxId: Record<string, number> = {};

const __kustoCrossClusterTrace: Array<Record<string, any>> = [];

function __kustoSanitizeTraceDetail(detail: Record<string, any>): Record<string, any> {
	const out: Record<string, any> = {};
	for (const [key, value] of Object.entries(detail || {})) {
		if (key === 'rawSchemaJson' || key === 'schemaObj') continue;
		if (key === 'requestToken' && value) {
			const text = String(value);
			out[key] = text.length <= 18 ? text : `${text.slice(0, 12)}...${text.slice(-4)}`;
			continue;
		}
		if (key === 'error' && value) {
			out[key] = String(value).replace(/[\r\n\t]+/g, ' ').slice(0, 240);
			continue;
		}
		if (typeof value === 'string') {
			out[key] = value.length > 240 ? `${value.slice(0, 237)}...` : value;
			continue;
		}
		out[key] = value;
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

const CROSS_CLUSTER_SCHEMA_CONTENT_CHECK_DELAY_MS = 500;
const CROSS_CLUSTER_SCHEMA_FOCUS_CHECK_DELAY_MS = 1500;
const CROSS_CLUSTER_SCHEMA_MIN_IDLE_MS = 1200;
const CROSS_CLUSTER_SCHEMA_APPLY_MIN_IDLE_MS = 1200;
const CROSS_CLUSTER_SCHEMA_IDLE_RETRY_FLOOR_MS = 100;
const CROSS_CLUSTER_SCHEMA_AUTOCOMPLETE_WAIT_MS = 1200;
const CROSS_CLUSTER_SCHEMA_AUTOCOMPLETE_RETRY_WAIT_MS = 8000;
const CROSS_CLUSTER_SCHEMA_AUTOCOMPLETE_DEMAND_MS = 8000;

interface CrossClusterSchemaApplyArgs {
	clusterName: string;
	clusterUrl: string;
	database: string;
	rawSchemaJson: any;
	boxId?: string;
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

async function __kustoAddDatabaseAliasesToWorker(worker: any, modelUri: string, schemaObj: any, clusterName: any, clusterUrl: any, database: any): Promise<number> {
	try {
		if (!worker || typeof worker.addDatabaseToSchema !== 'function' || !modelUri || !schemaObj || !database) {
			return 0;
		}
		recordAutocompleteTrace(__kustoGetAutocompleteTraceIdForModel(modelUri), 'worker-add-aliases-start', { modelUri, clusterName, clusterUrl, database });
		schemaObj = __kustoPrepareSchemaForKustoWorker(schemaObj);
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
			|| Object.entries(schemaObj.Databases || {}).find(([name]) => name.toLowerCase() === String(database).toLowerCase())?.[1]
			|| Object.values(schemaObj.Databases || {})[0];
		let databaseSchema: any = null;
		if (typeof worker.normalizeSchema === 'function') {
			try {
				const engineSchema = await worker.normalizeSchema(schemaObj, clusterUrl, database);
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
			await worker.addDatabaseToSchema(modelUri, alias, databaseSchema);
			count++;
		}
		recordAutocompleteTrace(__kustoGetAutocompleteTraceIdForModel(modelUri), 'worker-add-aliases-finish', {
			modelUri,
			clusterName,
			clusterUrl,
			database,
			aliasCount: count,
			aliases: __kustoGetCrossClusterClusterAliases(clusterName, clusterUrl),
			tables: Array.isArray(databaseSchema.tables) ? databaseSchema.tables.length : undefined,
			functions: Array.isArray(databaseSchema.functions) ? databaseSchema.functions.length : undefined,
		});
		return count;
	} catch (e) {
		console.error('[kusto] Failed to add database aliases:', e);
		recordAutocompleteTrace(__kustoGetAutocompleteTraceIdForModel(modelUri), 'worker-add-aliases-error', { clusterName, clusterUrl, database, error: e instanceof Error ? e.message : String(e) });
		return 0;
	}
}

function __kustoGetCrossClusterSchemaKey(clusterName: any, database: any): string {
	return kustoDatabaseKey(clusterName, database);
}

function __kustoGetCrossClusterRequestBoxKey(boxId: any, clusterName: any, database: any): string {
	const id = __kustoNormalizeCrossClusterBoxId(boxId);
	const key = __kustoGetCrossClusterSchemaKey(clusterName, database);
	return id && key ? `${id}|${key}` : '';
}

export function __kustoIsCurrentCrossClusterRequest(boxId: any, clusterName: any, database: any, requestToken: any): boolean {
	const requestKey = __kustoGetCrossClusterRequestBoxKey(boxId, clusterName, database);
	const token = String(requestToken || '').trim();
	if (!token) {
		return true;
	}
	if (!requestKey) {
		return false;
	}
	const expected = __kustoCrossClusterRequestTokenByBoxKey[requestKey];
	return !!expected && expected === token;
}

function __kustoHasCurrentCrossClusterRequestForKey(schemaKey: string): boolean {
	try {
		if (!schemaKey) {
			return false;
		}
		return Object.keys(__kustoCrossClusterRequestTokenByBoxKey).some(requestKey => requestKey.endsWith(`|${schemaKey}`));
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
		if (!__kustoIsCrossClusterSchemaLoaded(key)) {
			return false;
		}
		if (!modelUri) {
			return true;
		}
		const loadedModels = __kustoCrossClusterLoadedModelUrisByKey?.[key];
		return !!(loadedModels && loadedModels.has(modelUri));
	} catch {
		return false;
	}
}

function __kustoRememberCrossClusterModelLoaded(key: string, modelUri: string): void {
	try {
		if (!key || !modelUri) {
			return;
		}
		if (!__kustoCrossClusterLoadedModelUrisByKey[key]) {
			__kustoCrossClusterLoadedModelUrisByKey[key] = new Set<string>();
		}
		__kustoCrossClusterLoadedModelUrisByKey[key].add(modelUri);
	} catch (e) { console.error('[kusto]', e); }
}

function __kustoForgetCrossClusterModelLoaded(key: string): void {
	try {
		if (key) {
			delete __kustoCrossClusterLoadedModelUrisByKey[key];
		}
	} catch (e) { console.error('[kusto]', e); }
}

function __kustoForgetAllCrossClusterModelLoaded(): void {
	try {
		__kustoCrossClusterLoadedModelUrisByKey = {};
	} catch (e) { console.error('[kusto]', e); }
}

function __kustoForgetCrossClusterModelLoadedForUri(modelUri: string): void {
	try {
		const uri = String(modelUri || '').trim();
		if (!uri) {
			return;
		}
		for (const [key, loadedModels] of Object.entries(__kustoCrossClusterLoadedModelUrisByKey || {})) {
			if (!loadedModels) {
				continue;
			}
			loadedModels.delete(uri);
			if (loadedModels.size === 0) {
				delete __kustoCrossClusterLoadedModelUrisByKey[key];
			}
		}
	} catch (e) { console.error('[kusto]', e); }
}

function __kustoForgetAllSchemaWorkerReady(): void {
	try {
		for (const key of Object.keys(schemaWorkerReadyByBoxId || {})) {
			delete schemaWorkerReadyByBoxId[key];
		}
		for (const key of Object.keys(schemaWorkerReadyWaitersByBoxId || {})) {
			const waiters = schemaWorkerReadyWaitersByBoxId[key] || [];
			for (const waiter of waiters) {
				try { waiter.resolve(false); } catch (e) { console.error('[kusto]', e); }
			}
			delete schemaWorkerReadyWaitersByBoxId[key];
		}
	} catch (e) { console.error('[kusto]', e); }
}

let __kustoCrossClusterSchemaWaitersByKey: Record<string, Array<(loaded: boolean) => void>> = {};
let __kustoCrossClusterAutocompleteDemandUntilByKey: Record<string, number> = {};

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
		const existingLoadedModels = entry && entry.status === 'loaded'
			? __kustoCrossClusterLoadedModelUrisByKey[key]
			: undefined;
		if (!existingLoadedModels) {
			__kustoForgetCrossClusterModelLoaded(key);
		}
		__kustoCrossClusterSchemas[key] = entry;
		if (existingLoadedModels) {
			__kustoCrossClusterLoadedModelUrisByKey[key] = existingLoadedModels;
		}
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
	__kustoSetCrossClusterSchemaEntry(key, { status: 'error', error });
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

function __kustoWaitForCrossClusterSchemaReadyForModel(key: string, modelUri: string, timeoutMs: number): Promise<boolean> {
	if (!key) {
		return Promise.resolve(false);
	}
	if (__kustoIsCrossClusterSchemaLoadedForModel(key, modelUri)) {
		return Promise.resolve(true);
	}
	return new Promise(resolve => {
		const started = Date.now();
		const timeout = Math.max(0, Number(timeoutMs) || 0);
		const check = () => {
			try {
				if (__kustoIsCrossClusterSchemaLoadedForModel(key, modelUri)) {
					resolve(true);
					return;
				}
				if (timeout <= 0 || Date.now() - started >= timeout) {
					resolve(false);
					return;
				}
				setTimeout(check, 50);
			} catch {
				resolve(false);
			}
		};
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
	for (const key of Object.keys(__kustoCrossClusterRequestTokenByBoxKey)) {
		if (key.startsWith(`${id}|`)) {
			delete __kustoCrossClusterRequestTokenByBoxKey[key];
		}
	}
	for (const [key, boxIds] of Object.entries(__kustoCrossClusterInterestedBoxIdsByKey)) {
		boxIds.delete(id);
		if (boxIds.size === 0) {
			delete __kustoCrossClusterInterestedBoxIdsByKey[key];
		}
	}
}

function __kustoTrackCrossClusterInterest(key: string, boxId: any): void {
	const id = __kustoNormalizeCrossClusterBoxId(boxId);
	if (!key || !id) {
		return;
	}
	if (!__kustoCrossClusterInterestedBoxIdsByKey[key]) {
		__kustoCrossClusterInterestedBoxIdsByKey[key] = new Set<string>();
	}
	__kustoCrossClusterInterestedBoxIdsByKey[key].add(id);
}

function __kustoHasLiveCrossClusterInterest(key: string): boolean {
	const boxIds = __kustoCrossClusterInterestedBoxIdsByKey[key];
	if (!boxIds) {
		return false;
	}
	for (const id of Array.from(boxIds)) {
		if (queryEditors?.[id]) {
			return true;
		}
		boxIds.delete(id);
	}
	if (boxIds.size === 0) {
		delete __kustoCrossClusterInterestedBoxIdsByKey[key];
	}
	return false;
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
	if (!key || key === '|') {
		return;
	}
	__kustoTraceCrossCluster('apply-scheduled', { key, boxId: args.boxId, demanded: __kustoIsCrossClusterSchemaDemandedForAutocomplete(key), source: (args as any).source || '', cacheAgeMs: (args as any).cacheAgeMs });
	const shouldSkipDisposedBox = () => {
		const id = __kustoNormalizeCrossClusterBoxId(args.boxId);
		if (id && !queryEditors?.[id]) {
			if (__kustoHasLiveCrossClusterInterest(key)) {
				return false;
			}
			__kustoSetCrossClusterSchemaEntry(key, { status: 'error', error: 'Editor disposed before schema apply' });
			return true;
		}
		return false;
	};
	try {
		if (__kustoCrossClusterApplyTimeout?.[key]) {
			clearTimeout(__kustoCrossClusterApplyTimeout[key]);
		}
	} catch (e) { console.error('[kusto]', e); }

	const run = () => {
		try { delete __kustoCrossClusterApplyTimeout[key]; } catch (e) { console.error('[kusto]', e); }
		try {
			if (shouldSkipDisposedBox()) {
				__kustoTraceCrossCluster('apply-skipped-disposed', { key, boxId: args.boxId });
				return;
			}
			const idleDelay = __kustoIsCrossClusterSchemaDemandedForAutocomplete(key)
				? 0
				: __kustoGetCrossClusterIdleDelay(args.boxId, CROSS_CLUSTER_SCHEMA_APPLY_MIN_IDLE_MS);
			if (idleDelay > 0) {
				__kustoTraceCrossCluster('apply-idle-delay', { key, boxId: args.boxId, idleDelay });
				__kustoCrossClusterApplyTimeout[key] = setTimeout(run, Math.max(idleDelay, CROSS_CLUSTER_SCHEMA_IDLE_RETRY_FLOOR_MS));
				return;
			}

			const operationPromise = __kustoSchemaOperationQueue.then(async () => {
				if (shouldSkipDisposedBox()) {
					__kustoTraceCrossCluster('apply-queued-skipped-disposed', { key, boxId: args.boxId });
					return;
				}
				const queuedIdleDelay = __kustoIsCrossClusterSchemaDemandedForAutocomplete(key)
					? 0
					: __kustoGetCrossClusterIdleDelay(args.boxId, CROSS_CLUSTER_SCHEMA_APPLY_MIN_IDLE_MS);
				if (queuedIdleDelay > 0) {
					__kustoTraceCrossCluster('apply-queued-idle-delay', { key, boxId: args.boxId, queuedIdleDelay });
					__kustoScheduleCrossClusterSchemaApply(args);
					return;
				}
				__kustoTraceCrossCluster('apply-start', { key, boxId: args.boxId, source: (args as any).source || '', cacheAgeMs: (args as any).cacheAgeMs });
				return await __kustoApplyCrossClusterSchemaInternal!(args.clusterName, args.clusterUrl, args.database, args.rawSchemaJson, args.boxId, (args as any).source || '', (args as any).cacheAgeMs);
			}).catch((e: any) => {
				console.error('[monaco-kusto] Cross-cluster schema operation failed:', e);
			});
			__kustoSchemaOperationQueue = operationPromise;
		} catch (e) { console.error('[kusto]', e); }
	};

	__kustoCrossClusterApplyTimeout[key] = setTimeout(run, 0);
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
					
					// Cache all raw schema data we receive, so we can re-add them after cluster switches
					// Key: `${clusterUrl}|${database}`, Value: { rawSchemaJson, clusterUrl, database }
					__kustoSchemaTracker.schemaCache = {};
					
					// Mutex to serialize schema operations - prevents race conditions during parallel loads
					__kustoSchemaOperationQueue = Promise.resolve();
					
					// Function to set/add schema in monaco-kusto worker for full IntelliSense support
					// Uses aggregate approach: first schema uses setSchemaFromShowSchema, 
					// subsequent schemas use addDatabaseToSchema to ADD without replacing
					_win.__kustoSetMonacoKustoSchema = async function (rawSchemaJson: any, clusterUrl: any, database: any, setAsContext = false, modelUri: any = null, forceRefresh = false) {
						// Serialize schema operations to prevent race conditions
						traceFileOpen('monaco.schema.queue.requested', { clusterUrl, database, setAsContext, modelUri, forceRefresh });
						const operationPromise = __kustoSchemaOperationQueue.then(async () => {
							traceFileOpen('monaco.schema.queue.start', { clusterUrl, database, setAsContext, modelUri, forceRefresh });
							const result = await __kustoSetMonacoKustoSchemaInternal!(rawSchemaJson, clusterUrl, database, setAsContext, modelUri, forceRefresh);
							traceFileOpen('monaco.schema.queue.done', { clusterUrl, database, result });
							return result;
						}).catch((e: any) => {
							console.error('[monaco-kusto] Queued operation failed:', e);
							traceFileOpen('monaco.schema.queue.error', { clusterUrl, database, error: e instanceof Error ? e.message : String(e) });
							return false;
						});
						__kustoSchemaOperationQueue = operationPromise;
						return operationPromise;
					};
					
					// Internal implementation - called through the queue
__kustoSetMonacoKustoSchemaInternal = async function (rawSchemaJson: any, clusterUrl: any, database: any, setAsContext = false, modelUri: any = null, forceRefresh = false) {
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
										try { __kustoClearAutocompleteTraceForModel(uriKey); } catch (e) { console.error('[kusto]', e); }
										try { __kustoForgetCrossClusterModelLoadedForUri(uriKey); } catch (e) { console.error('[kusto]', e); }
									} catch (e) { console.error('[kusto]', e); }
								});
							}
						} catch (e) { console.error('[kusto]', e); }

						const modelKey = modelUri ? (typeof modelUri === 'string' ? modelUri : modelUri.toString()) : models[0].uri.toString();
						__kustoMonacoDatabaseInContextByModel[modelKey] = __kustoMonacoDatabaseInContextByModel[modelKey] || null;
						__kustoMonacoInitializedByModel[modelKey] = !!__kustoMonacoInitializedByModel[modelKey];

						const schemaKey = kustoDatabaseKey(clusterUrl, database);
						traceFileOpen('monaco.schema.internal.modelResolved', { schemaKey, modelKey });
						
						// Normalize cluster URLs for comparison (used for marker clearing)
						const normalizeClusterUrl = (url: any) => kustoClusterKey(url);

						// ── Decision: delegated to the tested SchemaTracker ──
						const { operation, alreadyLoaded } = __kustoSchemaTracker.decide(modelKey, clusterUrl, database, setAsContext, forceRefresh);
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
							schemaObj = __kustoPrepareSchemaForKustoWorker(schemaObj);
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
												traceFileOpen('monaco.schema.worker.setSchemaFromShowSchema.start', { schemaKey, action: operation.action });
												await worker.setSchemaFromShowSchema(schemaObj, clusterUrl, databaseInContext);
												traceFileOpen('monaco.schema.worker.setSchemaFromShowSchema.done', { schemaKey, action: operation.action });
												recordAutocompleteTrace(__kustoGetAutocompleteTraceIdForModel(modelKey), 'worker-schema-first-load', { modelKey, clusterUrl, database: databaseInContext });
												await __kustoAddDatabaseAliasesToWorker(worker, modelKey, schemaObj, clusterUrl, clusterUrl, databaseInContext);
												__kustoSchemaTracker.recordFirstLoad(modelKey, schemaKey, clusterUrl, databaseInContext, schemaObj);
												__kustoMonacoInitializedByModel[modelKey] = true;
												__kustoMonacoDatabaseInContextByModel[modelKey] = { clusterUrl, database: databaseInContext };
												applied = true;
											} catch (schemaError) {
												console.error('[monaco-kusto] setSchemaFromShowSchema failed:', schemaError);
											}
										}
									// ── REPLACE ──────────────────────────────────────────────
									} else if (operation.action === 'replace') {
										if (typeof worker.setSchemaFromShowSchema === 'function') {
											try {
												traceFileOpen('monaco.schema.worker.setSchemaFromShowSchema.start', { schemaKey, action: operation.action });
												await worker.setSchemaFromShowSchema(schemaObj, clusterUrl, databaseInContext);
												traceFileOpen('monaco.schema.worker.setSchemaFromShowSchema.done', { schemaKey, action: operation.action });
												recordAutocompleteTrace(__kustoGetAutocompleteTraceIdForModel(modelKey), 'worker-schema-replace', { modelKey, clusterUrl, database: databaseInContext });
												await __kustoAddDatabaseAliasesToWorker(worker, modelKey, schemaObj, clusterUrl, clusterUrl, databaseInContext);
												const otherKeys = __kustoSchemaTracker.recordReplace(modelKey, schemaKey, clusterUrl, databaseInContext, schemaObj);
												__kustoMonacoInitializedByModel[modelKey] = true;
												__kustoMonacoDatabaseInContextByModel[modelKey] = { clusterUrl, database: databaseInContext };
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
															const engineSchema = await worker.normalizeSchema(__kustoPrepareSchemaForKustoWorker(cached.rawSchemaJson), cached.clusterUrl, cached.database);
															let databaseSchema = engineSchema?.database;
															if (!databaseSchema && engineSchema?.cluster?.databases) {
																databaseSchema = engineSchema.cluster.databases.find((db: any) => db.name.toLowerCase() === cached.database.toLowerCase());
															}
															if (databaseSchema) {
																await worker.addDatabaseToSchema(modelKey, cached.clusterUrl, databaseSchema);
															}
														} catch (readdError) { console.error('[kusto]', readdError); }
													}
												}
												traceFileOpen('monaco.schema.readdCached.done', { schemaKey, count: otherKeys.length });

												// Re-add cross-cluster schemas that were previously loaded.
												// The replace above wiped the worker schema, but __kustoCrossClusterSchemas
												// still has the cached rawSchemaJson — re-add them so autocomplete and
												// diagnostics continue to work for cross-cluster/cross-database references.
												traceFileOpen('monaco.schema.readdCrossCluster.start', { schemaKey, count: Object.keys(__kustoCrossClusterSchemas).length });
												for (const [ccKey, ccEntry] of Object.entries(__kustoCrossClusterSchemas)) {
													if (!ccEntry || ccEntry.status !== 'loaded' || !ccEntry.rawSchemaJson) continue;
													try {
														const pipeIdx = ccKey.indexOf('|');
														if (pipeIdx < 0) continue;
														const ccClusterName = ccKey.slice(0, pipeIdx);
														const ccDatabase = ccKey.slice(pipeIdx + 1);
														if (!ccClusterName || !ccDatabase) continue;
														const ccAliasCount = await __kustoAddDatabaseAliasesToWorker(worker, modelKey, ccEntry.rawSchemaJson, ccClusterName, ccEntry.clusterUrl, ccDatabase);
														if (ccAliasCount > 0) {
															__kustoRememberCrossClusterModelLoaded(ccKey, modelKey);
														} else {
															ccEntry.status = 'error';
															ccEntry.error = 'Failed to re-add after replace';
														}
													} catch (ccReaddError) {
														console.error('[kusto] Failed to re-add cross-cluster schema:', ccKey, ccReaddError);
														ccEntry.status = 'error';
														ccEntry.error = 'Failed to re-add after replace';
													}
												}
												
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
										traceFileOpen('monaco.schema.readdCrossCluster.done', { schemaKey, count: Object.keys(__kustoCrossClusterSchemas).length });
									// ── ADD ──────────────────────────────────────────────────
									} else if (operation.action === 'add') {
										let alreadyLoadedGlobally = !forceRefresh && __kustoSchemaTracker.isLoadedGlobally(schemaKey);
										if (alreadyLoadedGlobally) {
											__kustoSchemaTracker.recordAdoptGlobal(modelKey, schemaKey, clusterUrl, databaseInContext, schemaObj);
											applied = true;
											if (setAsContext) {
												const switched = await __kustoSetDatabaseInContext!(clusterUrl, databaseInContext, modelKey);
												applied = switched;
												if (!switched) {
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
													traceFileOpen('monaco.schema.worker.addDatabaseToSchema.start', { schemaKey });
													await worker.addDatabaseToSchema(modelKey, clusterUrl, databaseSchema);
													traceFileOpen('monaco.schema.worker.addDatabaseToSchema.done', { schemaKey });
													recordAutocompleteTrace(__kustoGetAutocompleteTraceIdForModel(modelKey), 'worker-schema-add', { modelKey, clusterUrl, database: databaseInContext });
													await __kustoAddDatabaseAliasesToWorker(worker, modelKey, schemaObj, clusterUrl, clusterUrl, databaseInContext);
													__kustoSchemaTracker.recordAdd(modelKey, schemaKey, clusterUrl, databaseInContext, schemaObj, setAsContext);
													__kustoMonacoDatabaseInContextByModel[modelKey] = { clusterUrl, database: databaseInContext };
													applied = true;
													// For setAsContext, also try getSchema/setSchema for reliable context switch
													if (setAsContext) {
														try {
															if (typeof worker.getSchema === 'function' && typeof worker.setSchema === 'function') {
																const currentSchema = await worker.getSchema();
																const currentDatabases = currentSchema?.cluster?.databases || [];
																const existingDb = currentDatabases.find((db: any) => db?.name?.toLowerCase?.() === databaseSchema.name.toLowerCase());
																const nextDatabases = existingDb
																	? currentDatabases.map((db: any) => db?.name?.toLowerCase?.() === databaseSchema.name.toLowerCase() ? databaseSchema : db)
																	: [...currentDatabases, databaseSchema];
																await worker.setSchema({ ...currentSchema, cluster: { ...(currentSchema?.cluster || {}), databases: nextDatabases }, database: databaseSchema });
															}
														} catch { /* best effort */ }
													}
												}
											} catch (addError) {
												console.error('[monaco-kusto] ADD: addDatabaseToSchema failed:', addError);
											}
										} else if (!alreadyLoadedGlobally) {
											// Fallback: setSchemaFromShowSchema (will replace, but better than nothing)
											if (typeof worker.setSchemaFromShowSchema === 'function') {
												try {
													await worker.setSchemaFromShowSchema(__kustoPrepareSchemaForKustoWorker(schemaObj), clusterUrl, databaseInContext);
													recordAutocompleteTrace(__kustoGetAutocompleteTraceIdForModel(modelKey), 'worker-schema-fallback-first-load', { modelKey, clusterUrl, database: databaseInContext });
													await __kustoAddDatabaseAliasesToWorker(worker, modelKey, schemaObj, clusterUrl, clusterUrl, databaseInContext);
													__kustoSchemaTracker.recordFirstLoad(modelKey, schemaKey, clusterUrl, databaseInContext, schemaObj);
													__kustoMonacoInitializedByModel[modelKey] = true;
													__kustoMonacoDatabaseInContextByModel[modelKey] = { clusterUrl, database: databaseInContext };
													applied = true;
												} catch (e) {
													console.error('[monaco-kusto] Fallback setSchemaFromShowSchema failed:', e);
												}
											}
										}
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
__kustoSetDatabaseInContext = async function (clusterUrl: any, database: any, modelUri = null) {
						// Normalize cluster URLs for comparison
						const normalizeClusterUrl = (url: any) => kustoClusterKey(url);
						
						const models = monaco?.editor?.getModels ? monaco.editor.getModels() : [];
						if (!models || models.length === 0) {
							return false;
						}
						const modelKey = modelUri ? (typeof modelUri === 'string' ? modelUri : (modelUri as any).toString()) : models[0].uri.toString();
						const currentContext = __kustoMonacoDatabaseInContextByModel?.[modelKey] || __kustoSchemaTracker.databaseInContext;
						
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
							
							if (!worker || typeof worker.getSchema !== 'function' || typeof worker.setSchema !== 'function') {
								return false;
							}
							
							// Get the current aggregated schema
							const currentSchema = await worker.getSchema();

							if (!currentSchema || currentSchema.clusterType !== 'Engine') {
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
							
							await worker.setSchema(updatedSchema);
							
							__kustoMonacoDatabaseInContextByModel[modelKey] = { clusterUrl, database: targetDatabase.name };
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
							
							// Enable markers for this editor's model AFTER confirming connection context (lazy diagnostics)
							if (enableMarkers) {
								__kustoEnableMarkersForBox!(boxId);
							}
							
							// Get the cluster URL for this section's current selection.
							const selectedClusterUrl = __kustoGetClusterUrl(ownerId);
							const conn = Array.isArray(connections) ? connections.find(c => c && String(c.id || '') === connectionId) : null;
							const clusterUrl = selectedClusterUrl || (conn && conn.clusterUrl ? String(conn.clusterUrl) : '');
							
							if (!clusterUrl) {
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

							try { await __kustoFlushPendingSchemaWorkerUpdateForBox(boxId); } catch (e) { console.error('[kusto]', e); }
							
							// Get rawSchemaJson from the existing schema cache (schemaByBoxId)
							const schema = typeof schemaByBoxId !== 'undefined' ? schemaByBoxId[boxId] : null;
							const rawSchemaJson = schema && schema.rawSchemaJson ? schema.rawSchemaJson : null;
							const schemaKey = kustoDatabaseKey(clusterUrl, database);
							const schemaSignature = schemaMetaByBoxId && schemaMetaByBoxId[boxId]
								? schemaMetaByBoxId[boxId].schemaSignature
								: undefined;
							
							if (rawSchemaJson) {
								// Delegate to the queued schema loader with setAsContext=true.
								// This ensures all schema operations are serialized and tracking
								// state (global + per-model) is properly updated. The queued
								// function handles first-load vs add vs replace logic correctly,
								// including the "already loaded, just switch context" optimization.
								markSchemaWorkerApplyPending(boxId, schemaKey, schemaSignature);
								const applied = await _win.__kustoSetMonacoKustoSchema(rawSchemaJson, clusterUrl, database, true, focusedModelUri);
								if (!applied) {
									markSchemaWorkerApplyFailed(boxId, schemaKey);
									return;
								}
								markSchemaWorkerReady(boxId, schemaKey, schemaSignature);
								
								// Trigger re-validation with the newly loaded schema
								__kustoTriggerRevalidation!(boxId);
							} else {
								// No rawSchemaJson in schemaByBoxId yet. Check if the schema
								// was previously loaded and cached in __kustoSchemaTracker.schemaCache.
								const cachedSchema = __kustoSchemaTracker.schemaCache[schemaKey];
								if (cachedSchema && cachedSchema.rawSchemaJson) {
									markSchemaWorkerApplyPending(boxId, schemaKey, schemaSignature);
									const applied = await _win.__kustoSetMonacoKustoSchema(cachedSchema.rawSchemaJson, clusterUrl, database, true, focusedModelUri);
									if (!applied) {
										markSchemaWorkerApplyFailed(boxId, schemaKey);
										return;
									}
									markSchemaWorkerReady(boxId, schemaKey, schemaSignature);
									__kustoTriggerRevalidation!(boxId);
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
								const ctx = __kustoGetSchemaContextForBox(boxId);
								markSchemaWorkerApplyFailed(boxId, ctx?.schemaKey);
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
__kustoRequestCrossClusterSchema = function (clusterName: any, database: any, boxId: any) {
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
						__kustoTrackCrossClusterInterest(key, boxId);
						
						// Skip if already loaded or pending. Previous errors are retryable.
						if (__kustoCrossClusterSchemas[key] && __kustoCrossClusterSchemas[key].status !== 'error') {
							__kustoTraceCrossCluster('request-skipped-existing', { key, boxId, status: __kustoCrossClusterSchemas[key].status });
							return;
						}

						// Mark as pending
						__kustoSetCrossClusterSchemaEntry(key, { status: 'pending' });

						const requestToken = 'crosscluster_' + Date.now() + '_' + Math.random().toString(16).slice(2);
						const requestKey = __kustoGetCrossClusterRequestBoxKey(boxId, resolvedClusterName, database);
						if (requestKey) {
							__kustoCrossClusterRequestTokenByBoxKey[requestKey] = requestToken;
						}
						__kustoTraceCrossCluster('request-posted', { key, boxId, clusterName: resolvedClusterName, database, requestToken });
						
						postMessageToHost({
							type: 'requestCrossClusterSchema',
							clusterName: resolvedClusterName,
							database,
							boxId: boxId || '',
							requestToken
						});
					};

					// Apply a cross-cluster schema to monaco-kusto
					// This is serialized through the same queue as __kustoSetMonacoKustoSchema to prevent races
					_win.__kustoApplyCrossClusterSchema = async function (clusterName: any, clusterUrl: any, database: any, rawSchemaJson: any, boxId: any = '', source: any = '', cacheAgeMs: any = undefined) {
						__kustoScheduleCrossClusterSchemaApply({
							clusterName: String(clusterName || ''),
							clusterUrl: String(clusterUrl || ''),
							database: String(database || ''),
							rawSchemaJson,
							boxId: __kustoNormalizeCrossClusterBoxId(boxId),
							...source ? { source: String(source || '') } : {},
							...typeof cacheAgeMs === 'number' ? { cacheAgeMs } : {},
						});
					};
					
					// Internal implementation - called through the queue
__kustoApplyCrossClusterSchemaInternal = async function (clusterName: any, clusterUrl: any, database: any, rawSchemaJson: any, boxId: any = '', source: any = '', cacheAgeMs: any = undefined) {
						const key = __kustoGetCrossClusterSchemaKey(clusterName, database);
						
						try {
							const clusterAliases = __kustoGetCrossClusterClusterAliases(clusterName, clusterUrl);
							__kustoTraceCrossCluster('apply-internal-start', { key, boxId, clusterName, clusterUrl, database, aliases: clusterAliases, source, cacheAgeMs });
							// Parse the raw schema JSON
							let schemaObj;
							if (typeof rawSchemaJson === 'string') {
								try {
									schemaObj = JSON.parse(rawSchemaJson);
								} catch (e) {
									console.error('[monaco-kusto] Failed to parse cross-cluster schema JSON:', e);
										__kustoSetCrossClusterSchemaEntry(key, { status: 'error', error: 'Failed to parse schema' });
									return;
								}
							} else {
								schemaObj = rawSchemaJson;
							}

							if (!schemaObj || !schemaObj.Databases) {
								__kustoSetCrossClusterSchemaEntry(key, { status: 'error', error: 'Invalid schema format' });
								return;
							}

							// Get the kusto worker
							if (monaco && monaco.languages && monaco.languages.kusto && typeof monaco.languages.kusto.getKustoWorker === 'function') {
								const workerAccessor = await monaco.languages.kusto.getKustoWorker();
								const models = monaco.editor.getModels();
								
								if (!models || models.length === 0) {
									__kustoSetCrossClusterSchemaEntry(key, { status: 'error', error: 'No synced model available' });
									return;
								}

									let appliedCount = 0;
									let appliedToRequestedModel = false;
									const appliedModelUris: string[] = [];
									let requestedUri = '';
									try {
										const requestedEditor = boxId ? queryEditors?.[__kustoNormalizeCrossClusterBoxId(boxId)] : null;
										const requestedModel = requestedEditor && typeof requestedEditor.getModel === 'function' ? requestedEditor.getModel() : null;
										requestedUri = requestedModel && requestedModel.uri ? requestedModel.uri.toString() : '';
										const modelCandidates: any[] = [];
										if (requestedModel) {
											modelCandidates.push(requestedModel);
										}
										try {
											for (const editor of Object.values(queryEditors || {})) {
												const model = editor && typeof (editor as any).getModel === 'function' ? (editor as any).getModel() : null;
												if (model && model.uri && !modelCandidates.some(candidate => candidate?.uri?.toString?.() === model.uri.toString())) {
													modelCandidates.push(model);
												}
											}
										} catch (e) { console.error('[kusto]', e); }
										if (modelCandidates.length === 0 && models[0]) {
											modelCandidates.push(models[0]);
										}
										const schemaModel = requestedModel || modelCandidates[0] || models[0];
										const worker2 = await workerAccessor(schemaModel.uri);
										if (worker2 && typeof worker2.addDatabaseToSchema === 'function') {
											for (const model of modelCandidates) {
												try {
													if (!model || !model.uri) continue;
													const modelUri = model.uri.toString();
													const count = await __kustoAddDatabaseAliasesToWorker(worker2, modelUri, schemaObj, clusterName, clusterUrl, database);
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
												__kustoSetCrossClusterSchemaEntry(key, { status: 'error', error: 'Database not found in schema' });
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
												
									if (appliedCount > 0 && (!requestedUri || appliedToRequestedModel)) {
										for (const uri of appliedModelUris) {
											__kustoRememberCrossClusterModelLoaded(key, uri);
										}
										__kustoTraceCrossCluster('apply-internal-success', { key, boxId, appliedCount, appliedToRequestedModel, requestedUri, appliedModelUris });
										__kustoSetCrossClusterSchemaEntry(key, { 
											status: 'loaded', 
											rawSchemaJson: schemaObj,
											clusterUrl,
											clusterAliases
										});
										// Clear stale diagnostics (e.g., KS208 "does not refer to any
										// known database") so the language service re-validates with
										// the newly added schema on the next content/cursor change.
										try {
											const allModels = monaco.editor.getModels();
											for (const m of allModels) {
												monaco.editor.setModelMarkers(m, 'kusto', []);
											}
										} catch (e) { console.error('[kusto]', e); }
										// Show notification to user that cross-cluster schema was loaded
										try {
											postMessageToHost({
												type: 'showInfo',
												message: `Schema loaded for cluster('${clusterName}').database('${database}') — autocomplete is now available.`
											});
										} catch (e) { console.error('[kusto]', e); }
									} else if (!__kustoCrossClusterSchemas[key] || __kustoCrossClusterSchemas[key].status !== 'error') {
										__kustoTraceCrossCluster('apply-internal-failed', { key, boxId, appliedCount, appliedToRequestedModel, requestedUri });
										__kustoSetCrossClusterSchemaEntry(key, { status: 'error', error: appliedCount > 0 ? 'Requested editor model not updated' : 'API not available' });
									}
							} else {
								__kustoSetCrossClusterSchemaEntry(key, { status: 'error', error: 'API not available' });
							}
						} catch (e) {
							console.error('[monaco-kusto] Failed to apply cross-cluster schema:', e);
							__kustoSetCrossClusterSchemaEntry(key, { status: 'error', error: String(e) });
						}
					};

					// Check for cross-cluster references in a query and request schemas
__kustoCheckCrossClusterRefs = function (queryText: any, boxId: any) {
						const currentContext = __kustoGetSchemaContextForBox(__kustoNormalizeCrossClusterBoxId(boxId)) || __kustoSchemaTracker.databaseInContext;
						const refs = __kustoExtractCrossClusterRefs!(queryText, currentContext);
						if (refs.length > 0) {
							const diagCtx = currentContext;
							console.log(
								'%c[schema-diag] FQ-REFS in %s | current-context: %s/%s | refs:',
								'color:#f80;font-weight:bold',
								boxId,
								diagCtx?.clusterUrl || '(none)', diagCtx?.database || '(none)',
								refs.map(r => `${r.clusterName || '(same-cluster)'}/${r.database}`)
							);
						}
						for (const ref of refs) {
							__kustoRequestCrossClusterSchema!(ref.clusterName, ref.database, boxId);
						}
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
										flavor
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
								const columns = __kustoColumnCompletionsForModel(model, position);
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
				try { __kustoForgetAllSchemaWorkerReady(); } catch (e) { console.error('[kusto]', e); }
				try { __kustoForgetAllCrossClusterModelLoaded(); } catch (e) { console.error('[kusto]', e); }
				try { __kustoMonacoDatabaseInContextByModel = {}; } catch (e) { console.error('[kusto]', e); }
				try { __kustoMonacoInitializedByModel = {}; } catch (e) { console.error('[kusto]', e); }
				try { for (const key of Object.keys(__kustoAutocompleteTraceByModelUri)) delete __kustoAutocompleteTraceByModelUri[key]; } catch (e) { console.error('[kusto]', e); }
				__kustoSchemaTracker.databaseInContext = null;
				
				// Clear the schema from the worker through the schema queue so it cannot
				// race after a newer visible-tab schema apply.
				const clearPromise = __kustoSchemaOperationQueue.then(async () => {
					try {
						if (!document.hidden || clearGeneration !== __kustoSchemaClearGeneration) {
							return;
						}
						if (typeof monaco !== 'undefined' && monaco && monaco.languages && monaco.languages.kusto && 
							typeof monaco.languages.kusto.getKustoWorker === 'function') {
							const workerAccessor = await monaco.languages.kusto.getKustoWorker();
							const models = monaco.editor.getModels();
							if (models && models.length > 0 && workerAccessor) {
								for (const model of models) {
									try {
										if (!document.hidden || clearGeneration !== __kustoSchemaClearGeneration) {
											return;
										}
										const worker = await workerAccessor(model.uri);
										if (worker && typeof worker.setSchema === 'function') {
											await worker.setSchema({ cluster: { connectionString: '', databases: [] } });
										}
									} catch (e) { console.error('[kusto]', e); }
								}
										}
						}
					} catch (e) { console.error('[kusto]', e); }
				}).catch((e: any) => { console.error('[monaco-kusto] queued schema clear failed:', e); });
				__kustoSchemaOperationQueue = clearPromise;
			} else {
				__kustoSchemaClearGeneration++;
			}
			// Tab became visible - don't reload yet, wait for user to focus a query box
		} catch (e) { console.error('[kusto]', e); }
	}, true);
} catch (e) { console.error('[kusto]', e); }

function initQueryEditor(boxId: any) {
	perfMark('webview.monaco.queryEditor.init.start', { boxId });
	return ensureMonaco()!.then((monaco: any) => {
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

		const editor = monaco.editor.create(container, {
			value: initialValue,
			language: 'kusto',
			readOnly: false,
			domReadOnly: false,
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

		queryEditors[boxId] = editor;
		perfMark('webview.monaco.queryEditor.ready', { boxId });
		traceFileOpen('monaco.queryEditor.ready', { boxId, editorCount: Object.keys(queryEditors || {}).length });
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
			try {
				if (!ed) return false;
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
				traceId = startAutocompleteTrace(traceSeed);
				try { ed.__kustoAutocompleteTraceId = traceId; } catch (e) { console.error('[kusto]', e); }
				try { if (modelUri) __kustoAutocompleteTraceByModelUri[modelUri] = traceId; } catch (e) { console.error('[kusto]', e); }
				recordAutocompleteTrace(traceId, 'trigger-start', traceSeed);
				const schemaState = await __kustoPrepareSchemaForAutocomplete(ed, traceId);
				recordAutocompleteTrace(traceId, 'schema-prepare-result', { schemaState });
				if (schemaState === 'blocked') {
					finishAutocompleteTrace(traceId, 'success', { reason: 'schema-refresh-blocked-trigger' });
					try { __kustoClearAutocompleteTraceForModel(modelUri, traceId); } catch (e) { console.error('[kusto]', e); }
					return true;
				}
				__kustoTriggerAutocompleteInternal = __kustoTriggerAutocomplete;
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
						ed.trigger('keyboard', 'editor.action.triggerSuggest', {});
						recordAutocompleteTrace(traceId, 'suggest-triggered', {});
						try { if (typeof ed.__kustoScheduleSuggestClamp === 'function') ed.__kustoScheduleSuggestClamp(); } catch (e) { console.error('[kusto]', e); }
						return true;
					} catch (e) { console.error('[kusto]', e); recordAutocompleteTrace(traceId, 'suggest-trigger-error', { error: e instanceof Error ? e.message : String(e) }); return false; }
				};
				let triggered = false;
				if (shouldDeferTrigger) {
					await new Promise<void>(resolve => {
						const run = () => {
							try { ed.layout(); } catch (e) { console.error('[kusto]', e); }
							triggered = triggerNow();
							resolve();
						};
						try { requestAnimationFrame(run); } catch { setTimeout(run, 0); }
					});
				} else {
					triggered = triggerNow();
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
						recordAutocompleteTrace(traceId, 'suggest-visible-snapshot', { hasWidget: !!widget, labels, widgetTextLength: widget ? String(widget.textContent || '').length : 0 });
						finishAutocompleteTrace(traceId, labels.length ? 'success' : 'abandoned', { labelCount: labels.length });
						try { __kustoClearAutocompleteTraceForModel(modelUri, traceId); } catch (e) { console.error('[kusto]', e); }
					} catch (e) { recordAutocompleteTrace(traceId, 'suggest-visible-snapshot-error', { error: e instanceof Error ? e.message : String(e) }); }
				}, 900);
				// Best-effort preselect is driven by the suggest widget visibility observer (one-shot per open).
				return triggered;
			} catch (e) { console.error('[kusto]', e); finishAutocompleteTrace(traceId, 'failed', { error: e instanceof Error ? e.message : String(e) }); try { __kustoClearAutocompleteTraceId(traceId); } catch (cleanupError) { console.error('[kusto]', cleanupError); } return false; }
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
			const __kustoRunThisQueryBox = () => {
				try {
					executeQuery(boxId);
				} catch (e) { console.error('[kusto]', e); }
			};
			editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, __kustoRunThisQueryBox);
			editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Enter, __kustoRunThisQueryBox);
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
			try {
				if (typeof _win.__kustoOnQueryValueChanged === 'function') {
					_win.__kustoOnQueryValueChanged(boxId, editor.getValue());
				}
			} catch (e) { console.error('[kusto]', e); }
			try {
				__kustoScheduleKustoDiagnostics(boxId, 250);
			} catch (e) { console.error('[kusto]', e); }
			try { schedulePersist(); } catch (e) { console.error('[kusto]', e); }
			// Check for cross-cluster references and request their schemas after the editor is quiet.
			try {
				if (__kustoCheckCrossClusterRefs !== null) {
					__kustoNoteCrossClusterInteraction(boxId);
					__kustoScheduleCrossClusterRefCheck(editor, boxId, CROSS_CLUSTER_SCHEMA_CONTENT_CHECK_DELAY_MS);
				}
			} catch (e) { console.error('[kusto]', e); }
			try { __kustoMaybeAutoTriggerAutocomplete(editor, boxId, e); } catch (e) { console.error('[kusto]', e); }
			try { updateFunctionDetection(boxId, editor.getValue()); } catch (e) { console.error('[kusto]', e); }
		});
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
					let disposedModelUri = '';
					try {
						const disposedModel = typeof editor.getModel === 'function' ? editor.getModel() : null;
						disposedModelUri = disposedModel && disposedModel.uri ? String(disposedModel.uri.toString()) : '';
					} catch (e) { console.error('[kusto]', e); }
					try { clickFidelityGuard.dispose(); } catch (e) { console.error('[kusto]', e); }
					try { if (pageScrollRelayoutFrame) cancelAnimationFrame(pageScrollRelayoutFrame); } catch (e) { console.error('[kusto]', e); }
					pageScrollRelayoutFrame = 0;
					try { if (disposePageScrollRelayout) disposePageScrollRelayout(); } catch (e) { console.error('[kusto]', e); }
					disposePageScrollRelayout = null;
					if (disposedModelUri) {
						try { delete queryEditorBoxByModelUri[disposedModelUri]; } catch (e) { console.error('[kusto]', e); }
						try { __kustoSchemaTracker.disposeModel(disposedModelUri); } catch (e) { console.error('[kusto]', e); }
						try { delete __kustoMonacoDatabaseInContextByModel[disposedModelUri]; } catch (e) { console.error('[kusto]', e); }
						try { delete __kustoMonacoInitializedByModel[disposedModelUri]; } catch (e) { console.error('[kusto]', e); }
						try { delete __kustoModelClusterMap[disposedModelUri]; } catch (e) { console.error('[kusto]', e); }
						try { __kustoClearAutocompleteTraceForModel(disposedModelUri); } catch (e) { console.error('[kusto]', e); }
						try { __kustoForgetCrossClusterModelLoadedForUri(disposedModelUri); } catch (e) { console.error('[kusto]', e); }
					}
					__kustoClearCrossClusterCheckTimer(boxId);
					try { __kustoRemoveCrossClusterInterestForBox(boxId); } catch (e) { console.error('[kusto]', e); }
					try { delete __kustoLastCrossClusterInteractionAtByBoxId[boxId]; } catch (e) { console.error('[kusto]', e); }
					try { delete __kustoCrossClusterPointerDownByBoxId[boxId]; } catch (e) { console.error('[kusto]', e); }
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
					__kustoAutoSizeEditor(boxId);
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
			setTimeout(() => {
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
Object.defineProperty(window, '__kustoUpdateSchemaForFocusedBox', { get: () => __kustoUpdateSchemaForFocusedBox, configurable: true });
Object.defineProperty(window, '__kustoTriggerRevalidation', { get: () => __kustoTriggerRevalidation, configurable: true });
Object.defineProperty(window, '__kustoGetCrossClusterTrace', { get: () => __kustoGetCrossClusterTrace, configurable: true });
Object.defineProperty(window, '__kustoClearCrossClusterTrace', { get: () => __kustoClearCrossClusterTrace, configurable: true });
Object.defineProperty(window, '__kustoGetStatementBlocksFromModel', { get: () => __kustoGetStatementBlocksFromModel, configurable: true });
Object.defineProperty(window, '__kustoExtractStatementTextAtCursor', { get: () => __kustoExtractStatementTextAtCursor, configurable: true });
