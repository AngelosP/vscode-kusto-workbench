// State module — central webview state.
// All state variables are exported for direct ES module import within the
// esbuild-bundled IIFE.  Window assignments are kept alongside exports so
// that Monaco AMD code, the browser-ext, and queryEditor.js bootstrap can
// still read/write via window.*.

const _win = window;

// ---------------------------------------------------------------------------
// Reference-type state (mutated in-place — safe to export directly)
// ---------------------------------------------------------------------------
export const cachedDatabases: Record<string, any> = {};
export const favoritesModeByBoxId: Record<string, any> = {};
export const pendingFavoriteSelectionByBoxId: Record<string, any> = {};
export const queryEditors: Record<string, any> = {};
export const queryEditorResizeObservers: Record<string, any> = {};
export const queryEditorVisibilityObservers: Record<string, any> = {};
export const queryEditorVisibilityMutationObservers: Record<string, any> = {};
export const queryEditorBoxByModelUri: Record<string, any> = {};
export const schemaByBoxId: Record<string, any> = {};
export const schemaFetchInFlightByBoxId: Record<string, any> = {};
export const lastSchemaRequestAtByBoxId: Record<string, any> = {};
export const qualifyTablesInFlightByBoxId: Record<string, any> = {};
export const schemaByConnDb: Record<string, any> = {};
export const schemaRequestResolversByBoxId: Record<string, any> = {};
export const databasesRequestResolversByBoxId: Record<string, any> = {};
export const missingClusterDetectTimersByBoxId: Record<string, any> = {};
export const lastQueryTextByBoxId: Record<string, any> = {};
export const missingClusterUrlsByBoxId: Record<string, any> = {};
export const optimizationMetadataByBoxId: Record<string, any> = {};
export const suggestedDatabaseByClusterKeyByBoxId: Record<string, any> = {};
export const queryExecutionTimers: Record<string, any> = {};
export const runModesByBoxId: Record<string, any> = {};
export const caretDocOverlaysByBoxId: Record<string, any> = {};
export const copilotInlineCompletionRequests: Record<string, any> = {};
export const sqlConnections: any[] = [];
export const sqlCachedDatabases: Record<string, any> = {};
export const sqlFavoritesModeByBoxId: Record<string, any> = {};

// ---------------------------------------------------------------------------
// Primitive / reassigned state (need setter functions for cross-module writes)
// ---------------------------------------------------------------------------
export let connections: any[] = [];
export let queryBoxes: any[] = [];
export let lastConnectionId: string | null = null;
export let lastDatabase: string | null = null;
export let kustoFavorites: any[] = [];
export let sqlFavorites: any[] = [];
export let leaveNoTraceClusters: string[] = [];
export let activeQueryEditorBoxId: string | null = null;
export let monacoReadyPromise: Promise<void> | null = null;
export let activeMonacoEditor: any = null;
export let caretDocsEnabled = true;
export let autoTriggerAutocompleteEnabled = true;
export let copilotInlineCompletionsEnabled = true;

// Setter functions — update the module-local variable AND window.
export function setConnections(val: any[]) { connections = val; try { _win.connections = val; } catch (e) { console.error('[kusto]', e); } }
export function setQueryBoxes(val: any[]) { queryBoxes = val; try { _win.queryBoxes = val; } catch (e) { console.error('[kusto]', e); } }
export function setLastConnectionId(val: string | null) { lastConnectionId = val; try { _win.lastConnectionId = val; } catch (e) { console.error('[kusto]', e); } }
export function setLastDatabase(val: string | null) { lastDatabase = val; try { _win.lastDatabase = val; } catch (e) { console.error('[kusto]', e); } }
export function setKustoFavorites(val: any[]) { kustoFavorites = val; try { _win.kustoFavorites = val; } catch (e) { console.error('[kusto]', e); } }
export function setSqlFavorites(val: any[]) { sqlFavorites = val; try { _win.sqlFavorites = val; } catch (e) { console.error('[kusto]', e); } }
export function setLeaveNoTraceClusters(val: string[]) { leaveNoTraceClusters = val; try { _win.leaveNoTraceClusters = val; } catch (e) { console.error('[kusto]', e); } }
export function setActiveQueryEditorBoxId(val: string | null) { activeQueryEditorBoxId = val; try { _win.activeQueryEditorBoxId = val; } catch (e) { console.error('[kusto]', e); } }
export function setMonacoReadyPromise(val: Promise<void> | null) { monacoReadyPromise = val; try { _win.monacoReadyPromise = val; } catch (e) { console.error('[kusto]', e); } }
export function setActiveMonacoEditor(val: any) { activeMonacoEditor = val; try { _win.activeMonacoEditor = val; } catch (e) { console.error('[kusto]', e); } }
export function setCaretDocsEnabled(val: boolean) { caretDocsEnabled = val; try { _win.caretDocsEnabled = val; } catch (e) { console.error('[kusto]', e); } }
export function setAutoTriggerAutocompleteEnabled(val: boolean) { autoTriggerAutocompleteEnabled = val; try { _win.autoTriggerAutocompleteEnabled = val; } catch (e) { console.error('[kusto]', e); } }
export function setCopilotInlineCompletionsEnabled(val: boolean) { copilotInlineCompletionsEnabled = val; try { _win.copilotInlineCompletionsEnabled = val; } catch (e) { console.error('[kusto]', e); } }
export function setSqlConnections(val: any[]) { sqlConnections.length = 0; sqlConnections.push(...val); try { _win.sqlConnections = sqlConnections; } catch (e) { console.error('[kusto]', e); } }

