let connections = [];
let queryBoxes = [];
let lastConnectionId = null;
let lastDatabase = null;
let cachedDatabases = {};
let kustoFavorites = [];
let favoritesModeByBoxId = {};
let pendingFavoriteSelectionByBoxId = {};
let queryEditors = {};
let queryEditorResizeObservers = {};
let queryEditorVisibilityObservers = {};
let queryEditorVisibilityMutationObservers = {};
let queryEditorBoxByModelUri = {};
let suggestDebounceTimers = {};
let activeQueryEditorBoxId = null;
let schemaByBoxId = {};
let schemaFetchInFlightByBoxId = {};
let lastSchemaRequestAtByBoxId = {};
let monacoReadyPromise = null;

// In-flight state for long-running toolbar actions.
let qualifyTablesInFlightByBoxId = {};

// Cross-box schema cache (for tools like "fully qualify tables").
// Key: `${connectionId}|${database}`
let schemaByConnDb = {};
// Pending schema requests keyed by request boxId.
let schemaRequestResolversByBoxId = {};

// Pending database list requests keyed by request boxId.
let databasesRequestResolversByBoxId = {};

// Missing cluster connections banner state
let missingClusterDetectTimersByBoxId = {};
let lastQueryTextByBoxId = {};
let missingClusterUrlsByBoxId = {};

// Performance optimization comparison metadata
let optimizationMetadataByBoxId = {}; // { sourceBoxId, comparisonBoxId, originalQuery, optimizedQuery, ... }
let suggestedDatabaseByClusterKeyByBoxId = {};

// The Monaco editor instance that most recently received focus (query/markdown/python).
// Used by global key handlers (e.g. Ctrl/Cmd+V paste) so we don't accidentally
// intercept shortcuts intended for a different editor.
let activeMonacoEditor = null;

let queryExecutionTimers = {};
let runModesByBoxId = {};

// Caret docs (custom tooltip) toggle
let caretDocsEnabled = true;
let caretDocOverlaysByBoxId = {};

// Autocomplete behavior toggle
// When enabled, the editor will attempt to trigger Monaco suggestions as you type.
let autoTriggerAutocompleteEnabled = true;

// Track the currently loaded monaco-kusto schema key to avoid redundant updates
// Format: `${clusterUrl}|${database}` - NO DATA is stored here, just the key
let currentMonacoKustoSchemaKey = null;
