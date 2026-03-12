let connections = [];
try { window.connections = connections; } catch { /* ignore */ }
let queryBoxes = [];
try { window.queryBoxes = queryBoxes; } catch { /* ignore */ }
let lastConnectionId = null;
try { window.lastConnectionId = lastConnectionId; } catch { /* ignore */ }
let lastDatabase = null;
try { window.lastDatabase = lastDatabase; } catch { /* ignore */ }
let cachedDatabases = {};
try { window.cachedDatabases = cachedDatabases; } catch { /* ignore */ }
let kustoFavorites = [];
try { window.kustoFavorites = kustoFavorites; } catch { /* ignore */ }
let leaveNoTraceClusters = [];
try { window.leaveNoTraceClusters = leaveNoTraceClusters; } catch { /* ignore */ }
let favoritesModeByBoxId = {};
try { window.favoritesModeByBoxId = favoritesModeByBoxId; } catch { /* ignore */ }
let pendingFavoriteSelectionByBoxId = {};
try { window.pendingFavoriteSelectionByBoxId = pendingFavoriteSelectionByBoxId; } catch { /* ignore */ }
let queryEditors = {};
// Expose queryEditors on window so the Lit component (runs in module scope) can access it.
try { window.queryEditors = queryEditors; } catch { /* ignore */ }
let queryEditorResizeObservers = {};
try { window.queryEditorResizeObservers = queryEditorResizeObservers; } catch { /* ignore */ }
let queryEditorVisibilityObservers = {};
try { window.queryEditorVisibilityObservers = queryEditorVisibilityObservers; } catch { /* ignore */ }
let queryEditorVisibilityMutationObservers = {};
try { window.queryEditorVisibilityMutationObservers = queryEditorVisibilityMutationObservers; } catch { /* ignore */ }
let queryEditorBoxByModelUri = {};
let suggestDebounceTimers = {};
let activeQueryEditorBoxId = null;
try { window.activeQueryEditorBoxId = activeQueryEditorBoxId; } catch { /* ignore */ }
let schemaByBoxId = {};
try { window.schemaByBoxId = schemaByBoxId; } catch { /* ignore */ }
let schemaFetchInFlightByBoxId = {};
try { window.schemaFetchInFlightByBoxId = schemaFetchInFlightByBoxId; } catch { /* ignore */ }
let lastSchemaRequestAtByBoxId = {};
try { window.lastSchemaRequestAtByBoxId = lastSchemaRequestAtByBoxId; } catch { /* ignore */ }
let monacoReadyPromise = null;

// In-flight state for long-running toolbar actions.
let qualifyTablesInFlightByBoxId = {};
try { window.qualifyTablesInFlightByBoxId = qualifyTablesInFlightByBoxId; } catch { /* ignore */ }

// Cross-box schema cache (for tools like "fully qualify tables").
// Key: `${connectionId}|${database}`
let schemaByConnDb = {};
try { window.schemaByConnDb = schemaByConnDb; } catch { /* ignore */ }
// Pending schema requests keyed by request boxId.
let schemaRequestResolversByBoxId = {};
try { window.schemaRequestResolversByBoxId = schemaRequestResolversByBoxId; } catch { /* ignore */ }

// Pending database list requests keyed by request boxId.
let databasesRequestResolversByBoxId = {};
try { window.databasesRequestResolversByBoxId = databasesRequestResolversByBoxId; } catch { /* ignore */ }

// Missing cluster connections banner state
let missingClusterDetectTimersByBoxId = {};
try { window.missingClusterDetectTimersByBoxId = missingClusterDetectTimersByBoxId; } catch { /* ignore */ }
let lastQueryTextByBoxId = {};
try { window.lastQueryTextByBoxId = lastQueryTextByBoxId; } catch { /* ignore */ }
let missingClusterUrlsByBoxId = {};
try { window.missingClusterUrlsByBoxId = missingClusterUrlsByBoxId; } catch { /* ignore */ }

// Performance optimization comparison metadata
let optimizationMetadataByBoxId = {}; // { sourceBoxId, comparisonBoxId, originalQuery, optimizedQuery, ... }
try { window.optimizationMetadataByBoxId = optimizationMetadataByBoxId; } catch { /* ignore */ }
let suggestedDatabaseByClusterKeyByBoxId = {};
try { window.suggestedDatabaseByClusterKeyByBoxId = suggestedDatabaseByClusterKeyByBoxId; } catch { /* ignore */ }

// The Monaco editor instance that most recently received focus (query/markdown/python).
// Used by global key handlers (e.g. Ctrl/Cmd+V paste) so we don't accidentally
// intercept shortcuts intended for a different editor.
let activeMonacoEditor = null;
try { window.activeMonacoEditor = activeMonacoEditor; } catch { /* ignore */ }

let queryExecutionTimers = {};
try { window.queryExecutionTimers = queryExecutionTimers; } catch { /* ignore */ }
let runModesByBoxId = {};
try { window.runModesByBoxId = runModesByBoxId; } catch { /* ignore */ }

// Caret docs (custom tooltip) toggle
let caretDocsEnabled = true;
try { window.caretDocsEnabled = caretDocsEnabled; } catch { /* ignore */ }
let caretDocOverlaysByBoxId = {};
try { window.caretDocOverlaysByBoxId = caretDocOverlaysByBoxId; } catch { /* ignore */ }

// Autocomplete behavior toggle
// When enabled, the editor will attempt to trigger Monaco suggestions as you type.
let autoTriggerAutocompleteEnabled = true;
try { window.autoTriggerAutocompleteEnabled = autoTriggerAutocompleteEnabled; } catch { /* ignore */ }

// Automatically trigger Copilot inline completions toggle
// When enabled, the editor will request inline completions from GitHub Copilot.
let copilotInlineCompletionsEnabled = true;
try { window.copilotInlineCompletionsEnabled = copilotInlineCompletionsEnabled; } catch { /* ignore */ }

// Pending Copilot inline completion requests
let copilotInlineCompletionRequests = {};
try { window.copilotInlineCompletionRequests = copilotInlineCompletionRequests; } catch { /* ignore */ }

// Track the currently loaded monaco-kusto schema key to avoid redundant updates
// Format: `${clusterUrl}|${database}` - NO DATA is stored here, just the key
let currentMonacoKustoSchemaKey = null;