// ======================================================================
// Window bridge: expose all state globals for remaining legacy callers
// (Monaco AMD, browser-ext, queryEditor.js bootstrap, Lit components
//  that still read via window.*)
// ======================================================================
_win.connections = connections;
_win.queryBoxes = queryBoxes;
_win.lastConnectionId = lastConnectionId;
_win.lastDatabase = lastDatabase;
_win.cachedDatabases = cachedDatabases;
_win.kustoFavorites = kustoFavorites;
_win.leaveNoTraceClusters = leaveNoTraceClusters;
_win.favoritesModeByBoxId = favoritesModeByBoxId;
_win.pendingFavoriteSelectionByBoxId = pendingFavoriteSelectionByBoxId;
_win.queryEditors = queryEditors;
_win.queryEditorResizeObservers = queryEditorResizeObservers;
_win.queryEditorVisibilityObservers = queryEditorVisibilityObservers;
_win.queryEditorVisibilityMutationObservers = queryEditorVisibilityMutationObservers;
_win.queryEditorBoxByModelUri = queryEditorBoxByModelUri;
_win.activeQueryEditorBoxId = activeQueryEditorBoxId;
_win.schemaByBoxId = schemaByBoxId;
_win.schemaFetchInFlightByBoxId = schemaFetchInFlightByBoxId;
_win.lastSchemaRequestAtByBoxId = lastSchemaRequestAtByBoxId;
_win.monacoReadyPromise = monacoReadyPromise;
_win.qualifyTablesInFlightByBoxId = qualifyTablesInFlightByBoxId;
_win.schemaByConnDb = schemaByConnDb;
_win.schemaRequestResolversByBoxId = schemaRequestResolversByBoxId;
_win.databasesRequestResolversByBoxId = databasesRequestResolversByBoxId;
_win.missingClusterDetectTimersByBoxId = missingClusterDetectTimersByBoxId;
_win.lastQueryTextByBoxId = lastQueryTextByBoxId;
_win.missingClusterUrlsByBoxId = missingClusterUrlsByBoxId;
_win.optimizationMetadataByBoxId = optimizationMetadataByBoxId;
_win.suggestedDatabaseByClusterKeyByBoxId = suggestedDatabaseByClusterKeyByBoxId;
_win.activeMonacoEditor = activeMonacoEditor;
_win.queryExecutionTimers = queryExecutionTimers;
_win.runModesByBoxId = runModesByBoxId;
_win.caretDocsEnabled = caretDocsEnabled;
_win.caretDocOverlaysByBoxId = caretDocOverlaysByBoxId;
_win.autoTriggerAutocompleteEnabled = autoTriggerAutocompleteEnabled;
_win.copilotInlineCompletionsEnabled = copilotInlineCompletionsEnabled;
_win.copilotInlineCompletionRequests = copilotInlineCompletionRequests;
_win.sqlConnections = sqlConnections;
_win.sqlCachedDatabases = sqlCachedDatabases;
_win.sqlFavorites = sqlFavorites;
_win.sqlFavoritesModeByBoxId = sqlFavoritesModeByBoxId;

// Expose setter functions on window so Lit components (same IIFE) can call them
// without creating import dependencies. Only setters that are actually needed
// by Lit components are exposed.
(_win as any).setQueryBoxes = setQueryBoxes;
