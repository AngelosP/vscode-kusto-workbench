let connections = [];
let queryBoxes = [];
let lastConnectionId = null;
let lastDatabase = null;
let cachedDatabases = {};
let queryEditors = {};
let queryEditorResizeObservers = {};
let queryEditorBoxByModelUri = {};
let suggestDebounceTimers = {};
let activeQueryEditorBoxId = null;
let schemaByBoxId = {};
let schemaFetchInFlightByBoxId = {};
let lastSchemaRequestAtByBoxId = {};
let monacoReadyPromise = null;

let queryExecutionTimers = {};
let runModesByBoxId = {};

// Caret docs (custom tooltip) toggle
let caretDocsEnabled = true;
let caretDocOverlaysByBoxId = {};
