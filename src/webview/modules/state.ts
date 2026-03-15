// State module — converted from legacy/state.js
// All global state variables exposed on window for remaining legacy callers.
export {};

const _win = window;

const connections: any[] = [];
try { _win.connections = connections; } catch { /* ignore */ }
const queryBoxes: any[] = [];
let lastConnectionId: string | null = null;
let lastDatabase: string | null = null;
const cachedDatabases: Record<string, any> = {};
let kustoFavorites: any[] = [];
let leaveNoTraceClusters: string[] = [];
const favoritesModeByBoxId: Record<string, any> = {};
try { _win.favoritesModeByBoxId = favoritesModeByBoxId; } catch { /* ignore */ }
const pendingFavoriteSelectionByBoxId: Record<string, any> = {};
const queryEditors: Record<string, any> = {};
// Expose queryEditors on window so the Lit component (runs in module scope) can access it.
try { _win.queryEditors = queryEditors; } catch { /* ignore */ }
const queryEditorResizeObservers: Record<string, any> = {};
const queryEditorVisibilityObservers: Record<string, any> = {};
const queryEditorVisibilityMutationObservers: Record<string, any> = {};
const queryEditorBoxByModelUri: Record<string, any> = {};
const suggestDebounceTimers: Record<string, any> = {};
let activeQueryEditorBoxId: string | null = null;
const schemaByBoxId: Record<string, any> = {};
const schemaFetchInFlightByBoxId: Record<string, any> = {};
const lastSchemaRequestAtByBoxId: Record<string, any> = {};
let monacoReadyPromise: Promise<void> | null = null;

// In-flight state for long-running toolbar actions.
const qualifyTablesInFlightByBoxId: Record<string, any> = {};

// Cross-box schema cache (for tools like "fully qualify tables").
// Key: `${connectionId}|${database}`
const schemaByConnDb: Record<string, any> = {};
// Pending schema requests keyed by request boxId.
const schemaRequestResolversByBoxId: Record<string, any> = {};

// Pending database list requests keyed by request boxId.
const databasesRequestResolversByBoxId: Record<string, any> = {};

// Missing cluster connections banner state
const missingClusterDetectTimersByBoxId: Record<string, any> = {};
const lastQueryTextByBoxId: Record<string, any> = {};
const missingClusterUrlsByBoxId: Record<string, any> = {};

// Performance optimization comparison metadata
const optimizationMetadataByBoxId: Record<string, any> = {};
const suggestedDatabaseByClusterKeyByBoxId: Record<string, any> = {};

// The Monaco editor instance that most recently received focus (query/markdown/python).
let activeMonacoEditor: any = null;

const queryExecutionTimers: Record<string, any> = {};
const runModesByBoxId: Record<string, any> = {};
try { _win.runModesByBoxId = runModesByBoxId; } catch { /* ignore */ }

// Caret docs (custom tooltip) toggle
let caretDocsEnabled = true;
const caretDocOverlaysByBoxId: Record<string, any> = {};

// Autocomplete behavior toggle
let autoTriggerAutocompleteEnabled = true;

// Automatically trigger Copilot inline completions toggle
let copilotInlineCompletionsEnabled = true;

// Pending Copilot inline completion requests
const copilotInlineCompletionRequests: Record<string, any> = {};

// Track the currently loaded monaco-kusto schema key to avoid redundant updates
let currentMonacoKustoSchemaKey: string | null = null;

// ======================================================================
// Window bridge: expose all state globals for remaining legacy callers
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
_win.suggestDebounceTimers = suggestDebounceTimers;
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
_win.currentMonacoKustoSchemaKey = currentMonacoKustoSchemaKey;
